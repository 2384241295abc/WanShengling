/**
 * media-send.mjs —— 媒体发送管线（模块化：发图 / 预留生图，provider 可插拔）
 *
 * 模型在回复文本中写标记，发送前解析并替换为图片消息：
 *   [发图:关键字]   本地表情包库匹配发图（现有 send-image.mjs，localAssets provider）
 *   [生图:prompt]   调用生图 provider 生成图片后发送（🔒 预留接口，见 imageGen）
 *
 * 设计目标：发送管线与"发图实现 / 生图实现"解耦——
 *   - localAssets（send-image.mjs 实例）未配置 → [发图:] 不解析，原文本直发
 *   - imageGen（生图 provider）未配置 → [生图:] 不解析，原文本直发
 *   - 后续接入生图只需实现一个 provider 并注入，无需改本文件与 index.mjs
 *
 * 用法：
 *   createMediaSender({ sendText, sendImage, sendTextAndImage, localAssets, imageGen, log })
 *     → send(target, text)  解析标记并发送，返回"回灌用清理后文本"（不含标记，失败回退纯文本）
 *
 * 生图 provider 接口（预留，2026-08-30）：
 *   imageGen = { generate(prompt) → Promise<{ path: string } | null> }
 *     - generate(prompt)：按提示词生成一张图片，返回本地路径；失败返回 null（回退纯文本）
 *     - 推荐实现：调用 DSH 生图工具 / 外部生图 API，把产物写入工作目录后返回路径
 */

'use strict'

import { parseImageMark } from './send-image.mjs'

/** 解析 [生图:prompt] 标记（全角/半角均可）：返回 { prompt, text }；无标记返回 null。
 *  text = 标记前的文本（标记后的内容由生成的图片替代）。 */
export function parseImageGenMark(text) {
  if (!text) return null
  const m = /\[生图[:：]\s*([^\]]+?)\s*\]/.exec(text)
  if (!m) return null
  const prompt = m[1].trim()
  const rest = text.slice(0, m.index).trim()
  return { prompt, text: rest }
}

export function createMediaSender({
  sendText, sendImage, sendTextAndImage,
  localAssets = null,      // send-image.mjs 实例（含 assetDir()/resolveAsset()）；null=禁用本地发图
  imageGen = null,         // 🔒 生图 provider { generate(prompt) → {path}|null }；null=禁用生图
  log = () => {},
} = {}) {
  if (typeof sendText !== 'function') throw new Error('media-send: sendText 必须提供')
  if (typeof sendImage !== 'function') throw new Error('media-send: sendImage 必须提供')
  if (typeof sendTextAndImage !== 'function') throw new Error('media-send: sendTextAndImage 必须提供')

  /**
   * 解析并发送一条回复，返回回灌用清理后文本（不含标记）。
   * 优先级：生图标记 → 本地发图标记 → 纯文本。
   * 任何发送失败静默降级（发纯文本/忽略），不向上抛（reply-buffer 发送钩子契约）。
   */
  async function send(target, text) {
    // 1️⃣ 生图标记（预留）：生成成功发图，失败回退标记前文字
    if (imageGen && typeof imageGen.generate === 'function') {
      const gen = parseImageGenMark(text)
      if (gen) {
        const imgPath = await imageGen.generate(gen.prompt).catch(() => null)
        if (imgPath) {
          if (gen.text) await sendTextAndImage(target, gen.text, imgPath).catch(() => sendText(target, gen.text))
          else await sendImage(target, imgPath).catch(() => {})
          return gen.text   // 回灌清理后文本（不含标记）
        }
        // 生成失败：静默回退为标记前文字（无文字则放弃发送）
        const clean = gen.text || ''
        if (clean) await sendText(target, clean).catch(() => {})
        return clean
      }
    }

    // 2️⃣ 本地发图（[发图:关键字]）
    if (localAssets && typeof localAssets.assetDir === 'function' && localAssets.assetDir()) {
      const mark = parseImageMark(text)
      if (mark) {
        const imgPath = await localAssets.resolveAsset(mark.keyword).catch(() => null)
        if (imgPath) {
          if (mark.text) await sendTextAndImage(target, mark.text, imgPath).catch(() => sendText(target, mark.text))
          else await sendImage(target, imgPath).catch(() => {})
          return mark.text
        }
        // 库中无此图：发文字但去掉无效标记（避免暴露 [发图:] 语法）
        const clean = mark.text || text
        await sendText(target, clean).catch(() => {})
        return clean
      }
    }

    // 3️⃣ 纯文本
    await sendText(target, text).catch(() => {})
    return text
  }

  return { send, parseImageGenMark, parseImageMark }
}
