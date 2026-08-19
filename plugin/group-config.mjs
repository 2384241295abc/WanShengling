/**
 * group-config.mjs —— 群配置管理器
 *
 * 职责：按 QQ 群/私聊维度管理配置（人设/风格/工作目录/权限/能量），
 *       支持全局默认 + 按群覆盖，运行时创建/切换工作目录。
 *
 * 配置优先级（从高到低）：
 *   1. 补丁 groups.<群号>（显式按群覆盖）
 *   2. 全局默认（来自 config.mjs 的 DEFAULTS：persona/replyStyle/allowOutside/ack/energy）
 *   3. 本文件硬编码兜底
 *
 * 注意：人设文本与风格提示定义在 persona.mjs，不在此重复。
 */

'use strict'

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULT_PERSONA } from './persona.mjs'
import { DEFAULT_ENERGY } from './energy.mjs'

/** 每群配置的完整字段（全局默认值在此，按群 groups 覆盖） */
export function defaultGroupConfig(global = {}) {
  return {
    persona: global.persona ?? DEFAULT_PERSONA,  // 默认注入机器人人设（全局）
    replyStyle: global.replyStyle ?? 'default',  // 'default' | 'short' | 'detailed' | 'casual' | 'emoji' | 'serious'
    workdir: '',                 // 专属工作目录；空=默认规则生成
    allowOutside: global.allowOutside ?? false,  // 是否允许读取工作目录外文件
    ack: global.ack ?? false,    // 是否发"已收到"回执（默认 false=去机械回执）
    // 群聊能量阈值机制（仅群聊生效；私聊不走此逻辑）
    // ⚠️ 默认值唯一来源为 energy.mjs 的 DEFAULT_ENERGY，引用之，勿重复维护
    energy: { ...DEFAULT_ENERGY },
  }
}

/** 按群生成默认工作目录：~/Documents/qqbot/<qqKey>/（qqKey 如 qq-group-123） */
export function defaultWorkdir(qqKey) {
  // qqKey 形如 qq-group-123456 / qq-private-10001，只取数字部分做目录名
  const id = String(qqKey).replace(/[^0-9]/g, '') || 'default'
  return join(homedir(), 'Documents', 'qqbot', id)
}

/** 合并原始配置（补丁里的 groups）与默认值（含全局默认） */
export function normalizeGroup(raw, qqKey, global = {}) {
  const base = defaultGroupConfig(global)
  const merged = {
    ...base,
    ...(raw || {}),
    workdir: raw?.workdir || global.workdir || defaultWorkdir(qqKey),
  }
  // energy 深层合并（允许补丁只覆盖部分字段）
  if (raw?.energy || global.energy) {
    merged.energy = { ...base.energy, ...(global.energy || {}), ...(raw?.energy || {}) }
    // ⚠️ range 是数组字段：上面展开是浅拷贝，各群会共享同一数组引用 → 一处改动污染其它群与全局。
    //    与 config.mjs mergeEnergy 同款修复：显式拷贝，杜绝共享污染。
    if (Array.isArray(raw?.energy?.range)) merged.energy.range = [...raw.energy.range]
    else if (Array.isArray(global.energy?.range)) merged.energy.range = [...global.energy.range]
    else if (Array.isArray(base.energy.range)) merged.energy.range = [...base.energy.range]
  }
  return merged
}

/**
 * 群配置管理器
 * @param {object} opts
 * @param {object} opts.groups  补丁配置中的 groups（key=群 id 数字，value=配置，覆盖全局）
 * @param {object} opts.global  全局默认配置（persona/replyStyle/allowOutside/ack/energy/workdir）
 * @param {Function} opts.log   日志函数
 */
export function createGroupManager({ groups = {}, global = {}, log = () => {} } = {}) {
  /** qqKey -> 配置（含显式配置 + 运行时生成的默认） */
  const cache = new Map()

  /** 取某群配置（不存在则生成默认并缓存） */
  function get(qqKey) {
    let cfg = cache.get(qqKey)
    if (cfg) return cfg
    // 显式配置：groups 的 key 可能是群号数字（group_id / user_id）
    const id = String(qqKey).replace(/[^0-9]/g, '')
    const raw = groups[id] ?? groups[qqKey]
    cfg = normalizeGroup(raw, qqKey, global)
    // 确保工作目录存在
    try {
      mkdirSync(cfg.workdir, { recursive: true })
    } catch (e) {
      log('warn', `[qq-bridge] 创建工作目录失败 %s: %s`, cfg.workdir, e.message)
    }
    cache.set(qqKey, cfg)
    log('info', '[qq-bridge] 群配置 %s -> workdir=%s allowOutside=%s ack=%s', qqKey, cfg.workdir, cfg.allowOutside, cfg.ack)
    return cfg
  }

  /** 设置某群配置（运行时热改） */
  function set(qqKey, patch) {
    const cur = get(qqKey)
    const next = { ...cur, ...patch }
    if (patch.workdir) {
      try { mkdirSync(next.workdir, { recursive: true }) } catch (e) { log('warn', `[qq-bridge] 工作目录失败 %s`, e.message) }
    }
    cache.set(qqKey, next)
    return next
  }

  /** 列出当前已生成的群配置（供可视化界面/调试用） */
  function list() {
    return Object.fromEntries(cache.entries())
  }

  return { get, set, list }
}
