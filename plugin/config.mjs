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

/** 全局默认配置（所有群/私聊继承的基础值） */
export const DEFAULTS = {
  onebotWs: 'ws://127.0.0.1:6700',
  onebotToken: '',
  sessionCwd: '',
  ack: false,                  // 默认去机械回执
  stallNoticeMs: 60000,
  forceFlushMs: 30000,
  autoAnswer: 'reject',        // 'reject' | 'allow-once'
  maxChunkLength: 3500,

  // 全局人设 / 风格（所有群继承；groups 可覆盖）
  persona: undefined,          // undefined = 使用内置 DEFAULT_PERSONA
  replyStyle: 'default',       // 'default' | 'short' | 'detailed' | 'casual' | 'emoji' | 'serious'
  allowOutside: false,         // 是否允许读取工作目录外文件
  workdir: '',                 // 全局默认工作目录（空=每群自动生成）

  // 私聊工作指令：以 workPrefix 开头 → 真实 DSH 代理（不注入人设）
  workPrefix: '!',             // 前缀（如 "!查看 DshDesktop 目录"）
  workCwd: '',                 // 工作模式 cwd（空=默认 ~/Documents/DshDesktop）

  // 群聊能量阈值机制（仅群聊生效；私聊不走）
  energy: {
    enabled: true,             // 群聊是否启用能量阈值
    range: [100, 1000],        // 每次回复后重置的随机能量区间(上限1000)
    decayPerMin: 3,           // 每分钟衰减
    msgCost: 10,               // 群内每条消息衰减
    contextWindow: 8,          // 触发时携带的最近消息条数
  },

  // 按群覆盖配置（key = 群号数字，如 "859762634"）
  groups: {},
}

/** 合并环境变量与原始配置，返回最终 config */
export function resolveConfig(rawConfig = {}) {
  return {
    ...DEFAULTS,
    ...rawConfig,
    onebotWs: process.env.DSH_QQ_ONEBOT_WS || rawConfig.onebotWs || DEFAULTS.onebotWs,
    onebotToken: process.env.DSH_QQ_ONEBOT_TOKEN || rawConfig.onebotToken || DEFAULTS.onebotToken,
    // energy 深层合并（允许补丁只覆盖部分字段）
    energy: {
      ...DEFAULTS.energy,
      ...(rawConfig.energy || {}),
    },
    groups: rawConfig.groups || DEFAULTS.groups,
    // 工作模式 cwd 默认 ~/Documents/DshDesktop
    workCwd: rawConfig.workCwd || DEFAULTS.workCwd || join(homedir(), 'Documents', 'DshDesktop'),
  }
}
