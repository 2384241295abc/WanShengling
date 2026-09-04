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
  range: [30, 90],             // 回复后能量随机恢复区间（2026-08-29 重构：删补回定时器后调低——
                               //   下界须 >0（衰减 3/分钟，0 会瞬间变负触发）；活跃群冷却期 feed 扣能
                               //   到期后自然触发，冷群靠衰减低频触发）
  decayPerMin: 3,            // 每分钟能量衰减（原每秒3，改为每分钟3 = 慢60倍）
  msgCost: 10,
  contextWindow: 8,
  soloIdleMs: 60000,         // solo 超时：发起人友好度超过该毫秒未上升则退出（solo 仅记录状态，节奏统一走冷却）
  maxSoloMs: 300000,         // solo 绝对上限：进入后超过该毫秒强制退出（兜底，防续期循环导致永不退出；2026-08-29 新增）
  cooldownMs: 15000,         // 回复冷却：回复发出后这些毫秒内消息不触发（用户要求 15s）
  inFlightTtlMs: 180000,     // 入队忙期上限（原"在途"标记 TTL）：promptQueue 成功后该毫秒内同群
                             //   消息不触发（防连发）；onReply 的 beginCooldown 会覆盖收敛为冷却时长。
  replyAfterCooldown: true,  // CD 到期补回：冷却期内有消息 → 冷却到期自动回一条（不等新消息）。
                             //   2026-08-30 恢复"补回"能力（8/29 曾因竞态删除），现以 inFlight 互斥安全实现
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

  // ---------- 回复忙期(busy)状态机（2026-09-04 整合：原 cooldownUntil + inFlightUntil 双时间标记合一） ----------
  // 一个 busyUntil 时间戳覆盖该群"此刻不应自动触发"的两段窗口，杜绝双标记漂移/过期逻辑重复：
  //   · 入队后（模型生成中）：index 调 markBusy → busyUntil = now + inFlightTtlMs（生成异常时
  //     自然过期，不会永久卡回复；回复发出后 beginCooldown 会覆盖缩短）；
  //   · 发送完成后：onReply → beginCooldown → busyUntil = now + cooldownMs（冷却间隔）。
  // 检查一律走 inCooldown()（语义 = busy，含"在途"与"冷却"；旧 index 里 inCooldown||inFlight 已收敛）。

  /** 回复发出后调用：进入冷却。冷却期内消息只累积（feed 扣能入历史），不触发；到期自然失效。
   *  （同时覆盖清除入队期在途标记——同窗口，直接覆盖到 now+cooldownMs） */
  function beginCooldown(qqKey, cooldownMs) {
    const now = Date.now()
    let st = states.get(qqKey)
    if (!st) { st = { energy: opts.range[0], lastTick: now, history: [] }; states.set(qqKey, st) }
    st.lastReplyAt = now
    st.busyUntil = now + (cooldownMs >= 0 ? cooldownMs : (opts.cooldownMs ?? 15000))
    log('info', '[qq-bridge] 群 %s 进入回复忙期(冷却)，busyUntil=%d', qqKey, st.busyUntil)
    return st.busyUntil
  }

  /** promptQueue 入队成功后调用：标记回复在途（生成中窗口）。带 TTL 惰性过期（onReply 异常时兜底）。 */
  function markBusy(qqKey, ttlMs) {
    const now = Date.now()
    let st = states.get(qqKey)
    if (!st) { st = { energy: opts.range[0], lastTick: now, history: [] }; states.set(qqKey, st) }
    st.busyUntil = now + (ttlMs >= 0 ? ttlMs : (opts.inFlightTtlMs ?? 180000))
  }

  /** 该群当前是否处于回复忙期（入队在途 或 发送后冷却）；未设/过期 = false（到期自然失效） */
  function inCooldown(qqKey) {
    const st = states.get(qqKey)
    if (!st || st.busyUntil === undefined) return false
    applyDecay(st)
    return Date.now() < st.busyUntil
  }

  /** 忙期剩余毫秒（0 = 可回复；供 /能量 指令展示） */
  function cooldownRemainingMs(qqKey) {
    const st = states.get(qqKey)
    if (!st || st.busyUntil === undefined) return 0
    const r = st.busyUntil - Date.now()
    return r > 0 ? r : 0
  }

  // ---------- CD 到期补回 pending（2026-08-30，方向：冷却期有消息 → 到期自动回一条） ----------
  // 冷却期消息 feed 时由 index 调 notePending 记下"冷却期最后一条消息"；冷却到期后（周期检查）若
  // 无人发言触发正常回复，则由补回路径把这条消息作为回应对象自动回一句（不等新消息）。
  // 正常触发路径（冷却到期后第一条消息触发回复）会 clearPending——回复已覆盖冷却期消息，无需补回。

  /** 记录冷却期消息（覆盖写：只留冷却期最后一条，供到期补回） */
  function notePending(qqKey, user, text, isAt = false) {
    const now = Date.now()
    let st = states.get(qqKey)
    if (!st) { st = { energy: opts.range[0], lastTick: now, history: [] }; states.set(qqKey, st) }
    st.pending = { user: String(user ?? '?'), text: String(text ?? ''), isAt: !!isAt }
  }

  /** 是否冷却期累积过消息（待补回） */
  function hasPending(qqKey) {
    const st = states.get(qqKey)
    return !!(st && st.pending && st.pending.text)
  }

  /** 清空补回标记（正常触发/补回触发/冷却重置时调用） */
  function clearPending(qqKey) {
    const st = states.get(qqKey)
    if (st) st.pending = undefined
  }

  /** 冷却期最后一条消息（补回回复的回应对象） */
  function pendingInfo(qqKey) {
    const st = states.get(qqKey)
    return (st && st.pending) || null
  }

  /** 所有有待补回消息的群（周期检查用） */
  function pendingKeys() {
    const out = []
    for (const [k, st] of states) if (st.pending && st.pending.text) out.push(k)
    return out
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

  /** 最近一条机器人自己的回复文本（供当前消息标注承接点；无则空串）。
   *  history 里倒序找最近一条 self 消息——即使最新几条是用户消息（feed 写入），
   *  也能定位到 bot 上次说了什么，帮模型判断本条消息是否接着那句聊的。 */
  function lastBotReply(qqKey) {
    const st = states.get(qqKey)
    if (!st || !st.history.length) return ''
    for (let i = st.history.length - 1; i >= 0; i--) {
      const m = st.history[i]
      if (m.user === 'self' && m.text) return m.text
    }
    return ''
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

  /** 纯记录一条消息进聊天历史（不扣能量、不触发）—— 如图片等无文字消息的占位 */
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

  return { feed, force, forceTo, shouldReply, getContext, reset, getEnergy, stats, dispose, record, recordBotReply, beginCooldown, markBusy, inCooldown, cooldownRemainingMs, lastBotReply, notePending, hasPending, clearPending, pendingInfo, pendingKeys }
}
