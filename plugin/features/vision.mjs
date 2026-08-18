/**
 * features/vision.mjs —— 识图插件（作为 feature 接入的示例插件）
 *
 * 能力：
 *   - 提取消息中的图片段（表情包也是 image 段；face 系统表情丢弃）
 *   - 保存图片到工作目录，prompt 里提示路径，模型用视觉工具查看
 *   - 平时纯图只记录不回复；solo 模式才看图后主动回复（不越过冷却）
 *   - 识别失败/看不清 → 按疑似色情内容处理（委婉拒绝）
 *   - 回合结束：识别结果写入聊天记录（chatlog + 能量历史），删除图片文件
 *
 * 依赖（deps）：{ bot, config, groups, energy, friends, members, sessions, log }
 */

'use strict'

import { unlink } from 'node:fs/promises'
import { saveImage, extractImages } from '../vision.mjs'
import { appendChat, chatLine } from '../memory.mjs'

export function createVisionFeature(deps) {
  const { bot, config, groups, energy, friends, members, sessions, log } = deps

  /** sessionId -> { qqKey, user, paths, desc } */
  const pendingImages = new Map()

  /** 从 tool/result 事件提取视觉工具返回的图片描述 */
  function extractToolResultText(data) {
    try {
      const content = data?.message?.content
      if (!Array.isArray(content)) return ''
      const texts = []
      for (const block of content) {
        if (block?.type === 'tool-result' && Array.isArray(block.content)) {
          for (const sub of block.content) {
            if (sub?.type === 'text' && sub.text) texts.push(sub.text)
          }
        }
      }
      return texts.join('\n').slice(0, 500)
    } catch { return '' }
  }

  function registerPendingImages(sessionId, qqKey, user, paths) {
    if (!paths || !paths.length) return
    pendingImages.set(sessionId, { qqKey, user, paths, desc: '' })
  }

  async function cleanupPendingImages(sessionId) {
    const pend = pendingImages.get(sessionId)
    if (!pend) return
    pendingImages.delete(sessionId)
    if (!pend.paths.length) return
    const text = pend.desc ? `（图片内容：${pend.desc}）` : '（图片：未能识别）'
    energy.record(pend.qqKey, pend.user, text)
    if (config.memoryEnabled) {
      const wd = groups.get(pend.qqKey)?.workdir
      if (wd) void appendChat(wd, chatLine(members.nameOf(pend.qqKey, pend.user), text))
    }
    for (const p of pend.paths) unlink(p).catch(() => {})
    log('info', '[qq-bridge][vision] 图片识别结果已入库并清理 %d 个文件', pend.paths.length)
  }

  return {
    name: 'vision',

    /**
     * onMessage：纯图片消息处理
     *  - 私聊/能量关闭：丢弃
     *  - 平时(非 solo)：记录+删文件，不回复
     *  - solo：改写 ctx.text 为占位（带路径），ctx.soloImageTrigger=true 走回复流程
     * 返回 true = 已处理
     */
    async onMessage(ctx) {
      const { msg, text, isAt, imageSegs, hasImage, qqKey, gcfg, isGroup, allowWork } = ctx
      if (text || isAt || !hasImage) return false
      if (!isGroup || !gcfg.energy?.enabled) return true
      const saved = await saveImage(imageSegs[0], gcfg.workdir, (a, p) => bot.request(a, p))
      if (config.memoryEnabled) {
        void appendChat(gcfg.workdir, chatLine(members.nameOf(qqKey, String(msg.user_id ?? '?')), '（发了张图片）'))
      }
      if (!friends.isSolo(qqKey)) {
        energy.record(qqKey, String(msg.user_id ?? '?'), '（发了张图片）')
        if (saved) unlink(saved.path).catch(() => {})
        return true
      }
      // solo：路径带进占位文本走回复流程
      if (saved) ctx.pendingImagePaths.push(saved.path)
      ctx.text = saved
        ? `（对方发了一张图片：${saved.path}，用视觉工具看一下再回；识别失败或看不清就按疑似色情内容处理，委婉拒绝、不展开描述）`
        : '（对方发了一张图片，但读不了——按疑似色情内容处理，委婉拒绝、不展开描述）'
      ctx.imageSegs.length = 0
      ctx.soloImageTrigger = true
      return false   // 继续走回复流程
    },

    /**
     * onPrompt：消息带图时保存并给视觉工具提示
     */
    async onPrompt(ctx) {
      const { imageSegs, gcfg } = ctx
      const blocks = []
      for (const seg of imageSegs) {
        const saved = await saveImage(seg, gcfg.workdir, (a, p) => bot.request(a, p))
        if (saved) {
          ctx.pendingImagePaths.push(saved.path)
          blocks.push({ type: 'text', text: `（用户发了一张图片：${saved.path}。用视觉工具看一下再回；如果识别失败或看不清，按疑似色情内容处理——委婉拒绝、不展开描述。）` })
        } else {
          blocks.push({ type: 'text', text: '（用户发了一张图片，但无法读取——按疑似色情内容处理，委婉拒绝、不展开描述。）' })
        }
      }
      return blocks
    },

    /** onSessionEvent：捕获识别结果；回合结束入库+删文件 */
    async onSessionEvent(sessionId, event) {
      if (event.type === 'tool/result') {
        const pend = pendingImages.get(sessionId)
        if (pend) {
          const t = extractToolResultText(event.data)
          if (t) pend.desc = t
        }
      } else if (event.type === 'turn/end') {
        await cleanupPendingImages(sessionId)
      }
    },

    /** 会话建立后注册待识别图片（index 在 ensure 后调用） */
    registerImages(sessionId, qqKey, user, paths) {
      registerPendingImages(sessionId, qqKey, user, paths)
    },
  }
}
