/**
 * registry.mjs —— 插件宿主：轻量 feature 注册中心
 *
 * 插件接口（feature）：一个对象
 *   {
 *     name: 'xx',                    // 插件名（用于日志/调试）
 *     // 可选 hooks：
 *     async onMessage(ctx)           // 消息预处理；返回 true 表示已处理并拦截（不再走后续流程）
 *     async onPrompt(ctx)            // prompt 构建时追加内容块；返回 {type:'text',text}[] 或 []
 *     async onSessionEvent(sessionId, event)  // DSH 会话事件（如 tool/result、turn/end）
 *     async onReply(target, text)    // 机器人回复发出后
 *   }
 *
 * 用法：
 *   const reg = createFeatureRegistry()
 *   reg.register({ name:'vision', onMessage(){...}, ... })
 *   reg.register({ name:'commands', ... })
 *   // 宿主在流程各点调用 reg.runXxx(...)
 */

'use strict'

export function createFeatureRegistry() {
  const features = []

  function register(feature) {
    if (!feature || !feature.name) throw new Error('feature 需要 name')
    features.push(feature)
    return feature
  }

  /** 运行 onMessage 钩子：任一插件返回 true 即拦截（返回 true） */
  async function runOnMessage(ctx) {
    for (const f of features) {
      if (typeof f.onMessage === 'function') {
        try {
          const handled = await f.onMessage(ctx)
          if (handled === true) return true
        } catch (e) {
          console.error(`[feature:${f.name}] onMessage 异常:`, e?.message)
        }
      }
    }
    return false
  }

  /** 运行 onPrompt 钩子：收集所有插件追加的内容块 */
  async function runOnPrompt(ctx) {
    const blocks = []
    for (const f of features) {
      if (typeof f.onPrompt === 'function') {
        try {
          const added = await f.onPrompt(ctx)
          if (Array.isArray(added)) blocks.push(...added)
        } catch (e) {
          console.error(`[feature:${f.name}] onPrompt 异常:`, e?.message)
        }
      }
    }
    return blocks
  }

  /** 运行 onSessionEvent 钩子（顺序执行；各插件自行决定是否消费） */
  async function runOnSessionEvent(sessionId, event) {
    for (const f of features) {
      if (typeof f.onSessionEvent === 'function') {
        try { await f.onSessionEvent(sessionId, event) } catch (e) {
          console.error(`[feature:${f.name}] onSessionEvent 异常:`, e?.message)
        }
      }
    }
  }

  /** 运行 onReply 钩子 */
  async function runOnReply(target, text) {
    for (const f of features) {
      if (typeof f.onReply === 'function') {
        try { await f.onReply(target, text) } catch (e) {
          console.error(`[feature:${f.name}] onReply 异常:`, e?.message)
        }
      }
    }
  }

  return { register, runOnMessage, runOnPrompt, runOnSessionEvent, runOnReply, list: () => features }
}
