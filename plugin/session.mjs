/**
 * session.mjs —— DSH 会话管理
 *
 * 职责：
 *   - 按 qqKey 幂等建会话（复用已有会话，重启后按 qq- 前缀 + cwd 恢复）
 *   - 校验会话 cwd 与配置工作目录一致；不一致则归档旧会话并以新 id 重建
 *   - 维护 qqKey -> { sessionId, cwd } 缓存
 *
 * 依赖宿主：ctx.apiProxy（sessions.list/create + workspace.list/archiveSession）
 */

'use strict'

import { randomUUID } from 'node:crypto'

/**
 * 创建会话管理器
 * @param {object} opts
 * @param {object} opts.api        ctx.apiProxy
 * @param {Function} opts.log      日志函数
 * @param {Function} opts.onRebuild 归档重建回调（清理该群旧缓冲等）
 */
export function createSessionManager({ api, log = () => {}, onRebuild = () => {} } = {}) {
  /** qqKey -> { sessionId, cwd }（cwd 变更时强制重建） */
  const cache = new Map()

  /**
   * 确保会话存在且 cwd 与配置一致；返回 sessionId。
   * 同名会话 cwd 不一致时：归档旧会话（保留日志、从分组视图隐藏），再新建。
   * 新建优先用 qqKey 做 id（重启可恢复）；id 被已归档旧会话占用（session-conflict）
   * 时退化为 qqKey-<时间戳>（保持 qq- 前缀，重启仍可恢复）。
   */
  async function ensure(qqKey, cwd) {
    const want = cwd || process.cwd()
    const entry = cache.get(qqKey)
    if (entry && entry.cwd === want) return entry.sessionId

    const { result } = await api.sessions.list({ rpcId: randomUUID(), payload: {} })
    const items = result.ok ? result.value.items : []
    // 已归档会话（隐藏但仍列出）不参与复用，避免捡到旧的/诊断会话
    const arch = await api.workspace.list({ rpcId: randomUUID(), payload: {} })
    const archived = new Set(arch.result.ok ? arch.result.value.archivedSessionIds : [])
    // 1) 同名且 cwd 一致 → 复用（跨重启稳定）
    const byId = items.find((it) => it.sessionId === qqKey && !archived.has(it.sessionId) && (it.cwd ?? '') === want)
    if (byId) {
      cache.set(qqKey, { sessionId: byId.sessionId, cwd: want })
      return byId.sessionId
    }
    // 2) 重启恢复：复用本 qqKey 名下 cwd 一致的会话（退化 id 形如 qqKey-<ts>，
    //    以 qqKey 开头；绝不复用其他用户/群/Web 的会话）
    const byCwd = items.find((it) => String(it.sessionId).startsWith(qqKey) && !archived.has(it.sessionId) && (it.cwd ?? '') === want)
    if (byCwd) {
      cache.set(qqKey, { sessionId: byCwd.sessionId, cwd: want })
      return byCwd.sessionId
    }
    // 3) 同名会话但 cwd 不一致 → 归档旧会话后重建
    const stale = items.find((it) => it.sessionId === qqKey)
    if (stale && !archived.has(stale.sessionId)) {
      try {
        const a = await api.workspace.archiveSession({ rpcId: randomUUID(), payload: { sessionId: qqKey } })
        if (!a.result.ok) throw new Error(`${a.result.error?.code}: ${a.result.error?.message || 'archive failed'}`)
        onRebuild(qqKey)
        log('info', '[qq-bridge] 会话 %s 工作目录变更 %s -> %s，已归档重建', qqKey, stale.cwd, want)
      } catch (e) {
        log('warn', '[qq-bridge] 归档旧会话失败（继续用旧会话）: %s', e.message)
        cache.set(qqKey, { sessionId: stale.sessionId, cwd: stale.cwd })
        return stale.sessionId
      }
    }
    // 4) 新建：同名旧会话(stale,可能已归档)占用着 qqKey id——直接用它会导致
    //    sessions.create 返回旧会话(同 id+同 cwd 会复用而非新建) → 回复写进隐藏会话。
    //    故只要存在 stale 就用退化 id qqKey-<时间戳>；无 stale 才优先 qqKey。
    const id = stale ? `${qqKey}-${Date.now().toString(36)}` : qqKey
    const created = await api.sessions.create({ rpcId: randomUUID(), payload: { cwd: want, sessionId: id } })
    if (!created.result.ok) throw new Error(`${created.result.error?.code}: ${created.result.error?.message || 'session.create failed'}`)
    const sessionId = created.result.value.sessionId
    cache.set(qqKey, { sessionId, cwd: want })
    return sessionId
  }

  return { ensure }
}
