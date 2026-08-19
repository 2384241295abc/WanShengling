/**
 * discussion.mjs —— 群聊"讨论"事件模式
 *
 * 触发条件（任一满足即进入，每次消息后检查）：
 *   A. 某群成员友好度总和 > 成员数量 × triggerMultiplier（默认 80）
 *   B. 最近 activityWindowMs 内发言人数 > speakerThreshold（默认 9）
 *
 * 讨论模式行为：
 *   - 进入时能量固定为 enterEnergy（默认 10）
 *   - 每次有人发言：检测能量，<0 就回复，回复后能量重置为 replyResetRange 随机
 *   - 能量持续衰减（每分钟 -3、消息 -10/17）
 *   - 能量 < exitEnergy → 退出讨论，恢复常态（能量重置 random(500,1500)）
 *
 * ⚠️ 全部可调参数来自 config（DEFAULTS.discussion，补丁可覆盖 → 热更新无需重启）。
 *
 * 接口：
 *   createDiscussionManager({ energy, log, params })
 *     params = { triggerMultiplier, enterEnergy, replyResetRange, exitEnergy, activityWindowMs, speakerThreshold }
 *     → recordActivity(qqKey, userId)  记录发言活动（供窗口判定）
 *     → checkEnter(qqKey, groupTotal, memberCount, recentSpeakers)  检查是否进入讨论
 *     → enter(qqKey) / exit(qqKey) / isActive(qqKey)
 *     → onReply(qqKey)   回复后重置能量（replyResetRange 随机）
 *     → checkExit(qqKey) 能量 < exitEnergy → 退出
 *     → getContext(qqKey) 讨论环境提示文本（注入 prompt）
 */

'use strict'

/** 讨论模式默认参数（config.mjs DEFAULTS.discussion 引用本对象，勿在别处重复维护） */
export const DEFAULT_DISCUSSION = {
  triggerMultiplier: 80,             // 条件A：总友好度 > 成员数 × 系数
  enterEnergy: 10,                   // 进入讨论时能量
  replyResetRange: [30, 60],         // 讨论中每次回复后重置的能量范围
  exitEnergy: -24,                   // 能量低于此值退出讨论
  activityWindowMs: 2 * 60 * 1000,   // 发言活跃窗口（毫秒）
  speakerThreshold: 9,               // 条件B：窗口内发言人数 > 阈值（2026-08-19 由 5 改 9）
}

export function createDiscussionManager({ energy, log = () => {}, params = {} } = {}) {
  const p = { ...DEFAULT_DISCUSSION, ...params }
  if (Array.isArray(params.replyResetRange)) p.replyResetRange = [...params.replyResetRange]
  else if (Array.isArray(p.replyResetRange)) p.replyResetRange = [...p.replyResetRange]

  /** qqKey -> 是否讨论中 */
  const active = new Set()
  /** qqKey -> [{userId, at}] 最近发言活动（滚动窗口） */
  const activity = new Map()

  function isActive(qqKey) {
    return active.has(qqKey)
  }

  /** 记录一次发言活动（供窗口判定） */
  function recordActivity(qqKey, userId) {
    let list = activity.get(qqKey)
    if (!list) { list = []; activity.set(qqKey, list) }
    list.push({ userId: String(userId), at: Date.now() })
    // 清理窗口外的旧记录
    const cutoff = Date.now() - p.activityWindowMs
    while (list.length && list[0].at < cutoff) list.shift()
    if (list.length > 100) list.splice(0, list.length - 100)
  }

  /** 最近 activityWindowMs 内发言人数 */
  function recentSpeakers(qqKey) {
    const list = activity.get(qqKey)
    if (!list) return 0
    const cutoff = Date.now() - p.activityWindowMs
    const ids = new Set()
    for (const m of list) if (m.at >= cutoff) ids.add(m.userId)
    return ids.size
  }

  /** 进入讨论：能量固定 enterEnergy */
  function enter(qqKey) {
    if (active.has(qqKey)) return false
    active.add(qqKey)
    energy.forceTo(qqKey, p.enterEnergy)
    log('info', '[qq-bridge] 群 %s 进入讨论模式（能量=%d）', qqKey, p.enterEnergy)
    return true
  }

  /** 退出讨论：恢复常态（重置能量由调用方处理） */
  function exit(qqKey) {
    if (!active.has(qqKey)) return false
    active.delete(qqKey)
    log('info', '[qq-bridge] 群 %s 退出讨论模式', qqKey)
    return true
  }

  /** 讨论环境提示（仅讨论中注入；退出后不再注入=自然恢复常态） */
  function getContext(qqKey) {
    if (!active.has(qqKey)) return ''
    return `（当前群正在热烈讨论中，多人参与、气氛活跃。你说话要自然融入讨论，可以简短接话、吐槽、附和或反问，别显得突兀，也别一个人长篇大论。）`
  }

  /**
   * 消息后/周期检查：退出讨论并重置能量为常态随机值。
   * 退出条件（任一）：
   *   - 能量 < exitEnergy（-24）：讨论节奏长期回复后能量仍持续走低；
   *   - 活跃度回落：recentSpeakers <= speakerThreshold（2 分钟窗口内发言人数已降到阈值以下）→
   *     讨论散了，自然退出（与进入条件对称："人散则退"）。
   * 传入 recentSpeakers=null/undefined 时只做能量判定（调用方无法提供时）。
   */
  function checkExit(qqKey, recentSpeakers) {
    if (!active.has(qqKey)) return false
    const e = energy.getEnergy(qqKey)
    const energyLow = e !== undefined && e < p.exitEnergy
    const crowdGone = recentSpeakers !== undefined && recentSpeakers !== null && recentSpeakers <= p.speakerThreshold
    if (energyLow || crowdGone) {
      log('info', '[qq-bridge] 群 %s 退出讨论（能量=%s，活跃度=%s）', qqKey, energyLow, crowdGone ? recentSpeakers : '活跃')
      exit(qqKey)
      energy.reset(qqKey)
      return true
    }
    return false
  }

  /** 讨论中每次回复后：能量重置为 replyResetRange 随机 */
  function onReply(qqKey) {
    if (!active.has(qqKey)) return
    const [lo, hi] = p.replyResetRange
    const v = lo + Math.floor(Math.random() * (hi - lo + 1))
    energy.forceTo(qqKey, v)
    log('info', '[qq-bridge] 群 %s 讨论中回复，能量重置为 %d', qqKey, v)
  }

  /**
   * 检查是否应进入讨论。
   * 条件 A：群总友好度 > 成员数 × triggerMultiplier；或条件 B：窗口内发言人数 > speakerThreshold。
   * @returns true=本次进入讨论
   */
  function checkEnter(qqKey, groupTotal, memberCount, recentSpeakers) {
    if (active.has(qqKey)) return false
    const condA = memberCount > 0 && groupTotal > memberCount * p.triggerMultiplier
    const condB = recentSpeakers > p.speakerThreshold
    if (condA || condB) {
      log('info', '[qq-bridge] 群 %s 触发讨论（友好度条件=%s，活跃条件=%s/%d人）', qqKey, condA, condB, recentSpeakers)
      return enter(qqKey)
    }
    return false
  }

  /** 状态快照（可视化） */
  function stats() {
    const out = { activeGroups: [...active] }
    for (const qqKey of active) out[qqKey] = { recentSpeakers: recentSpeakers(qqKey) }
    return out
  }

  return { isActive, recordActivity, recentSpeakers, enter, exit, checkEnter, checkExit, onReply, getContext, stats }
}
