/**
 * friend.mjs —— 成员友好度系统
 *
 * 目标：让万生玲对每个成员有"熟悉度"，影响她的反应与能量消耗。
 *
 * 核心规则（用户确认）：
 *   - 友好度按【用户维度】跨群共享（同一 QQ 号在所有群同一友好度）
 *   - 初始友好度 0
 *   - 万生玲每次发言，其【前后各 5 条】消息内的发言者友好度 +1（同人多条多次 +1）
 *   - 被 @ 时，@ 万生玲的用户友好度额外 +5
 *   - 等级：<80 陌生 | 80~160 认识 | 160~240 熟悉 | >240 挚友
 *   - 挚友：每句话减少 7 能量
 *
 * 接口：
 *   createFriendsManager({ log })
 *     → feedWindow(qqKey, userId)    万生玲发言时调用，结算前后5句窗口内成员 +1
 *     → recordMessage(qqKey, userId) 记录一条消息到窗口（供 feedWindow 用）
 *     → boost(qqKey, userId)         @ 万生玲的用户 +5
 *     → get(userId)                  取用户友好度
 *     → level(userId)                取等级（'stranger'|'acquaintance'|'familiar'|'best'）
 *     → friendEnergyBonus(userId)    挚友能量减免（挚友返回 7，否则 0）
 *     → groupTotal(qqKey)            某群成员友好度总和
 *     → stats()                      状态快照（可视化）
 */

'use strict'

/** 等级阈值 */
export const LEVELS = [
  { threshold: 240, level: 'best', label: '挚友' },
  { threshold: 160, level: 'familiar', label: '熟悉' },
  { threshold: 80, level: 'acquaintance', label: '认识' },
  { threshold: -Infinity, level: 'stranger', label: '陌生' },
]

/** 前后窗口大小（万生玲发言前/后各 N 条） */
export const WINDOW = 5
/** 窗口内每条发言的友好度增量 */
export const PER_MSG_GAIN = 1
/** @ 万生玲的友好度增量 */
export const AT_GAIN = 5
/** 挚友每句能量减免 */
export const BEST_FRIEND_ENERGY_COST = 17   // 挚友每次说话扣除的能量（比普通 10 更积极）

