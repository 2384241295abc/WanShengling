/**
 * session.mjs —— DSH 会话管理
 *
 * 职责：
 *   - 按 qqKey 幂等建会话（复用已有会话，重启后按 cwd 恢复）
 *   - 校验会话 cwd 与配置工作目录一致；不一致则归档旧会话并以新 id 重建
 *   - 维护 qqKey -> { sessionId, cwd } 缓存
 *
 * 依赖宿主：ctx.apiProxy（sessions.list/create + workspace.archiveSession）
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
   * 同名会话 cwd 不一致时：归档旧会话（保留日志、从分组视图隐藏），
   * 再以新 id 创建（同 id 重建会 session-conflict，不能复用旧 id）。
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
    // 重启恢复：优先复用任意 cwd 一致的会话，避免每次重启都新建
    const byCwd = items.find((it) => !archived.has(it.sessionId) && (it.cwd ?? '') === want)
    if (byCwd) {
      cache.set(qqKey, { sessionId: byCwd.sessionId, cwd: want })
      return byCwd.sessionId
    }
    // 同名会话但 cwd 不一致：归档旧会话后重建
    const byId = items.find((it) => it.sessionId === qqKey)
    if (byId && !archived.has(byId.sessionId) && (byId.cwd ?? '') !== want) {
      try {
        const arch = await api.workspace.archiveSession({ rpcId: randomUUID(), payload: { sessionId: qqKey } })
        if (!arch.result.ok) throw new Error(`${arch.result.error?.code}: ${arch.result.error?.message || 'archive failed'}`)
        onRebuild(qqKey)
        log('info', '[qq-bridge] 会话 %s 工作目录变更 %s -> %s，已归档重建', qqKey, byId.cwd, want)
      } catch (e) {
        log('warn', '[qq-bridge] 归档旧会话失败（继续用旧会话）: %s', e.message)
        cache.set(qqKey, { sessionId: byId.sessionId, cwd: byId.cwd })
        return byId.sessionId
      }
    }
    // 新建（不预分配 id，避免与已归档的旧会话 id 冲突）
    const created = await api.sessions.create({
      rpcId: randomUUID(),
      payload: { cwd: want },
    })
    if (!created.result.ok) throw new Error(`${created.result.error?.code}: ${created.result.error?.message || 'session.create failed'}`)
    const sessionId = created.result.value.sessionId
    cache.set(qqKey, { sessionId, cwd: want })
    return sessionId
  }

  return { ensure }
}
