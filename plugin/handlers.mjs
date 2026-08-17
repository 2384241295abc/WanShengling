/**
 * handlers.mjs —— DSH 交互帧应答（question / approval）
 *
 * MVP 必须处理 question/requested，否则 tool-ask-user 让回合永久挂起。
 * 策略由 autoAnswer 决定：'reject'（默认拒绝并提示）| 'allow-once'（自动放行）。
 */

'use strict'

import { randomUUID } from 'node:crypto'

export function createHandlers({ api, sendText, autoAnswer = 'reject', log = () => {} } = {}) {
  const allow = autoAnswer === 'allow-once'

  /** question/requested：必须应答否则回合挂起；按 autoAnswer 策略。 */
  async function onQuestion(sessionId, data) {
    const target = data.qqTarget  // 由调用方注入当前条目目标
    const question = data.question?.text ?? JSON.stringify(data).slice(0, 200)
    try {
      await api.respond({
        rpcId: randomUUID(),
        payload: {
          sessionId,
          answer: {
            answers: (data.question?.answers ?? []).map((a) => ({
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

  /** approval/requested：按 autoAnswer 策略自动应答。 */
  async function onApproval(sessionId, data) {
    const target = data.qqTarget
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

  return { onQuestion, onApproval }
}
