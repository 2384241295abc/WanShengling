/**
 * energy.mjs —— 群聊能量阈值机制（独立模块，便于单测与可视化调试）
 *
 * 原理：模拟真人"不是每条都回"的社交节奏。
 *   - 每次回复后，能量重置为随机区间值（默认 100~500）
 *   - 每秒能量 -decayPerSec（时间衰减，默认 3）——**惰性计算**：不跑定时器，
 *     仅在收到消息时按时间差补算衰减，节省资源
 *   - 群内每条消息 -msgCost（活跃度衰减，默认 10）
 *   - 能量 < 0 时触发回复（携带最近 contextWindow 条消息上下文）
 *   - 被 @ 时 force() 将能量置 -1（强制触发，模拟"点名就得回"）
 *
 * 对外接口：
 *   createEnergyManager({ energy, log }) →
 *     feed(qqKey, user, text)  记录消息+惰性衰减+扣能，返回是否触发
 *     force(qqKey)             被 @ 时调用：能量置 -1
 *     shouldReply(qqKey)       当前是否应回复
 *     getContext(qqKey)        取最近聊天记录（prompt 上下文）
 *     reset(qqKey)             回复后重置能量
 *     getEnergy(qqKey) / stats() 状态查询（可视化）
 *     dispose()                清理
 *
 * 纯逻辑、无 IO（不持有定时器），便于可视化配置界面直接调用/预览。
 */

'use strict'

/** 默认能量参数（**唯一事实来源**，config.mjs / group-config.mjs 均引用本常量，勿三处重复维护） */
export const DEFAULT_ENERGY = {
  enabled: true,
  range: [100, 1000],
  decayPerMin: 3,            // 每分钟能量衰减（原每秒3，改为每分钟3 = 慢60倍）
  msgCost: 10,
  contextWindow: 8,
  soloIdleMs: 60000,         // solo 超时：发起人友好度超过该毫秒未上升则退出（solo 仅记录状态，节奏统一走冷却）
  cooldownMs: 5000,          // 回复冷却：刚回复后这些毫秒内普通消息不触发，积累聊天记录后统一评估
}

