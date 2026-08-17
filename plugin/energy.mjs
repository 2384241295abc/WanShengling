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

/** 默认参数（与 config.mjs 的 DEFAULTS.energy 一致，可被覆盖） */
const DEFAULT_ENERGY = {
  enabled: true,
  range: [100, 1000],
  decayPerMin: 3,            // 每分钟能量衰减（原每秒3，改为每分钟3 = 慢60倍）
  msgCost: 10,
  contextWindow: 8,
}

export function createEnergyManager({ energy = {}, log = () => {} } = {}) {
  const opts = { ...DEFAULT_ENERGY, ...energy }
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

  /** 取某群最近聊天记录（供 prompt 上下文） */
  function getContext(qqKey) {
    const st = states.get(qqKey)
    if (!st || !st.history.length) return ''
    const lines = st.history.map((m) => `${m.user}: ${m.text}`).join('\n')
    return `（以下是该群最近的聊天记录，请基于这些内容自然地接话，不要复述记录本身：\n${lines}）`
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

  function dispose() {
    states.clear()
  }

  return { feed, force, forceTo, shouldReply, getContext, reset, getEnergy, stats, dispose }
}
