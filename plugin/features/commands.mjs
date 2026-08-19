/**
 * features/commands.mjs —— 指令插件（/友好度、/清除缓存）
 *
 * 指令统一 `/` 前缀；无前缀的相同文本按普通聊天处理。
 * 依赖（deps）：{ bot, groups, members, friends, config, log }
 */

'use strict'

import { clearChatOlderThanWeek } from '../memory.mjs'

export function createCommandsFeature(deps) {
  const { bot, groups, members, friends, energy, discussion, config, log } = deps

  /** /友好度 或 /友好度 <群号>：直接读内存状态，不走 DSH 代理 */
  async function handleFriendliness(fullText, msg, target, qqKey, isGroup, allowWork) {
    const m = /^\/\s*友好度\s*(\d+)?\s*$/.exec(fullText || '')
    if (!m) return false
    if (!allowWork) {
      log('info', '[qq-bridge] 用户 %s 无权限查询友好度(已拒绝)', msg.user_id)
      await bot.sendText(target, '⚠️ 你没有使用工作指令的权限').catch(() => {})
      return true
    }
    let targetGroupId = m[1]
    if (!targetGroupId) {
      if (!isGroup) {
        await bot.sendText(target, '⚠️ 私聊请带群号：/友好度 859762634').catch(() => {})
        return true
      }
      targetGroupId = String(msg.group_id)
    }
    const targetQqKey = qqSessionIdFor(targetGroupId)
    const mstats = (members.stats?.()[targetQqKey] || [])
    // 该群成员未同步时实时拉取一次
    if (!mstats.length) {
      try {
        const data = await bot.request('get_group_member_list', { group_id: targetGroupId })
        if (Array.isArray(data)) members.syncGroup(targetQqKey, data)
      } catch { /* 拉取失败则回退已有缓存 */ }
    }
    const rows = new Map()
    for (const mem of mstats) {
      rows.set(String(mem.userId), { userId: String(mem.userId), name: mem.name || String(mem.userId), msgCount: mem.msgCount || 0 })
    }
    if (!rows.size) {
      await bot.sendText(target, `该群（${targetGroupId}）暂无成员数据（可能是命令在小群/未同步，稍后再试）。`).catch(() => {})
      return true
    }
    const lines = [...rows.values()].map(({ userId, name }) => {
      const val = friends.get(userId)
      const lv = friends.levelLabel(userId)
      return `${name}：友好度 ${val}（${lv}）`
    }).sort((a, b) => {
      const va = Number(/(?:友好度 )(-?\d+)/.exec(a)?.[1] ?? -1)
      const vb = Number(/(?:友好度 )(-?\d+)/.exec(b)?.[1] ?? -1)
      return vb - va
    })
    const body = `📊 群 ${targetGroupId} 友好度（${lines.length}人）:\n` + lines.join('\n')
    log('info', '[qq-bridge] 查询友好度 群=%s 人数=%d', targetGroupId, lines.length)
    await bot.sendText(target, body).catch(() => {})
    return true
  }

  function qqSessionIdFor(id) {
    return `qq-group-${id}`
  }

  /** /能量 或 /能量 <群号>：查该群能量/冷却/讨论/solo 状态（维护用，读内存不走 DSH 代理） */
  async function handleEnergy(fullText, msg, target, isGroup, allowWork) {
    const m = /^\/\s*能量\s*(\d+)?\s*$/.exec(fullText || '')
    if (!m) return false
    if (!allowWork) {
      log('info', '[qq-bridge] 用户 %s 无权限查询能量(已拒绝)', msg.user_id)
      await bot.sendText(target, '⚠️ 你没有使用工作指令的权限').catch(() => {})
      return true
    }
    let targetGroupId = m[1]
    if (!targetGroupId) {
      if (!isGroup) {
        await bot.sendText(target, '⚠️ 私聊请带群号：/能量 859762634').catch(() => {})
        return true
      }
      targetGroupId = String(msg.group_id)
    }
    const gk = qqSessionIdFor(targetGroupId)
    const e = energy.getEnergy(gk)
    if (e === undefined) {
      await bot.sendText(target, `该群（${targetGroupId}）暂无能量数据（群内还没有消息进入能量闸）。`).catch(() => {})
      return true
    }
    const cdMs = energy.cooldownRemainingMs(gk)
    const cd = cdMs > 0 ? `是（剩 ${Math.ceil(cdMs / 1000)}s）` : '否'
    const histLen = energy.stats?.()?.[gk]?.historyLen ?? 0
    const body = [
      `⚡ 群 ${targetGroupId} 能量状态`,
      `能量: ${Math.round(e)}`,
      `冷却: ${cd}`,
      `讨论: ${discussion.isActive(gk) ? '是' : '否'}`,
      `solo: ${friends.isSolo(gk) ? '是' : '否'}`,
      `历史: ${histLen} 条`,
    ].join('\n')
    log('info', '[qq-bridge] 查询能量 群=%s 能量=%d 冷却=%dms 讨论=%s', targetGroupId, e, cdMs, discussion.isActive(gk))
    await bot.sendText(target, body).catch(() => {})
    return true
  }

  return {
    name: 'commands',

    /** onMessage：处理 /友好度、/能量、/清除缓存；返回 true=已处理 */
    async onMessage(ctx) {
      const { msg, text, target, qqKey, isGroup, allowWork } = ctx

      // /友好度 或 /友好度 <群号>
      if (await handleFriendliness(text, msg, target, qqKey, isGroup, allowWork)) return true

      // /能量 或 /能量 <群号>
      if (await handleEnergy(text, msg, target, isGroup, allowWork)) return true

      // /清除缓存：白名单用户执行，清除全部群一周前的聊天记录
      if (allowWork && text === `/${config.clearCommand}`) {
        let total = 0
        for (const [gqk, cfg] of Object.entries(groups.list())) {
          if (!gqk.startsWith('qq-group-') || !cfg?.workdir) continue
          total += await clearChatOlderThanWeek(cfg.workdir)
        }
        await bot.sendText(target, `🗑️ 已清除全部群共 ${total} 条一周前的聊天记录（保留最近一周）。`).catch(() => {})
        return true
      }
      return false
    },
  }
}
