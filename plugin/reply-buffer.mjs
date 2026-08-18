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
    list.push({ sessionId, qqTarget, steps: [], chunks: [], lastFlush: Date.now(), done: false })
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
    if (done) {
      for (let i = 0; i < text.length; i += maxChunkLength) {
        await sendText(buf.qqTarget, text.slice(i, i + maxChunkLength)).catch(() => {})
      }
      if (reason && reason !== 'completed') {
        await sendText(buf.qqTarget, `（回合结束：${reason}）`).catch(() => {})
      }
      // 回灌万生玲刚发的回复（供下一轮上下文自省，避免重复/衔接断裂）
      onReply({ target: buf.qqTarget, text })
    } else {
      // 长回复进行中：仅在确实超时才提示，避免打扰（自然口吻）
      await sendText(buf.qqTarget, '…内容有点多，我继续说完').catch(() => {})
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
