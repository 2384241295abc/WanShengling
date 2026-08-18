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
 *   - 等级：0~1 陌生 | 2~160 认识 | 160~240 熟悉 | >240 挚友
 *   - 挚友：每句话减少 7 能量
 *   - Solo"点名"模式：群内有人 @ 万生玲 → 该群进入 solo，记录发起人；
 *     万生玲回复后能量设为 10（加快回复节奏陪发起人）；
 *     当发起人友好度超过 soloIdleMs（默认 60s）无上升 → 退出 solo。
 *
 * 接口：
 *   createFriendsManager({ log })
 *     → feedWindow(qqKey, userId)    万生玲发言时调用，结算前后5句窗口内成员 +1
 *     → recordMessage(qqKey, userId) 记录一条消息到窗口（供 feedWindow 用）
 *     → boost(qqKey, userId)         @ 万生玲的用户 +5
 *     → enterSolo(qqKey, userId)     @ 触发：该群进入 solo 并记录发起人（重复@即刷新）
 *     → isSolo(qqKey)                该群当前是否 solo
 *     → checkSolosExpiry(now?)       清理超时未上升的 solo；返回退出的 qqKey[]（定时器调用）
 *     → get(userId)                  取用户友好度
 *     → level(userId)                取等级（'stranger'|'acquaintance'|'familiar'|'best'）
 *     → friendEnergyBonus(userId)    挚友能量减免（挚友返回 7，否则 0）
 *     → groupTotal(qqKey)            某群成员友好度总和
 *     → stats()                      状态快照（可视化）
 *     → dispose()                    触发最终保存并清理持久化定时器（必须由 apply disposer 调用）
 *
 * 持久化：将 users Map（友好度）落盘到 persistPath（默认 ~/.dsh/qq-bridge-friendly.json），
 * 启动时同步恢复、add/boost 后防抖保存（默认每 10s），dispose 时最终保存。
 * 这样重启 3080 后友好度不丢，查询命令能返回历史累积值。
 */

