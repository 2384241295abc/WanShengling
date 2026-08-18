/**
 * members.mjs —— 群成员认知管理
 *
 * 目标：让机器人"认识"群成员 —— 从 QQ 昵称/群名片出发，结合群聊天记录
 * 与群配置（人设）逐步形成对每位成员的画像，并在 prompt 中注入认知，
 * 使万生玲能像真人一样知道"谁是爱开玩笑的""谁总聊游戏"等。
 *
 * 数据结构（每个群）：
 *   groupMembers: Map<qqKey, Map<userId, {
 *     nickname, card, title,       // OneBot get_group_member_info 字段
 *     firstSeen, lastSeen,         // 首次/最近出现时间
 *     msgCount,                    // 发言次数
 *     topics: Map<topic, count>,   // 话题词频（简易画像信号）
 *     traits: string[],            // 推断的性格标签（如"爱开玩笑"）
 *     summary: string,             // 生成的人类可读画像（注入 prompt）
 *   }>>
 *
 * 接口：
 *   createMembersManager({ log })
 *     → syncGroup(qqKey, members)    同步成员列表（昵称/名片等）
 *     → observe(qqKey, userId, text) 观察一条消息（更新话题/次数/画像）
 *     → buildContext(qqKey, selfId)  生成注入 prompt 的"成员认知"文本
 *     → stats()                      状态快照（可视化）
 */

'use strict'

/** 简易话题关键词 → 画像标签（可扩展） */
const TOPIC_TAGS = [
  { keys: ['游戏', '原神', '王者', 'lol', 'steam', '打游戏', '机'], tag: '爱聊游戏' },
  { keys: ['塔罗', '占星', '星座', '神秘'], tag: '对神秘学感兴趣' },
  { keys: ['吃', '饭', '食堂', '外卖', '好吃'], tag: '常聊吃喝' },
  { keys: ['工作', '上班', '加班', '老板'], tag: '聊工作' },
  { keys: ['作业', '考试', '上课', '老师', '论文'], tag: '聊学业' },
  { keys: ['哈哈', '笑死', '哈哈哈', '笑'], tag: '爱笑爱玩梗' },
  { keys: ['谢谢', '感谢'], tag: '客气有礼貌' },
]

/** 从文本中提取话题标签（简易） */
function topicTags(text) {
  const tags = []
  for (const t of TOPIC_TAGS) {
    if (t.keys.some((k) => text.includes(k)) && !tags.includes(t.tag)) tags.push(t.tag)
  }
  return tags
}

/** 从昵称/名片推断的静态标签 */
function nameTags(nickname, card) {
  const tags = []
  const all = `${nickname || ''} ${card || ''}`
  if (/杰斯顿|彩六|r6/.test(all)) tags.push('玩彩六')
  if (/音乐|♪|♬/.test(all)) tags.push('喜欢音乐')
  return tags
}

export function createMembersManager({ log = () => {} } = {}) {
  /** qqKey -> Map<userId, member> */
  const groups = new Map()

  function group(qqKey) {
    let g = groups.get(qqKey)
    if (!g) { g = new Map(); groups.set(qqKey, g) }
    return g
  }

  /** 同步成员列表（OneBot get_group_member_list 结果） */
  function syncGroup(qqKey, members = []) {
    const g = group(qqKey)
    const now = Date.now()
    for (const m of members) {
      const id = String(m.user_id)
      let mem = g.get(id)
      if (!mem) {
        mem = { userId: id, nickname: '', card: '', title: '', firstSeen: now, lastSeen: now, msgCount: 0, topics: new Map(), traits: [], summary: '' }
        g.set(id, mem)
      }
      mem.nickname = m.nickname || mem.nickname   // 优先用户昵称；空串也能被真实值覆盖（不只吞 null）
      mem.card = m.card || mem.card
      mem.title = m.title || mem.title
      // 合并静态标签（昵称/名片推断）
      for (const t of nameTags(mem.nickname, mem.card)) if (!mem.traits.includes(t)) mem.traits.push(t)
    }
    // 移除已不在列表的成员（可选，暂不实现）
    return g.size
  }

  /** 观察一条消息：更新发言次数、话题、画像 */
  function observe(qqKey, userId, text) {
    const g = group(qqKey)
    const id = String(userId)
    let mem = g.get(id)
    if (!mem) {
      mem = { userId: id, nickname: '', card: '', title: '', firstSeen: Date.now(), lastSeen: Date.now(), msgCount: 0, topics: new Map(), traits: [], summary: '' }
      g.set(id, mem)
    }
    mem.lastSeen = Date.now()
    mem.msgCount++
    const tags = topicTags(text)
    for (const tag of tags) {
      if (!mem.traits.includes(tag)) mem.traits.push(tag)
      mem.topics.set(tag, (mem.topics.get(tag) || 0) + 1)
    }
  }

  /** 选称呼：优先 QQ 昵称（nickname），名片仅作补充信息 */
  function displayName(mem) {
    return mem.nickname || mem.card || mem.userId
  }

  /** 按群取某成员显示名（QQ号已同步时）；未知成员用 QQ 号本身 */
  function nameOf(qqKey, userId) {
    const g = groups.get(qqKey)
    const id = String(userId)
    const mem = g && g.get(id)
    return mem ? displayName(mem) : String(userId)
  }

  /** 生成某群成员认知文本（注入 prompt） */
  function buildContext(qqKey, selfId = '', maxMembers = 15) {
    const g = groups.get(qqKey)
    if (!g || !g.size) return ''
    // 只注入"活跃成员"（说过话的），并按发言次数降序；避免大群刷爆上下文
    const active = [...g.values()]
      .filter((m) => String(m.userId) !== String(selfId) && m.msgCount > 0)
      .sort((a, b) => b.msgCount - a.msgCount)
      .slice(0, maxMembers)
    if (!active.length) return ''
    const lines = active.map((mem) => {
      const name = displayName(mem)
      const parts = [`说过${mem.msgCount}次话`]
      if (mem.traits.length) parts.push(`印象:${mem.traits.slice(0, 3).join('、')}`)
      const extra = mem.card && mem.card !== name ? `（群名片:${mem.card}）` : ''
      return `${name}${extra}: ${parts.join('，')}`
    })
    return `（本群成员认知：${lines.join('；')}。与人对话时自然地知道对方是谁，不用反复确认。）`
  }

  /** 状态快照（可视化/调试） */
  function stats() {
    const out = {}
    for (const [qqKey, g] of groups) {
      out[qqKey] = [...g.values()].map((m) => ({ userId: m.userId, name: displayName(m), msgCount: m.msgCount, traits: m.traits }))
    }
    return out
  }

  return { syncGroup, observe, buildContext, stats, nameOf }
}