export function createFriendsManager({ log = () => {} } = {}) {
  /** userId -> { value, firstSeen, lastSeen }（跨群共享） */
  const users = new Map()
  /** qqKey -> [{userId, at}] 最近消息窗口（供 feedWindow 结算） */
  const windows = new Map()
  /** qqKey -> Set<userId> 该群全部成员（供 groupTotalAll 精确计算） */
  const groupMemberSets = new Map()
  /** qqKey -> 待结算的发言结算点（万生玲发言后等后5句） */
  const pendingSettles = new Map()

  /** 取用户友好度（不存在则初始 0） */
  function get(userId) {
    return users.get(String(userId))?.value ?? 0
  }

  /** 等级判定 */
  function level(userId) {
    const v = get(userId)
    for (const l of LEVELS) if (v >= l.threshold) return l
    return LEVELS[LEVELS.length - 1]
  }

  /** 记录一条群消息到滚动窗口（保留足够长的历史供前后5句结算） */
  function recordMessage(qqKey, userId) {
    let w = windows.get(qqKey)
    if (!w) { w = []; windows.set(qqKey, w) }
    w.push({ userId: String(userId), at: Date.now() })
    // 保留最近消息（前5 + 后5 + 余量，最多 20 条）
    if (w.length > 20) w.splice(0, w.length - 20)
  }

  /**
   * 万生玲发言时调用：标记结算点（记录当前窗口）。
   * 之后每来一条消息，若距结算点已满 WINDOW 条（后5句到齐），则结算。
   */
  function markReply(qqKey, selfId) {
    const w = windows.get(qqKey)
    if (!w) return
    // 覆盖旧结算点（若上一次还没结算就再次发言，以最新为准）
    pendingSettles.set(qqKey, { baseLength: w.length, selfId })
  }

  /**
   * 结算检查：每条新消息后调用。若距结算点已满 WINDOW 条（后5句到齐），
   * 结算窗口（前5句+后5句共 ≤10 条的发言者 +1），并清除结算点。
   * @returns 本次结算明细 [{userId, gain}]；未到齐返回 []
   */
  function checkSettle(qqKey) {
    const pending = pendingSettles.get(qqKey)
    if (!pending || pending.done) return []
    const w = windows.get(qqKey)
    if (!w) return []
    // 万生玲发言后至今的消息数（后5句进度）
    const after = w.length - pending.baseLength
    if (after < WINDOW) return []  // 后5句未到齐
    const gained = []
    const seen = new Map()
    for (const m of w) {
      if (String(m.userId) === String(pending.selfId)) continue
      seen.set(m.userId, (seen.get(m.userId) || 0) + PER_MSG_GAIN)
    }
    for (const [userId, gain] of seen) {
      add(userId, gain)
      gained.push({ userId, gain })
    }
    pendingSettles.delete(qqKey)  // 结算完成
    return gained
  }

  /** 给某用户加友好度 */
  function add(userId, gain) {
    const id = String(userId)
    let u = users.get(id)
    const now = Date.now()
    if (!u) { u = { value: 0, firstSeen: now, lastSeen: now }; users.set(id, u) }
    u.value += gain
    u.lastSeen = now
    return u.value
  }

  /** @ 万生玲的用户 +5 */
  function boost(userId) {
    return add(userId, AT_GAIN)
  }

  /** 挚友说话能量成本：挚友返回 17，否则 0（非挚友走默认 msgCost） */
  function friendEnergyCost(userId) {
    return level(userId).level === 'best' ? BEST_FRIEND_ENERGY_COST : 0
  }

  /**
   * 生成"与当前说话人的熟悉度"认知（注入 prompt）
   * @param {string} currentUserId 当前发言者（触发本条回复的人）
   */
  function buildContext(qqKey, selfId, currentUserId) {
    if (!currentUserId) return ''
    const v = get(currentUserId)
    const l = level(currentUserId)
    return `（你对当前说话者（${currentUserId}）的友好度为 ${v}，关系判定：${l.label}。${l.label === '挚友' ? '对他可以完全放开，随便开玩笑。' : l.label === '熟悉' ? '对他比较熟，可以开玩笑吐槽。' : l.label === '认识' ? '对他不算熟，保持礼貌距离，别太热情。' : '和他不熟，回复保持简短冷淡，别太热情。'}）`
  }

  /** 某群成员友好度总和（讨论触发判定用，窗口回退） */
  function groupTotal(qqKey) {
    const w = windows.get(qqKey)
    if (!w) return 0
    const ids = new Set(w.map((m) => m.userId))
    let sum = 0
    for (const id of ids) sum += get(id)
    return sum
  }

  /** 记录该群全部成员（同步成员列表后调用，供精确计算总友好度） */
  function setGroupMembers(qqKey, userIds) {
    let set = groupMemberSets.get(qqKey)
    if (!set) { set = new Set(); groupMemberSets.set(qqKey, set) }
    for (const id of userIds) set.add(String(id))
  }

  /** 群成员友好度总和（基于完整成员列表；未同步时回退窗口） */
  function groupTotalAll(qqKey) {
    const set = groupMemberSets.get(qqKey)
    if (!set || !set.size) return groupTotal(qqKey)
    let sum = 0
    for (const id of set) sum += get(id)
    return sum
  }

  /** 等级中文标签 */
  function levelLabel(userId) {
    return level(userId).label
  }

  /** 状态快照（可视化/调试） */
  function stats() {
    const out = {}
    for (const [id, u] of users) out[id] = { value: u.value, level: level(id).label }
    return out
  }

  return { get, level, levelLabel, recordMessage, markReply, checkSettle, boost, add, friendEnergyCost, groupTotal, groupTotalAll, setGroupMembers, buildContext, stats }
}
