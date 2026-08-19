/**
 * handlers.mjs —— DSH 交互帧应答（question / approval）
 *
 * 策略由 autoAnswer 决定：
 *   'reject'（默认）→ 自动拒绝并提示（原行为）
 *   'allow-once'   → 自动放行一次
 *   'ask'          → 挂起：不自动应答，提示用户在 QQ 回复；用户下一条消息作为回答提交
 *
 * 挂起模式（'ask'）：
 *   - question/requested  → 存 pendingQuestion，提示"请在 QQ 回复你的选择"
 *   - approval/requested  → 存 pendingApproval，提示"请在 QQ 回复 允许/拒绝"
 *   - 用户下一条消息       → onUserReply 提交答案/结果，清除 pending
 */

'use strict'

import { randomUUID } from 'node:crypto'

export function createHandlers({ api, sendText, autoAnswer = 'reject', workAutoAnswer = 'ask', log = () => {} } = {}) {
  // 挂起状态：sessionId -> { type:'question'|'approval', data }
  const pending = new Map()
  // 策略按会话区分：工作模式(qq-work-*)用 workAutoAnswer（默认 ask 挂起），其余用 autoAnswer
  const policy = (sessionId) => (String(sessionId).startsWith('qq-work-') ? workAutoAnswer : autoAnswer)

  /** 当前会话是否有挂起的提问/审批 */
  function hasPending(sessionId) {
    return pending.has(sessionId)
  }

  /** question/requested */
  async function onQuestion(sessionId, data) {
    const target = data.qqTarget
    const question = data.question?.text ?? JSON.stringify(data).slice(0, 200)
    const answers = data.question?.answers ?? []
    const mode = policy(sessionId)

    if (mode === 'ask') {
      // 挂起：不 respond，等用户在 QQ 回复
      pending.set(sessionId, { type: 'question', data, target })
      if (target) {
        const opts = answers.map((a, i) => `${i + 1}. ${a.text ?? a.answers?.[0]?.text ?? a.id ?? ''}`).join('\n')
        await sendText(target,
          `📌 模型在等您回答：\n${question}${opts ? `\n\n${opts}` : ''}\n\n👉 直接在 QQ 回复你的选择（或回答内容）。`).catch(() => {})
      }
      return
    }

    const allow = mode === 'allow-once'
    try {
      await api.respond({
        rpcId: randomUUID(),
        payload: {
          sessionId,
          answer: {
            answers: answers.map((a) => ({
              id: a.id,
              selected: allow ? [a.answers?.[0]?.id].filter(Boolean) : [],
            })),
          },
        },
      })
    } catch (err) {
      log('warn', '[qq-bridge] respond(question) failed: %s', err.message)
    }
    if (target) {
      await sendText(target, allow
        ? `🤖 已自动回答提问：${question}`
        : `⚠️ 模型在等您确认（QQ 端暂不支持提问）：${question}\n已按"拒绝"继续。请到 Web 界面处理。`).catch(() => {})
    }
  }

  /** approval/requested */
  async function onApproval(sessionId, data) {
    const target = data.qqTarget
    const mode = policy(sessionId)

    if (mode === 'ask') {
      // 挂起：等用户在 QQ 回复 允许/拒绝
      pending.set(sessionId, { type: 'approval', data, target })
      if (target) {
        await sendText(target,
          `🔐 模型请求了工具调用权限：\n${data.description ?? data.label ?? ''}\n\n👉 请在 QQ 回复「允许」或「拒绝」。`).catch(() => {})
      }
      return
    }

    const allow = mode === 'allow-once'
    try {
      await api.respond({
        rpcId: randomUUID(),
        payload: { sessionId, approvalId: data.approvalId, outcome: allow ? 'allowed-once' : 'rejected' },
      })
    } catch (err) {
      log('warn', '[qq-bridge] respond(approval) failed: %s', err.message)
    }
    if (target) {
      await sendText(target, allow
        ? '🤖 已自动允许本次工具调用。'
        : '⚠️ 模型请求了工具调用审批（QQ 端暂不支持），已自动拒绝。请到 Web 界面处理。').catch(() => {})
    }
  }

  /** 用户下一条消息 → 回答挂起的提问/审批 */
  async function onUserReply(sessionId, text) {
    const pend = pending.get(sessionId)
    if (!pend) return false
    pending.delete(sessionId)
    const { type, data, target } = pend

    if (type === 'question') {
      const answers = data.question?.answers ?? []
      // 用户可能回序号(1.) 或直接回答文本
      const m = String(text).trim().match(/^(\d+)[.、)]?/)
      let selected = null
      if (m) {
        const idx = parseInt(m[1], 10) - 1
        const a = answers[idx]
        if (a) selected = a
      } else if (answers.length === 1) {
        selected = answers[0]
      }
      const selectedIds = selected ? [selected.answers?.[0]?.id ?? selected.id].filter(Boolean) : []
      try {
        await api.respond({
          rpcId: randomUUID(),
          payload: {
            sessionId,
            answer: { answers: answers.map((a) => ({ id: a.id, selected: a.id === selected?.id ? selectedIds : [] })) },
          },
        })
      } catch (err) {
        log('warn', '[qq-bridge] respond(question, user) failed: %s', err.message)
      }
      if (target) {
        await sendText(target, selectedIds.length
          ? `✅ 已提交你的回答（${String(text).trim()}）`
          : `⚠️ 已收到回答，但未能映射到选项（如需请到 Web 界面处理）。`).catch(() => {})
      }
      return true
    }

    if (type === 'approval') {
      const outcome = /^(允许|同意|是|allow|yes|approve|ok)/i.test(String(text).trim()) ? 'allowed-once' : 'rejected'
      try {
        await api.respond({
          rpcId: randomUUID(),
          payload: { sessionId, approvalId: data.approvalId, outcome },
        })
      } catch (err) {
        log('warn', '[qq-bridge] respond(approval, user) failed: %s', err.message)
      }
      if (target) {
        await sendText(target, outcome === 'allowed-once' ? '✅ 已允许本次工具调用。' : '❌ 已拒绝本次工具调用。').catch(() => {})
      }
      return true
    }
    return false
  }

  return { onQuestion, onApproval, onUserReply, hasPending }
}
