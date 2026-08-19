/**
 * config.mjs —— 插件配置解析（集中管理，便于人工调整与未来可视化配置界面）
 *
 * 配置来源优先级（从高到低）：
 *   1. 环境变量（桌面壳透传）：DSH_QQ_ONEBOT_WS / DSH_QQ_ONEBOT_TOKEN
 *   2. 补丁 YAML config（cordis.patch.yml 中 qq-bridge 的 config）
 *   3. 硬编码默认值（本文件 DEFAULTS）
 *
 * 所有可调参数集中于此；新增可调项只需在 DEFAULTS 加字段，
 * 补丁 YAML 即可覆盖，无需改业务代码。
 */

'use strict'

import { join } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULT_ENERGY } from './energy.mjs'
import { DEFAULT_DISCUSSION } from './discussion.mjs'

/** 全局默认配置（所有群/私聊继承的基础值） */
export const DEFAULTS = {
  onebotWs: 'ws://127.0.0.1:6700',
  onebotToken: '',
  sessionCwd: '',
  ack: false,                  // 默认去机械回执
  stallNoticeMs: 60000,
  forceFlushMs: 30000,
  autoAnswer: 'reject',        // 'reject' | 'allow-once' —— 普通会话的提问/审批策略
  workAutoAnswer: 'ask',       // 工作模式(qq-work-*)的提问/审批策略：'ask'=挂起等用户在 QQ 回复
  maxChunkLength: 3500,
  muted: false,                // 🔇 禁言开关：true 时完全不触发任何回复（含群聊/@/私聊/识图），便于调试

  // 全局人设 / 风格（所有群继承；groups 可覆盖）
  persona: undefined,          // undefined = 使用内置 DEFAULT_PERSONA
  botName: '',                 // 机器人显示名（聊天记录/安全约束里对自己的称呼）；空=用"我"
  replyStyle: 'default',       // 'default' | 'short' | 'detailed' | 'casual' | 'emoji' | 'serious'
  allowOutside: false,         // 是否允许读取工作目录外文件
  workdir: '',                 // 全局默认工作目录（空=每群自动生成）

  // 私聊工作指令：以 workPrefix 开头 → 真实 DSH 代理（不注入人设）
  workPrefix: '!',             // 前缀（如 "!查看 DshDesktop 目录"）
  workCwd: '',                 // 工作模式 cwd（空=默认 ~/Documents/DshDesktop）
  workUsers: [],               // 工作模式白名单（数字字符串数组）；空=工作模式关闭(默认)，非空=仅列表内用户可用

  // 群聊能量阈值机制（仅群聊生效；私聊不走）
  // ⚠️ 默认值唯一来源为 energy.mjs 的 DEFAULT_ENERGY，此处引用，勿重复维护
  energy: { ...DEFAULT_ENERGY },

  // 消息对象主体性规则（subjectivity.mjs 使用；改这里补丁覆盖即热更新，无需重启）
  subjectivity: {
    askWindowMs: 15000,      // 询问后追问窗口时长（毫秒）
    ruleText: `【回复前先看对象】
- 回复前先判断：这句话是说给谁的？从最近的聊天记录能清晰推测出对象主体吗？
- 对象主体是你 → 正常回复。
- 对象主体是别人（比如在约游戏组队、约排位、互相讨论）→ 别硬接、别凑合，像真人刷群看到别人聊天那样自然冒个泡（随口一句不参与，比如"你们玩，我不凑热闹"），别硬把话题接过来。
- 推测不出 → 先回一句符合你人设的询问（比如"你是在跟我说？"），别硬接。`,
    followUpHint: `（对方刚刚回应了你刚才的询问。判断这条消息的对象主体是否已明确：明确了就给出对象主体明确的回复；还没明确就自然接一句。）`,
  },

  // 群聊讨论模式参数（discussion.mjs 使用；改这里补丁覆盖即热更新，无需重启）
  // ⚠️ 默认值唯一来源为 discussion.mjs 的 DEFAULT_DISCUSSION，此处引用，勿重复维护
  discussion: { ...DEFAULT_DISCUSSION },

  // 万生玲主动发图（表情包）能力（send-image.mjs 使用；改这里补丁覆盖即热更新）
  sendImage: {
    assetDir: '',    // 表情包库目录；空=禁用发图（默认关闭，配置后启用）
    hint: `你可以在回复里用 [发图:xxx] 标记甩一张图（xxx 是表情包库里的文件名关键字，如 [发图:猫猫]）。像真人聊着聊着甩个表情包：能用图表达就不必打字。拿不准或没必要发图时不要用。`, // prompt 提示（人设语境，非硬约束）
  },

  // 按群覆盖配置（key = 群号数字，如 "859762634"）
  groups: {},

  // 群聊文件记忆（chatlog.md + profiles.md）
  memoryEnabled: true,       // 群聊是否启用文件记忆（prompt 改为读文件而非注入上下文）
  clearCommand: '清除缓存',  // 群聊触发词：清除一周前的聊天记录
  profileWeekMs: 7 * 24 * 3600 * 1000,   // 每周档案自动更新间隔
}

/** 合并环境变量与原始配置，返回最终 config */
export function resolveConfig(rawConfig = {}) {
  // range 是数组字段，需独立拷贝，避免各实例共享同一数组引用被互相污染（浅拷贝陷阱）
  const mergeEnergy = (base, patch = {}) => {
    const merged = { ...base, ...patch }
    if (Array.isArray(patch.range)) merged.range = [...patch.range]
    else if (Array.isArray(base.range)) merged.range = [...base.range]
    return merged
  }
  // 普通对象块深层合并（subjectivity/discussion）：补丁可只覆盖部分字段，数组字段独立拷贝
  const mergeBlock = (base, patch = {}) => {
    const merged = { ...base, ...patch }
    for (const k of Object.keys(merged)) {
      if (Array.isArray(merged[k]) && !Array.isArray(patch[k])) merged[k] = [...merged[k]]
    }
    return merged
  }
  return {
    ...DEFAULTS,
    ...rawConfig,
    onebotWs: process.env.DSH_QQ_ONEBOT_WS || rawConfig.onebotWs || DEFAULTS.onebotWs,
    onebotToken: process.env.DSH_QQ_ONEBOT_TOKEN || rawConfig.onebotToken || DEFAULTS.onebotToken,
    // energy 深层合并（允许补丁只覆盖部分字段）；range 数组独立拷贝防共享污染
    energy: mergeEnergy(DEFAULTS.energy, rawConfig.energy),
    // subjectivity / discussion / sendImage 深层合并（允许补丁只覆盖部分字段）
    subjectivity: mergeBlock(DEFAULTS.subjectivity, rawConfig.subjectivity),
    discussion: mergeBlock(DEFAULTS.discussion, rawConfig.discussion),
    sendImage: mergeBlock(DEFAULTS.sendImage, rawConfig.sendImage),
    groups: rawConfig.groups || DEFAULTS.groups,
    // 工作模式 cwd 默认 ~/Documents/DshDesktop
    workCwd: rawConfig.workCwd || DEFAULTS.workCwd || join(homedir(), 'Documents', 'DshDesktop'),
  }
}
