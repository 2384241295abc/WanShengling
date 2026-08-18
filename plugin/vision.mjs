/**
 * vision.mjs —— 图片处理（配合 DSH 视觉插件 modlens/free-vision）
 *
 * 职责：
 *   - 从 OneBot 消息提取 image 段
 *   - 将 QQ 图片保存到会话工作目录，返回本地路径（供 agent 用视觉工具查看）
 *   - mediaType 按扩展名识别
 *
 * 注意：deepseek 为纯文本模型，不能直接接收图片内容块；
 * 图片以「保存路径 + 文本提示」方式交给模型，由模型调用视觉工具(modlens/free-vision)分析。
 */

'use strict'

import { readFile, stat, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { join, extname } from 'node:path'

/** 调试日志文件（index.mjs 可 setVisionDebugFile 指定；空=关闭） */
let debugFile = ''

export function setVisionDebugFile(p) { debugFile = p }

async function debug(...args) {
  if (!debugFile) return
  try { await appendFile(debugFile, `[${new Date().toISOString()}] ${args.join(' ')}\n`) } catch {}
}

const EXT_MEDIA = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 单图大小上限（与宿主 imageLimits.maxImageBytes 对齐） */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** 从 OneBot 消息(段数组)提取 image 段 */
export function extractImages(message) {
  return Array.isArray(message) ? message.filter((s) => s?.type === 'image') : []
}

/** 按路径/URL 扩展名推断 mediaType；未知回退 jpeg */
export function mediaTypeFromPath(p) {
  return EXT_MEDIA[(extname(p || '').toLowerCase())] || 'image/jpeg'
}

/**
 * 保存一张 QQ 图片到 dir，返回 { path, mediaType }；失败/超限返回 null。
 * 取图三路：段内本地 path → OneBot get_image → 段内 url 下载。
 * @param {object} seg       OneBot image 段 { type:'image', data:{file,path,url} }
 * @param {string} dir       保存目录（会话工作目录）
 * @param {Function} request OneBot 请求函数（用于 get_image），如 bot.request
 */
export async function saveImage(seg, dir, request) {
  const data = seg?.data || {}
  await debug('saveImage 段 data:', JSON.stringify(data).slice(0, 300))
  try {
    await mkdir(dir, { recursive: true })
    let path = data.path
    const file = data.file
    if (!path && file) {
      try {
        const res = await request('get_image', { file })
        // NapCat get_image 响应的本地路径在 file 字段（如 /…/emoji-recv/xxx.jpg），path 常缺省
        path = res?.file ?? res?.path
        await debug('get_image ok:', JSON.stringify(res || {}).slice(0, 300))
      } catch (e) {
        await debug('get_image 失败:', e.message)
      }
    }
    let buf
    let ext = '.jpg'
    if (path) {
      const st = await stat(path).catch(() => null)
      if (!st || st.size <= 0 || st.size > MAX_IMAGE_BYTES) {
        await debug(`本地 path 不可用: ${path} (size=${st?.size})`)
        return null
      }
      buf = await readFile(path)
      ext = extname(path)
      await debug(`本地读取 ok: ${path} (${buf.length}B)`)
    } else {
      const url = data.url
      if (!url) { await debug('无 url 且无 path，放弃'); return null }
      // QQ CDN 常要求 Referer，先带 Referer 试，失败再裸拉
      let r
      try { r = await fetch(url, { headers: { Referer: 'https://qun.qq.com/' } }) } catch { r = null }
      if (!r || !r.ok) {
        try { r = await fetch(url) } catch (e) { await debug('url 下载失败:', e.message); return null }
      }
      if (!r.ok) { await debug(`url 下载状态 ${r.status}`); return null }
      buf = Buffer.from(await r.arrayBuffer())
      if (buf.length > MAX_IMAGE_BYTES) { await debug(`图片超限 ${buf.length}B`); return null }
      ext = extname(url)
      await debug(`url 下载 ok (${buf.length}B)`)
    }
    const name = `qqimg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext || '.jpg'}`
    const dest = join(dir, name)
    await writeFile(dest, buf)
    await debug(`已保存: ${dest}`)
    return { path: dest, mediaType: mediaTypeFromPath(dest) }
  } catch (e) {
    await debug('saveImage 异常:', e.message)
    return null
  }
}
