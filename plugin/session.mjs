/**
 * session.mjs —— DSH 会话管理
 *
 * 职责：
 *   - 按 qqKey 幂等建会话（复用已有会话）
 *   - 校验会话 cwd 与群配置工作目录一致；不一致则归档旧会话重建
 *   - 维护 qqKey -> { sessionId, cwd } 缓存，cwd 变更时强制重建
 *
 * 依赖宿主：ctx.apiProxy（sessions.list/create + workspaces.archiveSession）
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

  /** 确保会话存在且 cwd 与配置一致；返回 sessionId */
  async function ensure(qqKey, cwd) {
    const want = cwd || process.cwd()
    const entry = cache.get(qqKey)
    if (entry && entry.cwd === want) return entry.sessionId

    const { result } = await api.sessions.list({ rpcId: randomUUID(), payload: {} })
    const items = result.ok ? result.value.items : []
    const found = items.find((it) => it.sessionId === qqKey)
    if (found) {
      const have = found.cwd ?? found.workspaceId ?? ''
      if (have && have !== want) {
        log('info', '[qq-bridge] 会话 %s 工作目录变更 %s -> %s，归档重建', qqKey, have, want)
        try {
          await api.workspaces.archiveSession({ rpcId: randomUUID(), payload: { sessionId: qqKey } })
          onRebuild(qqKey)
        } catch (e) {
          log('warn', '[qq-bridge] 归档旧会话失败（继续用旧会话）: %s', e.message)
          cache.set(qqKey, { sessionId: found.sessionId, cwd: have })
          return found.sessionId
        }
      } else {
        cache.set(qqKey, { sessionId: found.sessionId, cwd: have || want })
        return found.sessionId
      }
    }
    const created = await api.sessions.create({
      rpcId: randomUUID(),
      payload: { sessionId: qqKey, cwd: want, blank: true },
    })
    if (!created.result.ok) throw new Error(`${created.result.error?.code}: ${created.result.error?.message || 'session.create failed'}`)
    const sessionId = created.result.value.sessionId
    cache.set(qqKey, { sessionId, cwd: want })
    return sessionId
  }

  return { ensure }
}
