/**
 * features/forward.mjs —— 转发聊天记录读取（🔒 预留接口，2026-08-30）
 *
 * 能力（规划）：群友转发来的聊天记录（forward 段）→ 下载解析 → 转文本 →
 * 写入 chatlog / 注入 prompt，让万生玲能阅读并回应"转发来的聊天"。
 *
 * 接入方式（与现有模块隔离）：
 *   本文件是骨架，已挂载到 registry；onMessage 检测到 forward 段但**暂不处理**
 *   （保持现状：无文字无图的转发消息被忽略）。后续实现只需填 onMessage 内部：
 *
 *   1. const fwd = extractByType(ctx.msg.message, 'forward')        // segments.mjs
 *   2. const msgs = await downloadForwardMessage(bot.request, fwd[0]?.data?.resid)
 *   3. const text = forwardToText(msgs, OneBotClient.extractText)   // segments.mjs
 *   4. ctx.text = `（转发聊天记录：\n${text}\n）` → return false     // 走回复流程，模型接话
 *      （可选）写入该群 chatlog.md（appendChat + chatLine），让文件记忆也有记录
 *
 * 依赖（deps）：{ bot, groups, config, log }（按需扩展，避免传入多余 manager）
 */

'use strict'

import { extractByType, downloadForwardMessage, forwardToText } from '../segments.mjs'

export function createForwardFeature(deps) {
  const { bot, groups, config, log } = deps

  return {
    name: 'forward',

    /** 检测转发段；🔒 预留：实现见文件头注释，当前不处理不拦截（保持现状） */
    async onMessage(ctx) {
      const fwd = extractByType(ctx.msg?.message, 'forward')
      if (!fwd.length) return false
      log('info', '[qq-bridge][forward] 收到转发消息（预留能力，暂不解析）')
      return false
    },
  }
}