'use strict'

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** 等级阈值 */
export const LEVELS = [
  { threshold: 240, level: 'best', label: '挚友' },
  { threshold: 160, level: 'familiar', label: '熟悉' },
  { threshold: 2, level: 'acquaintance', label: '认识' },
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
/** solo 超时：发起人友好度超过该毫秒数未上升则退出 solo */
export const SOLO_IDLE_MS = 60 * 1000
/** 默认持久化文件（DSH 用户数据目录） */
export const DEFAULT_PERSIST_PATH = `${process.env.HOME || '/tmp'}/.dsh/qq-bridge-friendly.json`
/** 持久化保存节流间隔（毫秒） */
const PERSIST_DEBOUNCE_MS = 10 * 1000
/** 持久化格式版本（便于未来迁移 schema） */
const PERSIST_VERSION = 1

export function createFriendsManager({ log = () => {}, soloIdleMs = SOLO_IDLE_MS, persistPath = DEFAULT_PERSIST_PATH } = {}) {
  /** userId -> { value, firstSeen, lastSeen }（跨群共享） */
  const users = new Map()
  /** qqKey -> [{userId, at}] 最近消息窗口（供 feedWindow 结算） */
  const windows = new Map()
  /** qqKey -> Set<userId> 该群全部成员（供 groupTotalAll 精确计算） */
  const groupMemberSets = new Map()
  /** qqKey -> 待结算的发言结算点（万生玲发言后等后5句） */
  const pendingSettles = new Map()
  /** qqKey -> { userId, lastGainAt } solo 状态（@ 触发，见 enterSolo） */
  const solos = new Map()
  /** solo 超时（毫秒）：发起人友好度超过该时长未上升则退出（可配置覆盖） */
  const idleMs = soloIdleMs > 0 ? soloIdleMs : SOLO_IDLE_MS

  // ---------- 持久化（友好度 users Map） ----------
  let persistTimer = null
  let persistDirty = false

  /** 重新读取持久化数据（构造时调用一次；失败静默忽略，视为无历史） */
  function loadPersisted() {
    if (!persistPath) return
    try {
      const raw = readFileSync(persistPath, 'utf8')
      const data = JSON.parse(raw)
      if (data?.version === PERSIST_VERSION || !data?.version) {
        for (const [id, u] of Object.entries(data?.users || {})) {
          if (typeof u?.value === 'number') users.set(String(id), { value: u.value, firstSeen: u.firstSeen ?? Date.now(), lastSeen: u.lastSeen ?? Date.now() })
        }
        log('info', '[qq-bridge] 友好度已从 %s 恢复 %d 位用户', persistPath, users.size)
      }
    } catch { /* 无历史文件或损坏：从空开始 */ }
  }

  /** 立即把 users 落盘（写入临时文件后替换，避免写坏） */
  function savePersisted() {
    if (!persistPath) return
    try {
      mkdirSync(dirname(persistPath), { recursive: true })
      const payload = JSON.stringify({ version: PERSIST_VERSION, savedAt: Date.now(), users: Object.fromEntries([...users].map(([id, u]) => [id, u])) })
      const tmp = `${persistPath}.tmp`
      writeFileSync(tmp, payload, 'utf8')
      renameSync(tmp, persistPath)
      persistDirty = false
    } catch (err) { log('warn', '[qq-bridge] 友好度持久化失败: %s', err?.message || err) }
  }

  /** 防抖调度保存（add/boost 等变更后调用） */
  function markPersist() {
    if (!persistPath) return
    persistDirty = true
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      if (persistDirty) {
        savePersisted()
        log('debug', '[qq-bridge] 友好度已定期落盘')
      }
    }, PERSIST_DEBOUNCE_MS)
  }

  /** 释放：清空持久化定时器并做最终保存（必须由 apply disposer 调用，防 HMR 泄漏） */
  function dispose() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
    if (persistDirty) savePersisted()
  }

  // 构造时恢复历史友好度
  loadPersisted()

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

  /**
   * 记录一条群消息到滚动窗口。
   * 每条消息带单调递增 seq（不随窗口 splice 位移），供结算时精确定位"前后各5句"。
   */
  function recordMessage(qqKey, userId) {
    let w = windows.get(qqKey)
    if (!w) {
      w = { seq: 0, list: [] }
      windows.set(qqKey, w)
    }
    w.list.push({ userId: String(userId), at: Date.now(), seq: ++w.seq })
    // 保留足够长的历史（供 ±5 结算），最多 20 条
    if (w.list.length > 20) w.list.splice(0, w.list.length - 20)
  }

  /**
   * 万生玲发言时调用：入队一个结算点（记录万生玲那条的 seq）。
   * 允许连续发言时多个结算点排队（不再覆盖丢弃），按序分别结算。
   */
  function markReply(qqKey, selfId) {
    const w = windows.get(qqKey)
    if (!w) return
    const point = { seq: w.seq, selfId, done: false }
    const q = pendingSettles.get(qqKey)
    if (q) q.push(point); else pendingSettles.set(qqKey, [point])
  }

  /**
   * 结算检查：每条新消息后调用。对每个已满足"发言后满 WINDOW 句"的结算点，
   * 只统计该点前后各 WINDOW 条（seq ∈ [seq-WINDOW, seq+WINDOW]）内、非万生玲自己的发言者 +1。
   * @returns {Array<{userId,gain}>} 本次所有待结算点合并的明细；无则 []
   */
  function checkSettle(qqKey) {
    const q = pendingSettles.get(qqKey)
    if (!q || !q.length) return []
    const w = windows.get(qqKey)
    if (!w || !w.list.length) return []
    const latestSeq = w.seq
    const results = []
    let settledSome = false
    // 从最旧的结算点开始，满足条件的逐个结算
    for (const p of q) {
      if (p.done) continue
      if (latestSeq - p.seq < WINDOW) continue  // 后5句未到齐
      const lo = p.seq - WINDOW
      const hi = p.seq + WINDOW
      const seen = new Map()
      for (const m of w.list) {
        if (m.seq < lo || m.seq > hi) continue      // 限定 ±5 窗口（修复范围外旧消息算入）
        if (String(m.userId) === String(p.selfId)) continue // 排除万生玲自己
        seen.set(m.userId, (seen.get(m.userId) || 0) + PER_MSG_GAIN)
      }
      for (const [userId, gain] of seen) {
        add(userId, gain, qqKey)   // 结算发生在该群 → solo 续期仅限该群
        results.push({ userId, gain })
      }
      p.done = true
      settledSome = true
    }
    if (settledSome) {
      // 只移除已结算的点，保留尚未到齐的结算点等后续消息（防误删丢结算）
      pendingSettles.set(qqKey, q.filter((p) => !p.done))
    }
    return results
  }

  /** 给某用户加友好度；qqKey 存在时 solo 续期仅限该群（同群互动才续命，防跨群/私聊误续） */
  function add(userId, gain, qqKey) {
    const id = String(userId)
    let u = users.get(id)
    const now = Date.now()
    if (!u) { u = { value: 0, firstSeen: now, lastSeen: now }; users.set(id, u) }
    u.value += gain
    u.lastSeen = now
    // solo 续期：仅当增益发生在该群（qqKey）且该用户是其 solo 发起人时才刷新。
    // 私聊/其他群的友好度增长不会给此群 solo 续命 —— 否则活跃用户(如 23012321)
    // 的 solo 会被处处续期而永不退出。
    if (gain > 0 && qqKey) {
      const s = solos.get(qqKey)
      if (s && s.userId === id) s.lastGainAt = now
    }
    // 友好度有实际变化 → 触发防抖落盘
    if (gain !== 0) markPersist()
    return u.value
  }

  /** @ 万生玲的用户 +5（qqKey=所在群，用于 solo 续期限定） */
  function boost(userId, qqKey) {
    return add(userId, AT_GAIN, qqKey)
  }

  /** @ 触发：该群进入 solo 并（重新）记录发起人。重复 @ 即切换到最新发起人 */
  function enterSolo(qqKey, userId) {
    const id = String(userId)
    const now = Date.now()
    solos.set(qqKey, { userId: id, lastGainAt: now })
    log('info', '[qq-bridge] 群 %s 进入 solo，发起人 %s，能量回复节奏加快', qqKey, id)
  }

  /** 该群当前是否处于 solo 状态 */
  function isSolo(qqKey) {
    return solos.has(qqKey)
  }

  /**
   * 清理 solo：对每个处于 solo 的群，若发起人友好度超过 SOLO_IDLE_MS
   * （默认 60 秒）没有上升，则退出 solo。由外部定时器/消息驱动调用。
   * @returns {string[]} 本次退出 solo 的 qqKey 列表
   */
  function checkSolosExpiry(now = Date.now()) {
    const expired = []
    for (const [qqKey, s] of solos) {
      if (now - s.lastGainAt > idleMs) {
        solos.delete(qqKey)
        expired.push(qqKey)
        log('info', '[qq-bridge] 群 %s 退出 solo（发起人友好度超时未上升）', qqKey)
      }
    }
    return expired
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
    // 只报关系信息，不给语气指令（语气由人设决定——v5.0 树洞型对谁都温和，不再按熟悉度"冷淡/热情"）
    return `（你与 ${currentUserId} 的友好度为 ${v}，关系：${l.label}。）`
  }

  /** 某群成员友好度总和（讨论触发判定用，窗口回退） */
  function groupTotal(qqKey) {
    const w = windows.get(qqKey)
    if (!w) return 0
    const ids = new Set((w.list || []).map((m) => m.userId))
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

  return { get, level, levelLabel, recordMessage, markReply, checkSettle, boost, add, friendEnergyCost, groupTotal, groupTotalAll, setGroupMembers, buildContext, stats, enterSolo, isSolo, checkSolosExpiry, dispose }
}
