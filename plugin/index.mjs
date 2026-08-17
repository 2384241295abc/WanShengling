/**
 * dsh-qq-bridge —— DeepSeek Harness × QQ (OneBot 11) 远程交互桥
 *
 * 方案 A：in-process Cordis 插件（PLAN.md §3.2）。
 * 数据流：QQ 消息 → OneBot WS → 本插件 → ctx.apiProxy.sessions.prompt（异步入队）
 *        → ctx.on('session/event') 流式事件 → 按 step 聚合 → OneBot 发回 QQ。
 *
 * 模块化结构（各模块独立可调/可测，为可视化配置工程铺路）：
 *   config.mjs         配置解析（全局默认/群覆盖/优先级，集中可调项）
 *   persona.mjs        人设与回复风格（当前默认人设：万生玲）
 *   group-config.mjs   群配置管理器（按群覆盖全局默认）
 *   energy.mjs         群聊能量阈值机制（模拟真人"不是每条都回"）
 *   session.mjs        会话管理（cwd 校验/归档重建）
 *   reply-buffer.mjs   回复缓冲队列（流式聚合/分块发送）
 *   handlers.mjs       question/approval 应答
 *   onebot-client.mjs  OneBot 11 WS 客户端
 */

import { randomUUID } from 'node:crypto'
import { OneBotClient } from './onebot-client.mjs'
import { resolveConfig } from './config.mjs'
import { buildPersonaPrompt, ackText } from './persona.mjs'
import { createGroupManager } from './group-config.mjs'
import { createEnergyManager } from './energy.mjs'
import { createSessionManager } from './session.mjs'
import { createReplyBuffer } from './reply-buffer.mjs'
import { createHandlers } from './handlers.mjs'
import { createMembersManager } from './members.mjs'
import { createFriendsManager } from './friend.mjs'
import { createDiscussionManager } from './discussion.mjs'

export const name = 'qq-bridge'
export const inject = ['apiProxy']

/** QQ 会话 → DSH 会话 id（固定命名，重启后复用 Web UI 会话）。 */
export function qqSessionId(messageType, id) {
  return `qq-${messageType}-${id}`
}

/** 判断消息是否 @ 了指定 QQ 号（message 为 OneBot 段数组）。 */
function isAtBot(message, selfId) {
  if (!Array.isArray(message) || !selfId) return false
  return message.some((seg) => seg && seg.type === 'at' && String(seg.data?.qq) === String(selfId))
}

