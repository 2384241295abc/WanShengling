/**
 * dsh-qq-bridge —— DeepSeek Harness × QQ (OneBot 11) 远程交互桥
 *
 * 方案 A：in-process Cordis 插件（PLAN.md §3.2）。
 * 数据流：QQ 消息 → OneBot WS → 本插件 → ctx.apiProxy.sessions.prompt（异步入队）
 *        → ctx.on('session/event') 流式事件 → 按 step 聚合 → OneBot 发回 QQ。
 *
 * 模块化结构（各模块独立可调/可测，为可视化配置工程铺路）：
 *   config.mjs         配置解析（全局默认/群覆盖/优先级，集中可调项）
 *   persona.mjs        人设与回复风格（当前默认人设：机器人）
 *   group-config.mjs   群配置管理器（按群覆盖全局默认）
 *   energy.mjs         群聊能量阈值机制（模拟真人"不是每条都回"）
 *   session.mjs        会话管理（cwd 校验/归档重建）
 *   reply-buffer.mjs   回复缓冲队列（流式聚合/分块发送）
 *   handlers.mjs       question/approval 应答
 *   onebot-client.mjs  OneBot 11 WS 客户端
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
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
import { extractImages, setVisionDebugFile } from './vision.mjs'
import { appendChat, memoryInstruction, chatLine } from './memory.mjs'
import { createFeatureRegistry } from './registry.mjs'
import { createVisionFeature } from './features/vision.mjs'
import { createCommandsFeature } from './features/commands.mjs'

export const name = 'qq-bridge'
export const inject = ['apiProxy']

/** 回复冷却默认时长（毫秒；energy.cooldownMs 覆盖） */
const DEFAULT_COOLDOWN_MS = 15000

/**
 * 模块级「上一个 runtime」引用（进程内唯一，跨 HMR/apply 共享）。
 * 🔴 迭代自动清理：每次新的 apply() 到来时，主动 dispose 上一个 runtime
 * （关连接/清定时器/清缓冲），不等 Cordis 调旧 disposer（它不保证调用）。
 * 这样版本迭代时旧实例资源被真正释放，而非仅靠 active 封堵。
 */
