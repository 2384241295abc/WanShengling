/**
 * OneBot 11 WebSocket 客户端（正向/反向）
 *
 * 与具体框架（NapCat / Lagrange / LLOneBot）解耦，仅依赖标准 OneBot 11 协议：
 *  - 事件：message.private / message.group / meta_event（heartbeat、lifecycle）
 *  - 动作：send_private_msg / send_group_msg（echo 关联响应）
 *  - 心跳：客户端主动发 {action:"get_meta"} 保活（正向 WS）
 *
 * 用法：
 *   const bot = new OneBotClient({ url: 'ws://127.0.0.1:3001', token: 'xxx' })
 *   bot.on('message', (e) => { ... e.message_type / e.group_id / e.user_id / e.text() })
 *   await bot.connect()
 *   await bot.sendText({ message_type:'group', group_id, user_id }, 'hello')
 *
 * 依赖：Node ≥ 22 内置全局 WebSocket，无外部依赖。
 */
'use strict'

import { EventEmitter } from 'node:events'

export class OneBotError extends Error {
  constructor(message, retcode, data) {
    super(message)
    this.retcode = retcode
    this.data = data
  }
}

/**
 * 模块级「同一 WS url 单连接」注册表（跨 apply / 热重载实例共享）。
 *
 * 🔴 根治历史老 bug（记录 40/50、"多次接收群消息但只发一条回去"）：
 *   HMR/热重载会反复调用 apply() 创建新 OneBotClient，而 Cordis 不保证调用旧实例
 *   的 disposer → 旧 WS 连接残留累积（曾积累到 6 条）。每条连接都是一个消息监听
 *   实例，导致同一条群消息被多个实例重复处理（接收多次、但回复合并/丢序）。
 *   这里在「新建实例时若同 url 已有活动实例则先关掉旧的」→ 无论 disposer 是否被调，
 *   进程内始终只有 1 条连到同一 url 的连接 → 每条消息只被一个实例处理。
 */
const activeByUrl = new Map()

