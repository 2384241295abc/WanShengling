/**
 * persona.mjs —— 人设与回复风格管理
 *
 * 集中管理：
 *   - DEFAULT_PERSONA：全局人设（当前为「机器人」），所有群/私聊默认继承
 *   - STYLE_HINTS：各回复风格的一句话提示
 *   - buildPersonaPrompt()：生成注入 prompt 的"人格指令"文本
 *
 * 人工调整：改 DEFAULT_PERSONA 一处即全局生效；某群要不同人设，
 * 在补丁 groups.<群号>.persona 覆盖。
 */

'use strict'

/** 全局默认人设 —— 在这里填写你的机器人人设（身份/性格/说话风格/回复规则等）。
 *  优先级：补丁 config.persona > 这里。默认留空 = 不注入人设，机器人以原始 agent 身份回复。
 *  示例结构：
 *    你叫 XX，...
 *    【性格】...
 *    【说话风格】...
 *    【回复规则】...
 */
export const DEFAULT_PERSONA = ''

/** 各回复风格的一句话提示（空=不注入风格约束；注意与铁律一致） */
const STYLE_HINTS = {
  short: '回复尽量简短，30 字以内。',
  detailed: '回复详细完整，把要点讲清楚。',
  casual: '像日常聊微信，自然随意。',
  emoji: '回复带表情符号，语气活泼。',
  serious: '回复正式、克制，就事论事。',
  default: '',
}

/** 各风格的自然回执文案（用于 ack=true 时） */
const ACK_TEXT = {
  short: '👌',
  casual: '好嘞，等会儿哈',
  emoji: '收到~ 稍等一下下哦 😊',
  serious: '好的，已收到，正在处理。',
  default: '好，我看看',
}

/**
 * 根据人设 + 回复风格生成注入 prompt 的"人格指令"文本。
 * @param {object} cfg  群配置（含 persona / replyStyle）
 * @returns {string} 空串表示无需注入
 */
export function buildPersonaPrompt(cfg) {
  const parts = []
  if (cfg.persona) parts.push(cfg.persona)
  const style = STYLE_HINTS[cfg.replyStyle]
  if (style) parts.push(style)
  if (!parts.length) return ''
  return '【人设设定】' + parts.join(' ') + ' 请始终按此风格回复。'
}

/** 自然回执文案（按风格） */
export function ackText(cfg) {
  return ACK_TEXT[cfg.replyStyle] ?? ACK_TEXT.default
}
