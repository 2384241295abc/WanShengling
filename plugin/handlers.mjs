/**
 * handlers.mjs —— DSH 交互帧应答（question / approval）
 *
 * 事件通道：question/requested、approval/requested 是 mux 帧（仅经 events.mux 流
 * 广播给订阅者，不是 session/event），由 index.mjs 订阅 mux 后转交本模块。
 * 应答必须回显帧携带的 rpcId（respond 按 rpcId 路由 pending），payload 结构：
 *   question → { sessionId, answer: { answers: [{ id, selected: [option label...], custom? }] } }
 *   approval → { sessionId, approvalId, outcome: 'allowed-once' | 'rejected' }
 *
 * 策略由 autoAnswer / workAutoAnswer 决定（按会话前缀分流）：
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

/** 应答一帧：构造完整 ClientResponse，回显原始 rpcId */
async function respondFrame(api, rpcId, value, log) {
  try {
    await api.respond({
      type: 'client-response',
      rpcId,
      result: { ok: true, value },
    })
  } catch (err) {
    log('warn', '[qq-bridge] respond failed: %s', err.message)
  }
}

export function createHandlers({ api, sendText, autoAnswer = 'reject', workAutoAnswer = 'ask', log = () => {} } = {}) {
  // 挂起状态：sessionId -> { type:'question'|'approval', rpcId, data, target }
  const pending = new Map()
  // 策略按会话区分：工作模式(qq-work-*)用 workAutoAnswer（默认 ask 挂起），其余用 autoAnswer
  const policy = (sessionId) => (String(sessionId).startsWith('qq-work-') ? workAutoAnswer : autoAnswer)

  /** 当前会话是否有挂起的提问/审批 */
  function hasPending(sessionId) {
    return pending.has(sessionId)
  }

  /** 找挂起键：优先精确匹配，其次匹配退化 id（qq-xxx-<ts>，归档重建后出现） */
  function findPendingKey(sessionId) {
    if (pending.has(sessionId)) return sessionId
    for (const key of pending.keys()) {
      if (String(key).startsWith(`${sessionId}-`)) return key
    }
    return undefined
  }

  /** question/requested：data 为完整帧 payload（含 questions/qqTarget） */
  async function onQuestion(sessionId, rpcId, data) {
    const target = data.qqTarget
    const questions = data.questions ?? []
    const q0 = questions[0]
    const questionText = q0?.question ?? JSON.stringify(questions).slice(0, 200)
    const opts = q0?.options ?? []
    const mode = policy(sessionId)

    if (mode === 'ask') {
      // 挂起：不 respond，等用户在 QQ 回复
      pending.set(sessionId, { type: 'question', rpcId, data, target })
      if (target) {
        const optLines = opts.map((o, i) => `${i + 1}. ${o.label}`).join('\n')
        await sendText(target,
          `📌 模型在等您回答：\n${questionText}${optLines ? `\n\n${optLines}` : ''}\n\n👉 直接在 QQ 回复你的选择（或回答内容）。`).catch(() => {})
      }
      return
    }

    // reject / allow-once：自动应答（allow-once 选第一个选项，reject 全不选）
    const allow = mode === 'allow-once'
    const answers = questions.map((q) => ({
      id: q.id,
      selected: allow && q.options?.length ? [q.options[0].label] : [],
    }))
    await respondFrame(api, rpcId, { sessionId, answer: { answers } }, log)
    if (target) {
      await sendText(target, allow
        ? `🤖 已自动回答提问：${questionText}`
        : `⚠️ 模型在等您确认（QQ 端暂不支持提问）：${questionText}\n已按"拒绝"继续。请到 Web 界面处理。`).catch(() => {})
    }
  }

  /** approval/requested：data 为完整帧 payload（含 approvalId/toolName/reason/qqTarget） */
  async function onApproval(sessionId, rpcId, data) {
    const target = data.qqTarget
    const desc = data.reason ?? data.toolName ?? ''
    const mode = policy(sessionId)

    if (mode === 'ask') {
      // 挂起：等用户在 QQ 回复 允许/拒绝
      pending.set(sessionId, { type: 'approval', rpcId, data, target })
      if (target) {
        await sendText(target,
          `🔐 模型请求了工具调用权限：\n${desc}\n\n👉 请在 QQ 回复「允许」或「拒绝」。`).catch(() => {})
      }
      return
    }

    const outcome = mode === 'allow-once' ? 'allowed-once' : 'rejected'
    await respondFrame(api, rpcId, { sessionId, approvalId: data.approvalId, outcome }, log)
    if (target) {
      await sendText(target, outcome === 'allowed-once'
        ? '🤖 已自动允许本次工具调用。'
        : '⚠️ 模型请求了工具调用审批（QQ 端暂不支持），已自动拒绝。请到 Web 界面处理。').catch(() => {})
    }
  }

  /** 用户下一条消息 → 回答挂起的提问/审批 */
  async function onUserReply(sessionId, text) {
    const pend = pending.get(sessionId)
    if (!pend) return false
    pending.delete(sessionId)
    const { type, rpcId, data, target } = pend
    const raw = String(text).trim()

    if (type === 'question') {
      const questions = data.questions ?? []
      const q0 = questions[0]
      const opts = q0?.options ?? []
      // 用户可能回序号(1.)、选项原文、或自由文本
      const m = raw.match(/^(\d+)[.、)]?/)
      let selected = []
      if (m) {
        const opt = opts[parseInt(m[1], 10) - 1]
        if (opt) selected = [opt.label]
      } else if (opts.length === 1) {
        selected = [opts[0].label]
      } else if (opts.length > 0) {
        const hit = opts.find((o) => o.label === raw || raw.includes(o.label) || o.label.includes(raw))
        if (hit) selected = [hit.label]
      }
      const answers = questions.map((q, i) => ({
        id: q.id,
        selected: i === 0 ? selected : [],
        // 自由文本回答：单选问题没选上选项时作为 custom 提交（契约允许）
        ...(i === 0 && selected.length === 0 && raw ? { custom: raw.slice(0, 2000) } : {}),
      }))
      await respondFrame(api, rpcId, { sessionId, answer: { answers } }, log)
      if (target) {
        await sendText(target, selected.length
          ? `✅ 已提交你的回答（${raw}）`
          : `⚠️ 已收到回答，但未能映射到选项（已按你的原文提交）。`).catch(() => {})
      }
      return true
    }

    if (type === 'approval') {
      const outcome = /^(允许|同意|是|allow|yes|approve|ok)/i.test(raw) ? 'allowed-once' : 'rejected'
      await respondFrame(api, rpcId, { sessionId, approvalId: data.approvalId, outcome }, log)
      if (target) {
        await sendText(target, outcome === 'allowed-once' ? '✅ 已允许本次工具调用。' : '❌ 已拒绝本次工具调用。').catch(() => {})
      }
      return true
    }
    return false
  }

  return { onQuestion, onApproval, onUserReply, hasPending, findPendingKey }
}