export class OneBotClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url        正向 WS 地址，如 ws://127.0.0.1:3001
   * @param {string} [opts.token]    Authorization: Bearer <token>
   * @param {number} [opts.reconnectDelayMs=3000]   断线重连间隔
   * @param {number} [opts.maxReconnectDelayMs=30000]
   * @param {number} [opts.heartbeatMs=25000]        正向 WS 保活间隔
   */
  constructor(opts) {
    super()
    this.url = opts.url
    this.token = opts.token || ''
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 3000
    this.maxReconnectDelayMs = opts.maxReconnectDelayMs ?? 30000
    this.heartbeatMs = opts.heartbeatMs ?? 25000
    this.ws = null
    this.connected = false
    this.closed = false            // 主动关闭
    this.active = true             // 消息处理开关：close/被新实例替换后置 false，旧实例即使 socket 残留也丢弃消息
    this.reconnectAttempt = 0
    this.pending = new Map()       // echo -> { resolve, reject, timer }
    this.nextEcho = 0
    this._hbTimer = null

    // 🔴 单连接去重：同 url 若已有活动实例，先关掉旧的，保证进程内 1 条 → 防多实例重复处理消息
    const prev = activeByUrl.get(this.url)
    if (prev && prev !== this) {
      try { prev.close() } catch { /* ignore */ }
    }
    activeByUrl.set(this.url, this)
  }

  connect() {
    this.closed = false
    this._open()
    return this
  }

  _open() {
    if (this.closed) return
    const headers = this.token ? { Authorization: `Bearer ${this.token}` } : {}
    let ws
    try {
      ws = new WebSocket(this.url, { headers })
    } catch (err) {
      this.emit('error', err)
      this._scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.connected = true
      this.reconnectAttempt = 0
      this.emit('open')
      this._startHeartbeat()
    }
    ws.onmessage = (ev) => this._onMessage(String(ev.data))
    ws.onerror = (ev) => {
      // onclose 随后必然触发，重连逻辑只放 onclose，避免双重重连
      this.emit('error', new Error(ev.message || 'onebot ws error'))
    }
    ws.onclose = () => {
      this.connected = false
      this._stopHeartbeat()
      this._failAllPending(new Error('onebot ws closed'))
      this.emit('close')
      this._scheduleReconnect()
    }
  }

  _scheduleReconnect() {
    if (this.closed) return
    const delay = Math.min(this.reconnectDelayMs * 2 ** this.reconnectAttempt, this.maxReconnectDelayMs)
    this.reconnectAttempt += 1
    this.emit('reconnecting', { attempt: this.reconnectAttempt, delay })
    setTimeout(() => this._open(), delay)
  }

  _startHeartbeat() {
    this._stopHeartbeat()
    this._hbTimer = setInterval(() => {
      // get_login_info 同时充当心跳与延迟探测（失败走 onclose 重连）。
      // 注：NapCat 不支持 get_meta（1404），改用其支持的 get_login_info。
      this.request('get_login_info', {}).catch(() => {})
    }, this.heartbeatMs)
  }
  _stopHeartbeat() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null }
  }

  _onMessage(raw) {
    // 🔴 被替换/关闭的旧实例：即使底层 socket 在服务端残留、仍被 push 消息，
    // 也直接丢弃，绝不再触发 index 的处理 → 根治"同一条群消息被多实例重复处理"
    if (!this.active) return
    let msg
    try { msg = JSON.parse(raw) } catch { this.emit('raw', raw); return }
    this.emit('raw', msg)

    // 事件（服务端推送）：只按 post_type 发射一次（'message'/'meta_event'/'notice'/'request'）
    if (msg.post_type) {
      this.emit(msg.post_type, msg)
      return
    }
    // 动作响应（echo 关联）
    if (msg.echo !== undefined) {
      const p = this.pending.get(String(msg.echo))
      if (!p) return
      this.pending.delete(String(msg.echo))
      clearTimeout(p.timer)
      if (msg.status === 'ok' && msg.retcode === 0) p.resolve(msg.data ?? {})
      else p.reject(new OneBotError(msg.message || 'onebot action failed', msg.retcode, msg.data))
    }
  }

  /** 发起动作，等待 echo 响应。timeoutMs 默认 15s。 */
  request(action, params = {}, timeoutMs = 15000) {
    // 🔴 已被新实例替换/关闭的旧实例：禁止再发任何动作（否则"老版本抢回复"）
    if (!this.active) return Promise.reject(new Error(`onebot client inactive (${action})`))
    if (!this.connected || !this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error(`onebot not connected (readyState=${this.ws?.readyState})`))
    }
    const echo = String(this.nextEcho++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`onebot action timeout: ${action}`))
      }, timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ action, params, echo }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(err)
      }
    })
  }

  /** 便捷：发送文本。按 OneBot 11 规范 message 可为字符串或分段数组。 */
  async sendText(target, text) {
    const { message_type, group_id, user_id } = target
    const action = message_type === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = { message: text }
    if (message_type === 'group') params.group_id = group_id
    if (user_id !== undefined) params.user_id = user_id
    const data = await this.request(action, params)
    return data.message_id
  }

  /** 解析消息中的纯文本（拼接所有 text 段）。 */
  static extractText(message) {
    if (typeof message === 'string') return message
    if (!Array.isArray(message)) return ''
    return message
      .filter((seg) => seg && seg.type === 'text' && seg.data && typeof seg.data.text === 'string')
      .map((seg) => seg.data.text)
      .join('')
      .trim()
  }

  close() {
    this.closed = true
    this.active = false          // 停用消息处理（关键：即使 socket 残留也不再处理消息）
    this._stopHeartbeat()
    this._failAllPending(new Error('onebot client closed'))
    if (this.ws) { try { this.ws.close() } catch { /* ignore */ } this.ws = null }
    // 仅当自己是该 url 的当前实例才注销，避免误删新实例的注册
    if (activeByUrl.get(this.url) === this) activeByUrl.delete(this.url)
  }

  _failAllPending(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err) }
    this.pending.clear()
  }
}
