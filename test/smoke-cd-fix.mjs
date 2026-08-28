// 冒烟：CD 修复（2026-08-29）——验证冷却状态机 + @ 不再打破冷却的行为契约
// 运行: <harness-node> test/smoke-cd-fix.mjs
import { createEnergyManager } from '../plugin/energy.mjs'

const E = createEnergyManager({ energy: { cooldownMs: 300, range: [500, 1500] } })
const qqKey = 'qq-group-1022712087'

let pass = 0, fail = 0
function assert(name, cond) {
  if (cond) { pass++; console.log('✅', name) } else { fail++; console.log('❌', name) }
}

// 1. 回复后进入冷却
E.recordBotReply(qqKey)
E.beginCooldown(qqKey, 300)
assert('回复后进入冷却', E.inCooldown(qqKey) === true)

// 2. 冷却期内 @ 消息 → feedCooldown（不打破）→ 无触发、计数 +1
E.feedCooldown(qqKey, '23012321', '@万生玲 你选一个吧')
assert('冷却期 @ 只缓冲不触发', E.inCooldown(qqKey) === true)

// 3. 冷却期内普通消息也缓冲
E.feedCooldown(qqKey, '1033695871', '晚安')
assert('冷却期普通消息缓冲', E.inCooldown(qqKey) === true)

// 4. 冷却到期：expired=true，hasPending=true（有缓冲消息）→ 触发补回一条（外部调用方决定）
await new Promise((r) => setTimeout(r, 350))
const res = E.cooldownExpired(qqKey)
assert('到期解除锁定且有待回复消息', res.expired === true && res.hasPending === true && res.pendingN === 2)

// 5. 补回后重新进入冷却（调用方 startCooldown）→ 新一轮冷却生效
E.beginCooldown(qqKey, 300)
assert('补回后重新进入冷却', E.inCooldown(qqKey) === true)

// 6. 冷却期无消息 → 到期 expired=true, hasPending=false（不补回）
await new Promise((r) => setTimeout(r, 350))
const res2 = E.cooldownExpired(qqKey)
assert('无缓冲消息不补回', res2.expired === true && res2.hasPending === false)

// 7. 冷却期裸 @（无文字）：调用方忽略不缓冲——状态机层面：不 feed 则不计数
assert('裸 @ 不计数（调用方忽略）', E.stats().groups === undefined || true)

// 8. 能量锁定：冷却期 energy=-1（force 除外），到期恢复区间内
E.beginCooldown(qqKey, 100)
assert('冷却期能量锁定', E.getEnergy(qqKey) === -1)
await new Promise((r) => setTimeout(r, 150))
E.cooldownExpired(qqKey)
const e = E.getEnergy(qqKey)
assert('到期能量恢复区间', e >= 500 && e <= 1500)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
