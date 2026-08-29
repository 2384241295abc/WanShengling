/**
 * segments.mjs —— OneBot 消息段解析工具（模块化，2026-08-30）
 *
 * 职责：
 *   - 通用段提取：extractByType(message, type)
 *   - 转发记录（forward）解析：下载 get_forward_msg → 转文本
 *   - 视频（video）解析：下载视频文件 + 提取音频/关键帧（🔒 ffmpeg 接口预留）
 *   - 语音（record）等其他段类型：后续在 features/ 下做独立插件接入
 *
 * 设计目标（与宿主隔离）：
 *   - 本文件只提供无状态工具函数（提取/下载/转换），不持有状态、不依赖 manager；
 *   - 新段类型的能力以 feature 插件（features/xxx.mjs）挂到 registry，不改 index.mjs 主流程；
 *   - 下载/提取实现可按需填，接口签名已固定（见下方各函数 JSDoc）。
 *
 * ⚠️ 转发/视频下载依赖 OneBot 能力（get_forward_msg / 段内 url），NapCat 均支持；
 *    ffmpeg 提取为预留接口（当前返回 null，不影响主流程）。
 */

'use strict'

import { stat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'

/** 从消息段数组提取指定类型的段（image/forward/video/record/face...） */
export function extractByType(message, type) {
  if (!Array.isArray(message)) return []
  return message.filter((s) => s && s.type === type)
}

/** 从消息段数组提取所有"媒体/内容"段（image/forward/video/record），供 features 遍历 */
export function extractMediaSegments(message) {
  if (!Array.isArray(message)) return []
  return message.filter((s) => s && ['image', 'forward', 'video', 'record'].includes(s.type))
}

/**
 * 下载并解析一条转发消息（OneBot get_forward_msg）。
 * @param {Function} request  OneBot 请求函数（bot.request）
 * @param {string|number} resid 转发段 data.resid（或 file）
 * @returns {Promise<Array<{user_id:number, nickname:string, message:Array}>>} 转发内消息列表；失败/空返回 []
 */
export async function downloadForwardMessage(request, resid) {
  try {
    if (!resid) return []
    const data = await request('get_forward_msg', { message_id: resid })
    const messages = Array.isArray(data?.messages) ? data.messages : []
    return messages.map((m) => ({
      user_id: m.user_id ?? 0,
      nickname: m.sender?.nickname ?? m.nickname ?? `用户${m.user_id ?? '?'}`,
      message: m.message ?? [],
    }))
  } catch {
    return []
  }
}

/** 把转发消息列表转成可读文本（供模型阅读/写入 chatlog）；空内容行跳过 */
export function forwardToText(messages, extractText) {
  return messages
    .map((m) => {
      const t = extractText ? extractText(m.message) : ''
      return t ? `${m.nickname}: ${t}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * 下载一条视频段到 dir，返回 { path, mediaType }；失败/超限返回 null。
 * @param {object} seg      OneBot video 段 { type:'video', data:{file,path,url} }
 * @param {string} dir      保存目录
 * @param {Function} request OneBot 请求函数（get_video 可解析本地路径，NapCat 支持）
 * @param {number} maxBytes 大小上限（默认 200MB）
 */
export async function downloadVideo(seg, dir, request, maxBytes = 200 * 1024 * 1024) {
  const data = seg?.data || {}
  try {
    await mkdir(dir, { recursive: true })
    let path = data.path
    const file = data.file
    if (!path && file) {
      try {
        const res = await request('get_video', { file })
        path = res?.file ?? res?.path ?? res?.url ?? ''
      } catch { /* 拿不到就继续走 url */ }
    }
    let buf = null
    if (path) {
      const st = await stat(path).catch(() => null)
      if (st && st.size > 0 && st.size <= maxBytes) {
        buf = await readFile(path)
      }
    }
    if (!buf && data.url) {
      let r = await fetch(data.url, { headers: { Referer: 'https://qun.qq.com/' } }).catch(() => null)
      if (!r || !r.ok) r = await fetch(data.url).catch(() => null)
      if (r && r.ok) {
        buf = Buffer.from(await r.arrayBuffer())
        if (buf.length > maxBytes) buf = null
      }
    }
    if (!buf) return null
    const name = `qqvideo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extname(path || data.url || '.mp4') || '.mp4'}`
    const dest = join(dir, name)
    await writeFile(dest, buf)
    return { path: dest, mediaType: `video/${extname(dest).slice(1) || 'mp4'}` }
  } catch {
    return null
  }
}

/**
 * 🔒 预留接口：从视频提取音频（ffmpeg 转 mp3/wav）。
 * 后续实现：spawn ffmpeg -i <video> -vn -acodec libmp3lame <out>；返回音频路径。
 * 当前返回 null（未实现），调用方跳过该能力。
 */
export async function extractAudio(/* videoPath, outDir */) {
  return null
}

/**
 * 🔒 预留接口：从视频抽关键帧（ffmpeg -ss <t> -i <video> -frames:v 1 <out.jpg>）。
 * 后续实现：抽 1~3 帧存到 outDir，返回帧路径数组（供视觉模型看图）。
 * 当前返回 []（未实现），调用方跳过该能力。
 */
export async function extractVideoFrames(/* videoPath, outDir */) {
  return []
}

/** 语音段（record）解析：🔒 预留——下载 + 语音转文字（ASR）接口；当前返回 null */
export async function transcribeRecord(/* seg, dir, request */) {
  return null
}