export function apply(ctx, rawConfig = {}) {
  // 1. 配置解析（环境变量 > 补丁 > 默认）
  const config = resolveConfig(rawConfig)

  // 2. 基础设施
  const bot = new OneBotClient({
    url: config.onebotWs,
    token: config.onebotToken,
  })
  const log = (level, ...args) => ctx.logger[level]?.(...args)

  // 3. 模块实例化
  const groups = createGroupManager({
    global: {
      persona: config.persona,
      replyStyle: config.replyStyle,
      allowOutside: config.allowOutside,
      ack: config.ack,
      energy: config.energy,
      workdir: config.workdir,
    },
    groups: config.groups,
    log,
  })
  const energy = createEnergyManager({ energy: config.energy, log })
  const sessions = createSessionManager({
    api: ctx.apiProxy,
    log,
    onRebuild: (qqKey) => {
      // 归档重建：清掉该群旧缓冲，避免旧事件串到新会话
      reply.clear(qqKey)
    },
  })
  const reply = createReplyBuffer({
    sendText: (target, text) => bot.sendText(target, text),
    maxChunkLength: config.maxChunkLength,
    forceFlushMs: config.forceFlushMs,
    log,
  })
  const handlers = createHandlers({
    api: ctx.apiProxy,
    sendText: (target, text) => bot.sendText(target, text),
    autoAnswer: config.autoAnswer,
    log,
  })
  const members = createMembersManager({ log })
  const friends = createFriendsManager({ log })
  const discussion = createDiscussionManager({ energy, log })

  // ---------- QQ → DSH ----------

  /** 机器人自身 QQ 号（从 OneBot meta_event 获取，用于 @ 检测） */
  let selfId = config.selfId || ''
  /** 已同步过成员列表的群（惰性，每群一次） */
  const syncedGroups = new Set()
  /** qqKey -> 群成员数（同步成员列表时记录，供讨论触发判定） */
  const memberCounts = new Map()

  async function onQqMessage(msg) {
    const text = OneBotClient.extractText(msg.message)
    // @ 检测必须在 text 过滤之前：@消息可能只有 @ 段(文本为空)，也要触发回复
    const isAt = selfId ? isAtBot(msg.message, selfId) : false
    if (!text && !isAt) return
    const target = {
      message_type: msg.message_type,          // 'group' | 'private'
      group_id: msg.group_id,
      user_id: msg.user_id,
    }
    const qqKey = qqSessionId(msg.message_type, msg.group_id ?? msg.user_id)
    // 按群配置：人设/风格/工作目录/目录外权限
    const gcfg = groups.get(qqKey)
    const isGroup = msg.message_type === 'group'

    // 群聊：观察成员发言 + 友好度窗口记录 + @加友好度 + 讨论触发检查 + 结算检查
    if (isGroup) {
      members.observe(qqKey, String(msg.user_id ?? '?'), text)
      friends.recordMessage(qqKey, String(msg.user_id ?? '?'))
      discussion.recordActivity(qqKey, String(msg.user_id ?? '?'))
      // 结算检查：万生玲发言后满 5 句 → 结算友好度窗口
      const settled = friends.checkSettle(qqKey)
      if (settled.length) log('info', '[qq-bridge] 友好度结算 %s', JSON.stringify(settled))
      // 惰性同步成员列表（昵称/群名片），每个群首次触发一次
      if (!syncedGroups.has(qqKey)) {
        syncedGroups.add(qqKey)
        void bot.request('get_group_member_list', { group_id: msg.group_id }).then((data) => {
          if (Array.isArray(data)) {
            members.syncGroup(qqKey, data)
            memberCounts.set(qqKey, data.length)
            friends.setGroupMembers(qqKey, data.map((m) => m.user_id))
            // 讨论触发：友好度总和 > 成员数×80，或 2 分钟内发言人数 > 5
            discussion.checkEnter(qqKey, friends.groupTotalAll(qqKey), data.length, discussion.recentSpeakers(qqKey))
          }
        }).catch(() => {})
      } else {
        // 已同步过：每次消息也检查活跃触发（2分钟内>5人）
        discussion.checkEnter(qqKey, friends.groupTotalAll(qqKey), memberCounts.get(qqKey) || 0, discussion.recentSpeakers(qqKey))
      }
      // @ 万生玲的用户友好度 +5
      if (isAt) {
        friends.boost(String(msg.user_id ?? '?'))
        log('info', '[qq-bridge] 用户 %s @万生玲，友好度 +5 → %d', msg.user_id, friends.get(msg.user_id))
      }
    }

    // 群聊能量机制：先记录+扣能量，未达阈值则不回复（像真人不是每条都回）
    if (isGroup && gcfg.energy?.enabled) {
      // 讨论模式退出检查（能量 < -24）
      discussion.checkExit(qqKey)
      // 被 @ 时强制触发（点名就得回），否则正常 feed
      if (isAt) {
        energy.force(qqKey)
      } else {
        // 挚友说话成本：挚友扣 17 能量（比普通 10 更积极），否则默认 msgCost
        const friendCost = friends.friendEnergyCost(String(msg.user_id ?? '?'))
        const cost = friendCost || (gcfg.energy.msgCost ?? 10)
        const triggered = energy.feed(qqKey, String(msg.user_id ?? '?'), text, cost)
        if (!triggered) return
      }
      log('info', '[qq-bridge] 群 %s 触发回复（能量 %d）', qqKey, energy.getEnergy(qqKey))
    }

    try {
      // 会话：cwd 与群配置一致才复用，否则归档重建
      const sessionId = await sessions.ensure(qqKey, gcfg.workdir)

      if (gcfg.ack) {
        await bot.sendText(target, ackText(gcfg)).catch(() => {})
      }

      // 人设注入 + 成员认知 + 群聊上下文 + 权限约束 → prompt 内容块
      const persona = buildPersonaPrompt(gcfg)
      const content = []
      if (persona) content.push({ type: 'text', text: persona })
      // 成员认知：群聊注入（昵称/印象/发言次数）
      if (isGroup) {
        const mctx = members.buildContext(qqKey, selfId)
        if (mctx) content.push({ type: 'text', text: mctx })
        // 讨论环境提示：让万生玲发言更符合"多人讨论"氛围
        const dctx = discussion.getContext(qqKey)
        if (dctx) content.push({ type: 'text', text: dctx })
      }
      // 友好度认知：群聊+私聊都注入 —— 按与对方的熟悉度调整语气
      const fctx = friends.buildContext(qqKey, selfId, String(msg.user_id ?? ''))
      if (fctx) content.push({ type: 'text', text: fctx })
      if (isGroup && gcfg.energy?.enabled) {
        const gctx = energy.getContext(qqKey)
        if (gctx) content.push({ type: 'text', text: gctx })
      }
      // 纯 @ 消息（文本为空）给默认文本，否则 prompt 无用户消息
      content.push({ type: 'text', text: text || '（对方@了你）' })
      const scopeNote = gcfg.allowOutside
        ? `（注意：本会话工作目录为 ${gcfg.workdir}，你可以读取工作目录以外的文件，但写入仍以工作目录为准。）`
        : `（注意：本会话工作目录为 ${gcfg.workdir}，你只能访问此目录内的文件，禁止读写目录外的任何文件。）`
      content.push({ type: 'text', text: scopeNote })

      // 异步入队（accepted 即返回；回复走事件流）。带 rpcId（契约要求）+ 对瞬时拒绝重试。
      let lastErr = null
      for (let attempt = 0; attempt < 3; attempt++) {
        const { result } = await ctx.apiProxy.sessions.prompt({
          rpcId: randomUUID(),
          payload: {
            sessionId, mode: 'queue',
            content,
          },
        })
        if (result.ok) {
          reply.enqueue(sessionId, target)
          log('info', '[qq-bridge] queued "%s" -> %s', text.slice(0, 40), sessionId)
          // 群聊：回复已入队，重置能量（开始下一轮衰减）
          if (isGroup && gcfg.energy?.enabled) {
            if (discussion.isActive(qqKey)) {
              // 讨论模式：每次回复后能量重置 30~60
              discussion.onReply(qqKey)
              log('info', '[qq-bridge] 群 %s 讨论中回复，能量已重置', qqKey)
            } else {
              const e = energy.reset(qqKey)
              log('info', '[qq-bridge] 群 %s 已回复，能量重置为 %d', qqKey, e)
            }
          }
          // 万生玲发言：群聊标记友好度结算点（等后5句到齐后结算）
          if (isGroup) {
            friends.markReply(qqKey, selfId)
          } else {
            // 私聊：回复后对方友好度 +1（聊多了变熟）
            if (msg.user_id) {
              friends.add(String(msg.user_id), 1)
              log('info', '[qq-bridge] 私聊回复，用户 %s 友好度 +1 → %d', msg.user_id, friends.get(msg.user_id))
            }
          }
          return
        }
        lastErr = result.error
        const retryable = lastErr?.code === 'model-unavailable' || lastErr?.code === 'agent-busy' || lastErr?.code === 'session-not-found'
        if (!retryable || attempt === 2) break
        log('warn', '[qq-bridge] prompt %s (attempt %d)，重试…', lastErr?.code, attempt + 1)
        await new Promise((r) => setTimeout(r, 800))
      }
      throw new Error(`${lastErr?.code || 'unknown'}: ${lastErr?.message || JSON.stringify(lastErr) || 'prompt rejected'}`)
    } catch (err) {
      log('warn', '[qq-bridge] prompt failed: %s', err.message)
      await bot.sendText(target, `⚠️ 出错了：${err.message}`).catch(() => {})
    }
  }

  // ---------- DSH → QQ ----------

  async function onSessionEvent(sessionId, event) {
    // 为 question/approval 注入当前条目目标（活跃缓冲）
    const buf = reply.activeBuffer?.(sessionId)
    if ((event.type === 'question/requested' || event.type === 'approval/requested') && buf) {
      event.data = { ...event.data, qqTarget: buf.qqTarget }
    }
    if (event.type === 'question/requested') return handlers.onQuestion(sessionId, event.data)
    if (event.type === 'approval/requested') return handlers.onApproval(sessionId, event.data)
    return reply.onEvent(sessionId, event)
  }

  // ---------- 接线 ----------

  bot.on('meta_event', (ev) => {
    // 记录机器人自身 QQ 号（heartbeat/lifecycle 都带 self_id），供 @ 检测
    if (ev && ev.self_id) selfId = String(ev.self_id)
  })
  bot.on('message', (msg) => { void onQqMessage(msg) })
  bot.on('error', (err) => log('warn', '[qq-bridge] onebot: %s', err.message))
  bot.on('reconnecting', (r) => log('info', '[qq-bridge] 重连中: %j', r))
  bot.connect()

  ctx.on('session/event', (session, event) => {
    void onSessionEvent(session.id, event).catch((err) =>
      log('warn', '[qq-bridge] event: %s', err.message))
  })

  log('info', '[qq-bridge] 已启动，OneBot WS: %s', config.onebotWs)

  // ⚠️ 清理必须通过 apply 的返回值（disposer）注册：Cordis 从不 emit 'dispose'
  // 事件，ctx.on('dispose') 永远不会触发，导致重载时旧实例泄漏（连接累积、
  // 重复处理消息）。返回清理函数由 fiber 卸载时统一调用。
  return () => {
    energy.dispose()
    bot.close()
  }
}
