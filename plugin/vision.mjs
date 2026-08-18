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

import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'

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
  try {
    await mkdir(dir, { recursive: true })
    let path = seg.data?.path
    const file = seg.data?.file
    if (!path && file) {
      const res = await request('get_image', { file })
      path = res?.path
    }
    let buf
    let ext = '.jpg'
    if (path) {
      const st = await stat(path).catch(() => null)
      if (!st || st.size <= 0 || st.size > MAX_IMAGE_BYTES) return null
      buf = await readFile(path)
      ext = extname(path)
    } else {
      const url = seg.data?.url
      if (!url) return null
      const r = await fetch(url)
      if (!r.ok) return null
      buf = Buffer.from(await r.arrayBuffer())
      if (buf.length > MAX_IMAGE_BYTES) return null
      ext = extname(url)
    }
    const name = `qqimg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext || '.jpg'}`
    const dest = join(dir, name)
    await writeFile(dest, buf)
    return { path: dest, mediaType: mediaTypeFromPath(dest) }
  } catch {
    return null
  }
}