let prevRuntime = null

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

  // 🔴 迭代自动清理：新 apply 到来时，主动释放上一个 runtime 的全部资源
  //（关连接/清定时器/清 cooldown/solo interval/各 manager），避免旧的残留
  if (prevRuntime) {
    try { prevRuntime.dispose(); prevRuntime = null } catch (err) {
      const _log = (lv, ...a) => ctx.logger?.[lv]?.(...a)
      _log('warn', '[qq-bridge] 清理上一个 runtime 失败: %s', err?.message || err)
    }
  }

  // 图片调试日志（~/bin/.dsh/qq-bridge-vision.log，排查 saveImage 失败用）
  setVisionDebugFile(join(homedir(), '.dsh', 'qq-bridge-vision.log'))

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
  const members = createMembersManager({ log })
  const energy = createEnergyManager({
    energy: config.energy,
    log,
    // 上下文里把 QQ 号解析成可读昵称（members 已同步时）
    resolveName: (userId, qqKey) => members.nameOf(qqKey, userId),
    botName: config.botName,
  })
  const sessions = createSessionManager({
    api: ctx.apiProxy,
    log,
    onRebuild: (qqKey) => {
      // 归档重建：清掉该群旧缓冲，避免旧事件串到新会话
      reply.clear(qqKey)
    },
  })
  // 好友度/档案管理（先于插件注册，features 需要它；顺序即依赖顺序）
  const friends = createFriendsManager({ log, soloIdleMs: config.energy?.soloIdleMs })
  // 插件宿主：注册中心 + 内置插件（识图/指令），后续功能可继续在此 register
  const features = createFeatureRegistry()
  const visionFeature = createVisionFeature({ bot, config, groups, energy, friends, members, sessions, log })
  features.register(visionFeature)
  features.register(createCommandsFeature({ bot, groups, members, friends, config, log }))

  const reply = createReplyBuffer({
    sendText: (target, text) => bot.sendText(target, text),
    maxChunkLength: config.maxChunkLength,
    forceFlushMs: config.forceFlushMs,
    log,
    // 机器人回复发出后回灌到该群聊天历史（供下一轮自省衔接，不扣能量）
    onReply: ({ target, text }) => {
      if (config.energy?.enabled && target?.message_type === 'group' && target.group_id && text) {
        const gk = qqSessionId('group', target.group_id)
        energy.recordBotReply(gk, text)
        // 文件记忆：机器人回复写入该群 chatlog.md
        if (config.memoryEnabled) {
          const wd = groups.get(gk)?.workdir
          if (wd) void appendChat(wd, chatLine(config.botName || '我', text))
        }
      }
      // 插件回复钩子
      void features.runOnReply(target, text)
    },
  })
  const handlers = createHandlers({
    api: ctx.apiProxy,
    sendText: (target, text) => bot.sendText(target, text),
    autoAnswer: config.autoAnswer,
    log,
  })
  const discussion = createDiscussionManager({ energy, log })
  // ---------- QQ → DSH ----------

  /** 机器人自身 QQ 号（从 OneBot meta_event 获取，用于 @ 检测） */
  let selfId = config.selfId || ''
  /** 已同步过成员列表的群（惰性，每群一次） */
  const syncedGroups = new Set()
  /** qqKey -> 群成员数（同步成员列表时记录，供讨论触发判定） */
  const memberCounts = new Map()

  /**
   * 异步入队（accepted 即返回；回复走事件流）。带 rpcId（契约要求）+ 对瞬时拒绝重试。
   * @returns {Promise<void>} 入队成功；否则抛错
   */
  async function promptQueue(sessionId, content, target, label, opts = {}) {
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
        if (!opts.silent) reply.enqueue(sessionId, target)   // silent：后台任务（如档案更新）不回 QQ
        log('info', '[qq-bridge] queued "%s" -> %s', label.slice(0, 40), sessionId)
        return
      }
      lastErr = result.error
      const retryable = lastErr?.code === 'model-unavailable' || lastErr?.code === 'agent-busy' || lastErr?.code === 'session-not-found'
      if (!retryable || attempt === 2) break
      log('warn', '[qq-bridge] prompt %s (attempt %d)，重试…', lastErr?.code, attempt + 1)
      await new Promise((r) => setTimeout(r, 800))
    }
    throw new Error(`${lastErr?.code || 'unknown'}: ${lastErr?.message || JSON.stringify(lastErr) || 'prompt rejected'}`)
  }

  // ---------- 回复冷却(cooldown)定时器 ----------
  /** qqKey -> setTimeout 句柄（冷却到期触发回复用；disposer 需清理） */
  const cooldownTimers = new Map()

  // 🔒 per-群消息串行队列：同群消息严格按到达顺序处理。
  // 此前 bot.on('message') 对每条消息 fire-and-forget 并发处理，导致两个竞态 bug：
  //  ① 冷却失效：消息 A 触发回复后 startCooldown 在 promptQueue await 之后才设置，
  //     期间到达的消息 B 读到 inCooldown=false → 绕过冷却连续回复；
  //  ② 图片误删：消息 B 纯图 register 落在消息 A 回合内，A 的 turn/end cleanup 误删 B 的图。
  // 串行化后：前一条消息(含 startCooldown/registerImages)完成后才处理下一条，两个竞态一并消除。
  const msgQueues = new Map()

  /** 按 qqKey 入队并返回串行 Promise 链（key: 群号 或 私聊 p<user_id>） */
  function enqueueMsg(key, fn) {
    const prev = msgQueues.get(key) || Promise.resolve()
    const next = prev
      .then(fn)
      .catch((err) => log('warn', '[qq-bridge] 消息处理异常: %s', err?.message))
    msgQueues.set(key, next)
    return next
  }

  /** 进入冷却并安排到期回调：冷却期有积累的新消息时，到期后主动触发一次回复（依据=冷却期聊天记录） */
  function startCooldown(qqKey, groupId) {
    const cdMs = config.energy?.cooldownMs ?? DEFAULT_COOLDOWN_MS
    energy.beginCooldown(qqKey, cdMs)
    clearCooldownTimer(qqKey)
    const timer = setTimeout(() => {
      cooldownTimers.delete(qqKey)
      // 到期：解除锁定、恢复能量；若有冷却期积累消息 → 主动回一条
      const res = energy.cooldownExpired(qqKey)
      if (res?.expired && res?.hasPending && config.energy?.enabled) {
        void replyFromCooldown(qqKey, String(groupId)).catch((err) =>
          log('warn', '[qq-bridge] 冷却后自动回复失败: %s', err?.message))
      }
    }, cdMs)
    cooldownTimers.set(qqKey, timer)
  }

  function clearCooldownTimer(qqKey) {
    const t = cooldownTimers.get(qqKey)
    if (t) { clearTimeout(t); cooldownTimers.delete(qqKey) }
  }

  // ---------- 后台状态查询：周期落盘 ~/.dsh/qq-bridge-energy.json（cat 即可查看） ----------
  const statusFile = join(homedir(), '.dsh', 'qq-bridge-energy.json')
  function writeStatus() {
    try {
      const groups = {}
      for (const [qqKey, st] of Object.entries(energy.stats())) {
        groups[qqKey] = {
          energy: st.energy,
          historyLen: st.historyLen,
          cooldown: energy.inCooldown(qqKey),
          solo: friends.isSolo(qqKey),
          discussion: discussion.isActive(qqKey),
        }
      }
      const tmp = statusFile + '.tmp'
      writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), groups }, null, 2))
      renameSync(tmp, statusFile)
    } catch (e) { log('warn', '[qq-bridge] 状态落盘失败: %s', e.message) }
  }
  const statusTimer = setInterval(writeStatus, 30000)
  writeStatus()

  /**
   * 冷却到期、且期间有新消息时：基于「冷却期聊天记录 + 最新消息」主动回一条。
   * 复用 onQqMessage 的 prompt 构建思路，但不重跑观察/记录/结算副作用（防止重复计数）。
   */
  async function replyFromCooldown(qqKey, groupId) {
    const gcfg = groups.get(qqKey)
    if (!gcfg?.energy?.enabled) return
    // 会话：cwd 与群配置一致才复用
    const sessionId = await sessions.ensure(qqKey, gcfg.workdir)
    const content = []
    const persona = buildPersonaPrompt(gcfg)
    if (persona) content.push({ type: 'text', text: persona })
    const dctx = discussion.getContext(qqKey)
    if (dctx) content.push({ type: 'text', text: dctx })
    if (config.memoryEnabled) {
      content.push({ type: 'text', text: memoryInstruction(gcfg.workdir) })
    } else {
      const mctx = members.buildContext(qqKey, selfId)
      if (mctx) content.push({ type: 'text', text: mctx })
      const gctx = energy.getContext(qqKey, true)   // 省略"当前"这条仅剩历史，冷却期消息已在历史里
      if (gctx) content.push({ type: 'text', text: gctx })
    }
    // 🔒 冷却期可能有纯图消息（占位文本含图片路径）：从 energy 历史提取并注入图片提示，
    //    否则 memoryEnabled 模式下模型只读 chatlog（纯图记录无路径）→ 不知道有图 → 臆想"打不开"
    const imgHint = energy.pendingImageHint?.(qqKey)
    if (imgHint) content.push({ type: 'text', text: imgHint })
    content.push({ type: 'text', text: '（刚刚有人说话了，自然接一句。）' })
    const scopeNote = gcfg.allowOutside
      ? `（注意：本会话工作目录为 ${gcfg.workdir}，你可以读取工作目录以外的文件，但写入仍以工作目录为准。）`
      : `（注意：本会话工作目录为 ${gcfg.workdir}，你只能访问此目录内的文件，禁止读写目录外的任何文件。）`
    content.push({ type: 'text', text: scopeNote })
    const target = { message_type: 'group', group_id: Number(groupId), user_id: 0 }
    await promptQueue(sessionId, content, target, '冷却后自动回复')
    friends.markReply(qqKey, selfId)
  }

  async function onQqMessage(msg) {
    let text = OneBotClient.extractText(msg.message)   // let：solo 纯图分支会改写为占位文本
    // @ 检测必须在 text 过滤之前：@消息可能只有 @ 段(文本为空)，也要触发回复
    const isAt = selfId ? isAtBot(msg.message, selfId) : false
    // 图片段（表情包也是 image 段；face 系统表情不在此列，直接丢弃）
    const imageSegs = extractImages(msg.message)
    const hasImage = imageSegs.length > 0
    if (!text && !isAt && !hasImage) return
    const target = {
      message_type: msg.message_type,          // 'group' | 'private'
      group_id: msg.group_id,
      user_id: msg.user_id,
    }
    const qqKey = qqSessionId(msg.message_type, msg.group_id ?? msg.user_id)
    // 按群配置：人设/风格/工作目录/目录外权限
    const gcfg = groups.get(qqKey)
    const isGroup = msg.message_type === 'group'
    // 工作指令白名单：空=全部允许；非空=仅列表内用户可用（其他用户只聊天，禁文件访问）
    const allowWork = !config.workUsers?.length || config.workUsers.includes(String(msg.user_id ?? ''))

    // 插件消息钩子（指令/纯图等）：任一插件返回 true 即拦截
    const ctx = { msg, text, isAt, imageSegs, hasImage, target, qqKey, gcfg, isGroup, allowWork,
                  pendingImagePaths: [], soloImageTrigger: false }
    if (await features.runOnMessage(ctx)) return
    text = ctx.text
    const { soloImageTrigger, pendingImagePaths } = ctx

    // 群聊：观察成员发言 + 友好度窗口记录 + @加友好度 + 讨论触发检查 + 结算检查
    if (isGroup) {
      members.observe(qqKey, String(msg.user_id ?? '?'), text)
      friends.recordMessage(qqKey, String(msg.user_id ?? '?'))
      discussion.recordActivity(qqKey, String(msg.user_id ?? '?'))
      // 结算检查：机器人发言后满 5 句 → 结算友好度窗口
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
      // @ 机器人的用户友好度 +5（无论是否触发回复）
      if (isAt) {
        friends.boost(String(msg.user_id ?? '?'), qqKey)
        log('info', '[qq-bridge] 用户 %s @机器人，友好度 +5 → %d', msg.user_id, friends.get(msg.user_id))
      }
      // 文件记忆：用户消息写入该群 chatlog.md
      if (config.memoryEnabled && text && !text.startsWith('（')) {
        void appendChat(gcfg.workdir, chatLine(members.nameOf(qqKey, String(msg.user_id ?? '?')), text))
      }
    }

    // 群聊能量机制：先记录+扣能量，未达阈值则不回复（像真人不是每条都回）
    let fedCurrentMsg = false   // 本次回复是否经 feed（非@）触发 → 当前消息已在 history，上下文须 omitLast
    if (isGroup && gcfg.energy?.enabled) {
      // 讨论模式退出检查（能量 < -24）
      discussion.checkExit(qqKey)

      // 🔒 回复冷却：刚回复后 cdMs 内，普通消息只缓冲不触发；@ 带文字可打破冷却
      if (energy.inCooldown(qqKey)) {
        if (isAt && text) {
          energy.breakCooldown(qqKey)   // @ 带文字打破冷却（真问题值得打断）
        } else if (isAt) {
          return   // 裸 @（只@无文字）：冷却期内完全忽略，不缓冲不计数 —— 彻底消除"问+紧跟裸@"二次回复
        } else {
          // 冷却期普通消息入历史+计数，不触发
          energy.feedCooldown(qqKey, String(msg.user_id ?? '?'), text)
          return
        }
      }

      // 被 @ 时强制触发（点名就得回）并进入 solo（记录发起人），否则正常 feed；
      // solo 纯图（soloImageTrigger）出冷却即触发"看图后主动回复"（不越过冷却——冷却期已在上面缓冲）
      // 🔒 solo 期间普通消息也强制触发（活跃群积极回应，不受能量阈值限制——能量高时普通消息 <0 才回会"假死"）
      if (isAt) {
        friends.enterSolo(qqKey, String(msg.user_id ?? '?'))
        energy.force(qqKey)
      } else if (soloImageTrigger || friends.isSolo(qqKey)) {
        energy.force(qqKey)
        // solo 期间普通消息不写 history（force 不记录），手动补记一条保证上下文连贯
        energy.record(qqKey, String(msg.user_id ?? '?'), text)
        fedCurrentMsg = true
      } else {
        // 挚友说话成本：挚友扣 17 能量（比普通 10 更积极），否则默认 msgCost
        const friendCost = friends.friendEnergyCost(String(msg.user_id ?? '?'))
        const cost = friendCost || (gcfg.energy.msgCost ?? 10)
        const triggered = energy.feed(qqKey, String(msg.user_id ?? '?'), text, cost)
        if (!triggered) return
        fedCurrentMsg = true   // feed 已把当前消息写进 history
      }
      log('info', '[qq-bridge] 群 %s 触发回复（能量 %d）', qqKey, energy.getEnergy(qqKey))
    }

    // 私聊工作指令：以 workPrefix 开头 → 真实 DSH 代理（不注入人设，独立会话）
    // 兼容全角 ！(手机输入法常自动转全角)
    const workPrefixes = [config.workPrefix, config.workPrefix === '!' ? '！' : ''].filter(Boolean)
    const wp = workPrefixes.find((p) => text.startsWith(p))
    if (!isGroup && wp) {
      // 权限收束：非白名单用户的工作指令静默不可用（不回复、不提示、不创建会话）
      if (!allowWork) {
        log('info', '[qq-bridge] 用户 %s 无权限调用工作指令(已忽略): %s', msg.user_id, text.slice(0, 40))
        return
      }
      const workText = text.slice(wp.length).trim()
      if (!workText) return
      try {
        const workQqKey = `qq-work-${msg.user_id ?? '?'}`
        const workCwd = config.workCwd || process.cwd()
        const sessionId = await sessions.ensure(workQqKey, workCwd)
        const content = [
          { type: 'text', text: workText },
          { type: 'text', text: `（注意：本会话工作目录为 ${workCwd}，你可以读取工作目录以外的文件，但写入仍以工作目录为准。）` },
        ]
        await promptQueue(sessionId, content, target, workText)
      } catch (err) {
        log('warn', '[qq-bridge] 工作指令失败: %s', err.message)
        await bot.sendText(target, `⚠️ 出错了：${err.message}`).catch(() => {})
      }
      return
    }

    try {
      // 会话：cwd 与群配置一致才复用，否则归档重建
      const sessionId = await sessions.ensure(qqKey, gcfg.workdir)
      // 注册待识别图片：回合结束(turn/end)后识别结果入库并删除文件
      if (pendingImagePaths.length) {
        visionFeature.registerImages(sessionId, qqKey, String(msg.user_id ?? '?'), pendingImagePaths)
      }

      if (gcfg.ack) {
        await bot.sendText(target, ackText(gcfg)).catch(() => {})
      }

      // 人设注入 + 群聊上下文 + 权限约束 → prompt 内容块
      const persona = buildPersonaPrompt(gcfg)
      const content = []
      if (persona) content.push({ type: 'text', text: persona })
      if (isGroup) {
        if (config.memoryEnabled) {
          // 文件记忆模式：固定指令，让模型读取 chatlog.md + profiles.md（不再注入滚动上下文）
          content.push({ type: 'text', text: memoryInstruction(gcfg.workdir) })
        } else {
          // 兼容旧模式：注入成员认知 + 能量滚动上下文
          const mctx = members.buildContext(qqKey, selfId)
          if (mctx) content.push({ type: 'text', text: mctx })
          const gctx = energy.getContext(qqKey, fedCurrentMsg)
          if (gctx) content.push({ type: 'text', text: gctx })
          const fctx = friends.buildContext(qqKey, selfId, String(msg.user_id ?? ''))
          if (fctx) content.push({ type: 'text', text: fctx })
        }
        // 讨论环境提示：让机器人发言更符合"多人讨论"氛围
        const dctx = discussion.getContext(qqKey)
        if (dctx) content.push({ type: 'text', text: dctx })
      } else {
        // 私聊：保持友好度认知（无文件记忆）
        const fctx = friends.buildContext(qqKey, selfId, String(msg.user_id ?? ''))
        if (fctx) content.push({ type: 'text', text: fctx })
      }
      const scopeNote = gcfg.allowOutside
        ? `（注意：本会话工作目录为 ${gcfg.workdir}，你可以读取工作目录以外的文件，但写入仍以工作目录为准。）`
        : `（注意：本会话工作目录为 ${gcfg.workdir}，你只能访问此目录内的文件，禁止读写目录外的任何文件。）`
      content.push({ type: 'text', text: scopeNote })
      // 权限收束：非白名单用户只聊天，禁止触碰本机文件（记忆文件/联网搜索/视觉看图除外——回复需要读记忆与查词看图）
      if (!allowWork) {
        content.push({ type: 'text', text: `（安全约束：你仅作为${config.botName || '我'}聊天。禁止写入、执行本机文件；只允许读取本目录下的 chatlog.md、profiles.md（记忆文件）和提示中给出的图片路径；除联网搜索和看图外，禁止调用其他工具。）` })
      }
      // 插件 prompt 钩子（识图提示等）
      const pluginBlocks = await features.runOnPrompt({ sessionId, qqKey, gcfg, imageSegs, pendingImagePaths, text })
      content.push(...pluginBlocks)
      // 用户消息放最后（模型注意力集中在用户的话上；纯 @ 消息给默认文本）
      content.push({ type: 'text', text: text || '（对方@了你）' })

      // 异步入队（accepted 即返回；回复走事件流）
      await promptQueue(sessionId, content, target, text || '（对方@了你）')
      // 群聊：回复已入队，重置能量（开始下一轮衰减）+ 进入回复冷却
      if (isGroup && gcfg.energy?.enabled) {
        if (discussion.isActive(qqKey)) {
          // 讨论模式：重置能量 30~60,且同样进入冷却(统一节奏——否则 30~60 能量 3~6 条消息就再触发,回复过频)
          discussion.onReply(qqKey)
          startCooldown(qqKey, msg.group_id)
          log('info', '[qq-bridge] 群 %s 讨论中回复，能量已重置并进入冷却', qqKey)
        } else {
          // 🔒 统一节奏（含 solo）：回复后进入冷却(锁 -1/缓冲消息/到期自动评估)，能量在到期后按配置恢复
          startCooldown(qqKey, msg.group_id)
        }
      }
      // 机器人发言：群聊标记友好度结算点（等后5句到齐后结算）
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
    } catch (err) {
      log('warn', '[qq-bridge] prompt failed: %s', err.message)
      await bot.sendText(target, `⚠️ 出错了：${err.message}`).catch(() => {})
    }
  }

  // ---------- DSH → QQ ----------

  async function onSessionEvent(sessionId, event) {
    // 🔴 防"老版本抢回复"：若本实例已被新实例替换(bot.active=false)，丢弃一切事件，
    //    不再 flush/发送回复——避免旧实例和新的抢着回。
    if (!bot.active) return
    // 插件会话钩子（识图识别结果/清理等）
    await features.runOnSessionEvent(sessionId, event)
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
  bot.on('message', (msg) => {
    // 按群/私聊串行处理（见 enqueueMsg 注释：消除冷却竞态 + 图片回合交错）
    const key = msg.message_type === 'group' ? `g${msg.group_id}` : `p${msg.user_id ?? '?'}`
    void enqueueMsg(key, () => onQqMessage(msg))
  })
  bot.on('error', (err) => log('warn', '[qq-bridge] onebot: %s', err.message))
  bot.on('reconnecting', (r) => log('info', '[qq-bridge] 重连中: %j', r))
  bot.connect()

  ctx.on('session/event', (session, event) => {
    void onSessionEvent(session.id, event).catch((err) =>
      log('warn', '[qq-bridge] event: %s', err.message))
  })

  // 周期检查：清理超时未上升的 solo 状态（发起人友好度超过
  // config.energy.soloIdleMs 无上升即退出）。用定时器而非消息驱动，
  // 避免群冷场时 stale solo 长期悬挂；每 10s 检查一次，及时响应超时。
  const SOLO_CHECK_INTERVAL_MS = 10 * 1000
  const soloCheckInterval = setInterval(() => {
    const expired = friends.checkSolosExpiry()
    if (expired.length) {
      log('info', '[qq-bridge] solo 状态检查：%s', JSON.stringify(expired))
    }
  }, SOLO_CHECK_INTERVAL_MS)

  // 每周档案更新：基于 chatlog.md + 现有 profiles.md，让 agent 静默更新用户档案
  const PROFILE_UPDATE_MS = config.profileWeekMs || (7 * 24 * 3600 * 1000)
  const profileUpdateTimer = setInterval(() => {
    if (!config.memoryEnabled) return
    for (const [gqk, cfg] of Object.entries(groups.list())) {
      if (!gqk.startsWith('qq-group-') || !cfg?.workdir) continue
      void (async () => {
        try {
          const sessionId = await sessions.ensure(gqk, cfg.workdir)
          const content = [
            { type: 'text', text: `【档案更新任务】读取本目录下的 chatlog.md（该群聊天记录）和现有 profiles.md（用户档案）。更新 profiles.md：为每个用户归纳昵称、性格特点、兴趣话题、与你的熟识度；保留已有信息，合并本周新增内容。只更新文件，不要向用户回复任何内容。` },
          ]
          await promptQueue(sessionId, content, null, '每周档案更新', { silent: true })
          log('info', '[qq-bridge] 每周档案更新已触发 %s', gqk)
        } catch (e) {
          log('warn', '[qq-bridge] 档案更新失败 %s: %s', gqk, e.message)
        }
      })()
    }
  }, PROFILE_UPDATE_MS)

  log('info', '[qq-bridge] 已启动，OneBot WS: %s', config.onebotWs)

  // ⚠️ 清理必须通过 apply 的返回值（disposer）注册：Cordis 从不 emit 'dispose'
  // 事件，ctx.on('dispose') 永远不会触发。此 disposer 由两处调用：
  //   ① 下一次 apply() 到来时（迭代自动清理，见文件顶 prevRuntime）；
  //   ② fiber 卸载时（Cordis 兜底）。
  const runtime = {
    dispose() {
      clearInterval(soloCheckInterval)
      clearInterval(profileUpdateTimer)
      clearInterval(statusTimer)
      writeStatus()                  // 最终落盘一次状态
      for (const t of cooldownTimers.values()) clearTimeout(t)
      cooldownTimers.clear()
      msgQueues.clear()            // 串行队列：dispose 后不再入队新消息
      friends.dispose()            // 最终保存友好度 + 清理持久化定时器
      energy.dispose()
      bot.close()                  // 关 WS + 从 activeByUrl 注销 + active=false
    },
  }
  prevRuntime = runtime
  return () => {
    // 仅当自己仍是最新 runtime 才真正释放（防迭代后旧 dispose 误杀新实例）
    if (prevRuntime === runtime) { prevRuntime = null; runtime.dispose() }
  }
}