export function createEnergyManager({ energy = {}, log = () => {}, resolveName = (userId) => userId, botName = '我' } = {}) {
  const opts = { ...DEFAULT_ENERGY, ...energy }
  /** 机器人显示名（聊天记录里自己的称呼；配置 botName 可改） */
  const selfName = botName || '我'
  /** qqKey -> { energy, lastTick, history: [{user, text, at}] } */
  const states = new Map()

  /** 惰性衰减：按距上次更新的分钟数补算衰减 */
  function applyDecay(st, now = Date.now()) {
    if (st.lastTick === undefined) { st.lastTick = now; return }
    const elapsedMin = (now - st.lastTick) / 60000
    if (elapsedMin > 0) {
      st.energy -= (opts.decayPerMin ?? opts.decayPerSec ?? 3) * elapsedMin
      st.lastTick = now
    }
  }

  function reset(qqKey) {
    let st = states.get(qqKey)
    if (!st) {
      // 防御：未初始化时自动建状态（正常流程 feed/force 会先建，此处兜底）
      st = { energy: opts.range[0], lastTick: Date.now(), history: [] }
      states.set(qqKey, st)
    }
    const [lo, hi] = opts.range
    st.energy = lo + Math.floor(Math.random() * (hi - lo + 1))
    st.lastTick = Date.now()
    return st.energy
  }

  /**
   * 记录群消息并扣能量（惰性衰减 + 消息扣能）。
   * @param {number} [cost] 消息扣能量，缺省用 opts.msgCost（挚友减免等场景传入更小值）
   * @returns {boolean} true = 达到触发阈值（应回复）
   */
  function feed(qqKey, user, text, cost) {
    const now = Date.now()
    let st = states.get(qqKey)
    if (!st) {
      st = { energy: opts.range[0], lastTick: now, history: [] }
      states.set(qqKey, st)
    }
    applyDecay(st, now)
    st.history.push({ user, text, at: now })
    const keep = opts.contextWindow
    if (st.history.length > keep) st.history = st.history.slice(-keep)
    const c = cost ?? opts.msgCost
    st.energy -= c
    log('info', '[qq-bridge] 群 %s 能量 %d (消息 -%d)', qqKey, st.energy, c)
    return st.energy < 0
  }

  /** 被 @ 触发：能量置 -1（必然 <0，下一轮必回） */
  function force(qqKey) {
    const now = Date.now()
    let st = states.get(qqKey)
    if (!st) {
      st = { energy: opts.range[0], lastTick: now, history: [] }
      states.set(qqKey, st)
    }
    applyDecay(st, now)
    st.energy = -1
    log('info', '[qq-bridge] 群 %s 被@，能量强制置 -1', qqKey)
  }

  /** 设置能量为指定值（讨论模式等用） */
  function forceTo(qqKey, value) {
    const now = Date.now()
    let st = states.get(qqKey)
    if (!st) {
      st = { energy: opts.range[0], lastTick: now, history: [] }
      states.set(qqKey, st)
    }
    applyDecay(st, now)
    st.energy = value
    return st.energy
  }

  /** 当前是否应回复（能量 < 0） */
  function shouldReply(qqKey) {
    const st = states.get(qqKey)
    if (!st) return false
    applyDecay(st)
    return st.energy < 0
  }

  // ---------- 回复冷却(cooldown)状态机 ----------

  /** 回复完成后调用：进入冷却。锁定能量为 -1(不触发)，开始累计冷却期新消息。 */
  function beginCooldown(qqKey, cooldownMs) {
    const now = Date.now()
    let st = states.get(qqKey)
    if (!st) { st = { energy: opts.range[0], lastTick: now, history: [] }; states.set(qqKey, st) }
    st.lastReplyAt = now
    st.cooldownUntil = now + (cooldownMs >= 0 ? cooldownMs : (opts.cooldownMs ?? 5000))
    st.pendingSinceReply = 0
    st.energy = -1           // 锁定：冷却期不触发（@ 除外）
    log('info', '[qq-bridge] 群 %s 进入回复冷却，cooldownUntil=%d', qqKey, st.cooldownUntil)
    return st.cooldownUntil
  }

  /** 该群当前是否处于冷却期（且不是因为 @ 已被打破） */
  function inCooldown(qqKey) {
    const st = states.get(qqKey)
    if (!st || st.cooldownUntil === undefined) return false
    applyDecay(st)
    return Date.now() < st.cooldownUntil
  }

  /**
   * 冷却期内普通消息调用：只把消息写进 history、累计 pending 计数，不判能量不触发。
   * 这些消息会作为「冷却期聊天记录」进入回复依据。
   * @returns {boolean} true 表示进入了冷却缓冲（调用方应 return 不回复）
   */
  function feedCooldown(qqKey, user, text) {
    const now = Date.now()
    let st = states.get(qqKey)
    if (!st) { st = { energy: opts.range[0], lastTick: now, history: [] }; states.set(qqKey, st) }
    st.history.push({ user, text, at: now })
    const keep = opts.contextWindow
    if (st.history.length > keep) st.history = st.history.slice(-keep)
    st.pendingSinceReply = (st.pendingSinceReply || 0) + 1
    log('info', '[qq-bridge] 群 %s 冷却中缓冲消息 pending=%d', qqKey, st.pendingSinceReply)
    return true
  }

  /** 冷却期内被 @ ：@ 可打破冷却，立即强制触发（设能量 -1 并清除冷却锁定） */
  function breakCooldown(qqKey) {
    const now = Date.now()
    let st = states.get(qqKey)
    if (!st) { st = { energy: opts.range[0], lastTick: now, history: [] }; states.set(qqKey, st) }
    st.cooldownUntil = now      // 解除锁定（标记已过期）
    st.energy = -1
    log('info', '[qq-bridge] 群 %s @打破冷却，强制触发', qqKey)
    return st.energy
  }

  /**
   * 冷却到期（外部定时器/下个消息驱动）调用：解除锁定并恢复能量节奏。
   * @returns {{expired:boolean, hasPending:boolean, pendingN:int}}
   *   expired=true 表示本回合刚从冷却解除；hasPending 表示冷却期有新消息（可作为回复依据）
   */
  function cooldownExpired(qqKey) {
    const st = states.get(qqKey)
    if (!st || st.cooldownUntil === undefined) return { expired: false, hasPending: false, pendingN: 0 }
    if (Date.now() < st.cooldownUntil) return { expired: false, hasPending: false, pendingN: (st.pendingSinceReply || 0) }
    const res = { expired: true, hasPending: (st.pendingSinceReply || 0) > 0, pendingN: (st.pendingSinceReply || 0) }
    st.cooldownUntil = undefined
    const pending = st.pendingSinceReply || 0
    st.pendingSinceReply = 0
    // 恢复能量：按配置随机复位（与 reset 相同的恢复逻辑）
    const [lo, hi] = opts.range
    st.energy = lo + Math.floor(Math.random() * (hi - lo + 1))
    st.lastTick = Date.now()
    log('info', '[qq-bridge] 群 %s 冷却结束，恢复能量=%d（冷却期缓冲 %d 条）', qqKey, st.energy, pending)
    return res
  }

  /** 取某群最近聊天记录（供 prompt 上下文）——发言者经 resolveName 解析为可读昵称；bot 自己标为 botName
   *  @param {boolean} [omitLast] 若 true，跳过最新一条（调用方刚经 feed 写入的"当前待回应消息"，
   *        避免它与 index 单独传入的 user message 重复出现 → 模型不会对错消息/接旧话）。
   */
  function getContext(qqKey, omitLast = false) {
    const st = states.get(qqKey)
    if (!st || !st.history.length) return ''
    let list = st.history
    if (omitLast) list = list.slice(0, -1)     // 去掉当前这条（正被回应的那句）
    if (!list.length) return ''
    const lines = list.map((m) => {
      const name = m.user === 'self' ? selfName : resolveName(m.user, qqKey)
      return `${name}: ${m.text}`
    }).join('\n')
    return `（以下是该群最近的聊天记录（含你自己上一条的回复），请自然地接话：不要复述记录、不要重复自己刚说过的话：\n${lines}）`
  }

  /**
   * 记录机器人自己刚发出的一条回复到上下文历史（不扣能量、不影响触发判断）。
   * 让模型在下一轮能看到自己上一条说了什么，避免重复与衔接断裂。
   */
  function recordBotReply(qqKey, text) {
    const now = Date.now()
    let st = states.get(qqKey)
    if (!st) {
      st = { energy: opts.range[0], lastTick: now, history: [] }
      states.set(qqKey, st)
    }
    if (text) {
      st.history.push({ user: 'self', text, at: now })
      const keep = opts.contextWindow
      if (st.history.length > keep) st.history = st.history.slice(-keep)
    }
  }

  /** 当前能量值（供可视化/调试） */
  function getEnergy(qqKey) {
    const st = states.get(qqKey)
    if (!st) return undefined
    applyDecay(st)
    return st.energy
  }

  /** 全部群状态快照（供可视化界面） */
  function stats() {
    return Object.fromEntries([...states.entries()].map(([k, v]) => [k, { energy: v.energy, historyLen: v.history.length }]))
  }

  /** 纯记录一条消息进聊天历史（不扣能量、不触发、不计 pending）—— 如图片等无文字消息的占位 */
  function record(qqKey, user, text) {
    const now = Date.now()
    let st = states.get(qqKey)
    if (!st) { st = { energy: opts.range[0], lastTick: now, history: [] }; states.set(qqKey, st) }
    st.history.push({ user, text, at: now })
    const keep = opts.contextWindow
    if (st.history.length > keep) st.history = st.history.slice(-keep)
  }

  function dispose() {
    states.clear()
  }

  return { feed, force, forceTo, shouldReply, getContext, reset, getEnergy, stats, dispose, record, recordBotReply, beginCooldown, inCooldown, feedCooldown, breakCooldown, cooldownExpired }
}
