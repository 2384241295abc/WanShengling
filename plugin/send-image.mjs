/**
 * send-image.mjs —— 万生玲主动发图（表情包）能力
 *
 * 机制：模型在回复文本中写标记 `[发图:关键字]`，发送前解析该标记，
 *       从本地表情包库（assetDir）匹配图片，替换为图片消息发出。
 * 目的：像真人聊着聊着甩个表情包/图，而不是只发文字。
 *
 * 用法：
 *   createSendImage({ assetDir, log })
 *     → assetDir()                 表情包库目录（不存在则提示创建）
 *     → listAssets()               库内可用图片文件名列表
 *     → resolveAsset(keyword)      按关键字匹配图片路径（文件名/去扩展名包含匹配）
 *     → parseImageMark(text)       { keyword, text } | null —— 解析 [发图:xxx] 标记
 *
 * ⚠️ 参数来源：config（DEFAULTS.sendImage，补丁可覆盖 → 热更新）。
 */

'use strict'

import { readdir } from 'node:fs/promises'
import { join, extname } from 'node:path'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/** 解析 [发图:关键字] 标记（全角/半角均可）：返回 { keyword, text }；无标记返回 null。
 *  text = 标记前的文本（标记后的内容由图片替代，语义等价于"图=后半句"）。 */
export function parseImageMark(text) {
  if (!text) return null
  const m = /\[发图[:：]\s*([^\]]+?)\s*\]/.exec(text)
  if (!m) return null
  const keyword = m[1].trim()
  const rest = text.slice(0, m.index).trim()
  return { keyword, text: rest }
}

export function createSendImage({ assetDir = '', log = () => {} } = {}) {
  /** 表情包库目录 */
  const dir = assetDir

  /** 库内可用图片文件名（.png/.jpg/.jpeg/.webp/.gif） */
  async function listAssets() {
    try {
      const names = await readdir(dir)
      return names.filter((n) => IMAGE_EXTS.has(extname(n).toLowerCase()))
    } catch {
      return []
    }
  }

  /**
   * 按关键字匹配图片：精确匹配文件名 → 去扩展名包含匹配 → 返回完整路径。
   * 匹配不到返回 null（调用方回退为纯文本，不发图）。
   */
  async function resolveAsset(keyword) {
    if (!keyword || !dir) return null
    const kw = keyword.toLowerCase()
    const assets = await listAssets()
    if (!assets.length) return null
    // 1) 精确：文件名（含扩展名）
    let hit = assets.find((n) => n.toLowerCase() === kw)
    // 2) 精确：去扩展名
    if (!hit) hit = assets.find((n) => n.toLowerCase().replace(/\.[a-z0-9]+$/i, '') === kw)
    // 3) 包含（去扩展名）
    if (!hit) hit = assets.find((n) => n.toLowerCase().replace(/\.[a-z0-9]+$/i, '').includes(kw))
    return hit ? join(dir, hit) : null
  }

  return {
    assetDir: () => dir,
    listAssets,
    resolveAsset,
  }
}
