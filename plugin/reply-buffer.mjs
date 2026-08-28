/**
 * reply-buffer.mjs —— 回复缓冲队列（流式聚合 + 按序回传 + 分块发送）
 *
 * 数据流：assistant/chunk（text-delta 累积）→ assistant/message（step 终稿）
 *       → turn/end（消费队头条目）→ flush 发送到 QQ
 *
 * 对外接口：
 *   createReplyBuffer({ sendText, maxChunkLength, forceFlushMs, log })
 *     → enqueue(sessionId, qqTarget) 入队新回合
 *     → onEvent(sessionId, event)     处理 assistant/chunk|message、turn/end
 *     → clear(sessionId)              清空（归档重建时）
 */

'use strict'

/** 固定提示去重：target+提示文本 → 最近发送时间（毫秒）。
 *  防止双实例/重复事件下同一提示刷屏（如「内容有点多」「回合结束」）。
 *  模块级（跨 createReplyBuffer 实例共享）——同一 target 短时间内不重复发相同提示。 */
const lastHintAt = new Map()
const HINT_DEDUP_MS = 5000

/** 尝试发固定提示：同 target+文本在 HINT_DEDUP_MS 内已发过则跳过，返回是否真的发出 */
async function sendHintOnce(sendText, target, text) {
  const key = `${target?.message_type || '?'}:${target?.group_id ?? target?.user_id ?? '?'}:${text}`
  const now = Date.now()
  const last = lastHintAt.get(key) || 0
  if (now - last < HINT_DEDUP_MS) return false
  lastHintAt.set(key, now)
  await sendText(target, text).catch(() => {})
  return true
}

/** 跨回合完全去重（2026-08-29）：同一 target 在去重窗口内已发过完全相同的回复 → 跳过发送。
 *  修复"连着发两次同一句话"：独立回合（如冷却到期后新 @ 触发）模型可能复读上一条
 *  （实测 01:35 连续两条"今日运势"）。机制层兜底：任何来源的完全重复都不再发出。 */
const lastSentReply = new Map()   // target key -> { text, at }
const REPLY_DEDUP_MS = 60000      // 60s 窗口内相同文本视为重复（间隔久了允许再说同样的话）

function targetKey(t) {
  return `${t?.message_type || '?'}:${t?.group_id ?? t?.user_id ?? '?'}`
}

export function createReplyBuffer({ sendText, maxChunkLength = 3500, forceFlushMs = 30000, log = () => {}, onReply = () => {} } = {}) {
  /** sessionId -> 缓冲队列（连续消息各自成条目，回合结束消费队头） */
  const buffers = new Map()

  /** 取会话的活跃缓冲（队头未完成条目）；无则返回 undefined */
  function activeBuffer(sessionId) {
    const list = buffers.get(sessionId)
    if (!list) return undefined
    return list.find((b) => !b.done)
  }

  /** 入队：连续消息各自一个缓冲条目，回复按序回传（不会被后到的消息覆盖） */
  function enqueue(sessionId, qqTarget) {
    const list = buffers.get(sessionId) || []
    list.push({ sessionId, qqTarget, steps: [], chunks: [], lastFlush: Date.now(), done: false, hinted: false })
    buffers.set(sessionId, list)
    return list.length
  }

  /** 发送前清洗模型偶发的运行时标签模仿块（system-reminder / available_skills），整块（含标签与内容）去除 */
  function sanitize(text) {
    return text
      .replace(/<(system-reminder|available_skills)>[\s\S]*?(<\/\1>|$)/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  async function flush(buf, done, reason) {
    const text = sanitize(buf.steps.join('\n\n').trim() || buf.chunks.join('').trim())
    if (!text) return
    // 实际发出的文本：sendText 可能对文本做转换（如解析 [发图:xxx] 标记并改发图片），
    // 以 sendText 返回值（清理后的文本）为准回灌，避免标记残留进聊天记录
    let sentText = text
    if (done) {
      // 🔒 跨回合去重：上一条回复与此完全相同（60s 内）→ 跳过发送，防"连着发两次同一句话"。
      //    不回灌（chatlog 不再多一条重复）；但仍通知 onReply（sent:false）→ 宿主照常进入
      //    冷却（它"本该回复"），避免去重后下一条消息立刻又触发。
      const key = targetKey(buf.qqTarget)
      const prev = lastSentReply.get(key)
      if (prev && prev.text === text && Date.now() - prev.at < REPLY_DEDUP_MS) {
        log('warn', '[qq-bridge] 回复去重：%s 与 %d 秒前回复相同，跳过发送（%s）',
          key, Math.round((Date.now() - prev.at) / 1000), text.slice(0, 30))
        onReply({ target: buf.qqTarget, text, sent: false })
        return
      }
      for (let i = 0; i < text.length; i += maxChunkLength) {
        // 接受 sendText 返回的清理后文本（可为空串——纯发图时无文字回灌）；
        // 仅当返回 null（发送失败）时保留原文本
        const r = await sendText(buf.qqTarget, text.slice(i, i + maxChunkLength)).catch(() => null)
        if (typeof r === 'string') sentText = r
      }
      lastSentReply.set(key, { text, at: Date.now() })
      if (reason && reason !== 'completed') {
        await sendHintOnce(sendText, buf.qqTarget, `（回合结束：${reason}）`)
      }
      // 回灌机器人刚发的回复（供下一轮上下文自省，避免重复/衔接断裂）+ 触发冷却
      onReply({ target: buf.qqTarget, text: sentText, sent: true })
    } else {
      // 长回复进行中：只在第一次超时提示一次（hinted 标志防重复 + 模块级去重防双实例刷屏）
      if (!buf.hinted) {
        buf.hinted = true
        await sendHintOnce(sendText, buf.qqTarget, '…内容有点多，我继续说完')
      }
    }
    buf.lastFlush = Date.now()
  }

  /** 处理 DSH 会话事件 */
  async function onEvent(sessionId, event) {
    switch (event.type) {
      case 'assistant/chunk': {
        const buf = activeBuffer(sessionId)
        if (!buf || event.data.chunk.type !== 'text-delta') return
        buf.chunks.push(event.data.chunk.text)
        if (Date.now() - buf.lastFlush > forceFlushMs) await flush(buf, false)
        break
      }
      case 'assistant/message': {
        const buf = activeBuffer(sessionId)
        if (!buf) return
        const text = (event.data.message?.content ?? [])
          .filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
        if (text) buf.steps.push(text)
        buf.chunks = []
        buf.lastFlush = Date.now()
        break
      }
      case 'turn/end': {
        const list = buffers.get(sessionId)
        const buf = list && list.shift()   // 队头 = 当前回合
        if (!buf) {
          // ⚠️ 防御：turn/end 到达但队列为空（事件先于 enqueue 或双实例错配）
          log('warn', '[qq-bridge] turn/end 无匹配缓冲 (session=%s)，可能丢回复', sessionId)
          return
        }
        buf.done = true
        await flush(buf, true, event.data.reason?.kind)
        if (list.length === 0) buffers.delete(sessionId)
        break
      }
    }
  }

  /** 清空某会话所有缓冲（归档重建时调用，避免旧事件串到新会话） */
  function clear(sessionId) {
    buffers.delete(sessionId)
  }

  /** 当前缓冲状态快照（供可视化/调试） */
  function stats() {
    return Object.fromEntries([...buffers.entries()].map(([k, list]) => [k, list.length]))
  }

  return { enqueue, onEvent, clear, stats, activeBuffer }
}
