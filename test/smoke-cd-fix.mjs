// 冒烟：CD 忙期 + 补回契约（2026-09-04 重写——原版断言 8-29 前的 feedCooldown/cooldownExpired/
// 能量锁定语义，已随状态机删除；现按"单忙期 busyUntil + notePending 补回"现行模型验证）
// 运行: node test/smoke-cd-fix.mjs
import { createEnergyManager } from '../plugin/energy.mjs'

const E = createEnergyManager({ energy: { cooldownMs: 300, inFlightTtlMs: 2000, range: [30, 90] }, log: () => {} })
const k = 'qq-group-1022712087'

let pass = 0, fail = 0
function assert(name, cond) {
  if (cond) { pass++; console.log('✅', name) } else { fail++; console.log('❌', name) }
}

// 1. 回复发出 → beginCooldown 进入忙期（冷却）
E.beginCooldown(k, 300)
assert('回复后进入忙期(冷却)', E.inCooldown(k) === true)
assert('忙期剩余 ~300ms', E.cooldownRemainingMs(k) > 0 && E.cooldownRemainingMs(k) <= 300)

// 2. 忙期内 @ / 普通消息：状态机层面只入历史 + 记 pending（触发与否由调用方 onQqMessage 判定）
E.feed(k, '23012321', '@万生玲 你选一个吧')
E.notePending(k, '23012321', '@万生玲 你选一个吧', true)
assert('忙期内消息仍处于忙期(不触发)', E.inCooldown(k) === true)
assert('冷却期消息已记 pending', E.pendingInfo(k)?.text === '@万生玲 你选一个吧')
assert('pendingKeys 含本群', E.pendingKeys().includes(k))

// 3. 忙期到期自然失效；pending 仍在（供补回）
await new Promise((r) => setTimeout(r, 350))
assert('忙期自然到期', E.inCooldown(k) === false)
assert('到期后 hasPending=true(可补回)', E.hasPending(k) === true)

// 4. 补回路径：读取 pending → clearPending（只补一次）→ 重新进入忙期
const pend = E.pendingInfo(k)
assert('补回可读 pending', !!pend && pend.text.includes('你选一个吧'))
E.clearPending(k)
assert('clearPending 后无补回', E.hasPending(k) === false && E.pendingKeys().length === 0)
E.beginCooldown(k, 300)
assert('补回后重新进入忙期', E.inCooldown(k) === true)

// 5. 入队忙期 markBusy（在途窗口）：TTL 内不可触发；beginCooldown 覆盖收敛为冷却时长
E.markBusy(k)
assert('入队即忙期', E.inCooldown(k) === true)
assert('忙期剩余 ≤ inFlightTtlMs', E.cooldownRemainingMs(k) <= 2000)
E.beginCooldown(k, 300)
assert('发送后覆盖为冷却(≤300)', E.cooldownRemainingMs(k) <= 300)

// 6. markBusy 超 TTL 自动失效（onReply 异常不永久卡）
E.markBusy(k, 100)
await new Promise((r) => setTimeout(r, 150))
assert('在途忙期超 TTL 自然失效', E.inCooldown(k) === false)

// 7. 忙期不锁能量（与旧"锁定 -1"语义相反：能量由 feed/衰减管理，忙期只控触发间隔）
E.feed(k, '1033695871', '晚安')
assert('忙期能量为 feed 后净值(非 -1)', E.getEnergy(k) !== -1)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
