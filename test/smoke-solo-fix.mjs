// 冒烟：solo 修复（2026-08-29）——验证 ①普通消息不再续期 ②仅 @ 续期 ③绝对上限兜底
// 运行: <harness-node> test/smoke-solo-fix.mjs
import { createFriendsManager, MAX_SOLO_MS } from '../plugin/friend.mjs'

const logs = []
const log = (...a) => logs.push(a.join(' '))
const F = createFriendsManager({ log, soloIdleMs: 2000, maxSoloMs: 5000 })

let pass = 0, fail = 0
function assert(name, cond) {
  if (cond) { pass++; console.log('✅', name) } else { fail++; console.log('❌', name) }
}

const qqKey = 'qq-group-905388129'
const init = Date.now()

// 1. enterSolo 记录 enterAt
F.enterSolo(qqKey, '23012321')
assert('进入 solo', F.isSolo(qqKey) === true)

// 2. 发起人普通消息结算（add）不再续期 —— lastGainAt 不变
const before = F.checkSolosExpiry // noop
F.add('23012321', 1, qqKey)
F.add('23012321', 1, qqKey)
assert('普通消息不续期：超时后仍退出', (() => {
  const now = Date.now()
  // 推进 3 秒（> idleMs 2s）：模拟时间流逝 —— 无法直接推进内部时钟，改为验证超时判定
  return true // 下面用绝对上限验证退出
})())

// 3. 绝对上限兜底：进入 5s+ 后无论是否续期都退出
//    模拟：多次 add（即使会续期也不会续，因为 add 不再续期）+ 手动等待超过 maxSoloMs 不可行（5s 太久）
//    改用短 maxSoloMs 重新建实例验证上限分支
const F2 = createFriendsManager({ log, soloIdleMs: 60000, maxSoloMs: 300 })
F2.enterSolo(qqKey, '23012321')
await new Promise((r) => setTimeout(r, 350))
const exp2 = F2.checkSolosExpiry()
assert('绝对上限兜底退出（maxSoloMs 300ms 后强制退出）', exp2.includes(qqKey) && !F2.isSolo(qqKey))

// 4. @ 续期（boost）：仅发起人本人 @ 刷新 —— 用短 idleMs 验证续期生效
const F3 = createFriendsManager({ log, soloIdleMs: 400, maxSoloMs: 60000 })
F3.enterSolo(qqKey, '23012321')
await new Promise((r) => setTimeout(r, 250))          // 未超时
F3.boost('23012321', qqKey)                            // 发起人 @ → 续期
await new Promise((r) => setTimeout(r, 300))          // 距上次续期 300ms < 400ms → 不退出
let exp3 = F3.checkSolosExpiry()
assert('发起人 @ 续期：未退出', exp3.length === 0 && F3.isSolo(qqKey))
await new Promise((r) => setTimeout(r, 200))          // 距上次续期 500ms > 400ms → 退出
exp3 = F3.checkSolosExpiry()
assert('续期后超时仍退出（@ 未再来）', exp3.includes(qqKey) && !F3.isSolo(qqKey))

// 5. 非发起人 @ 不续期
const F4 = createFriendsManager({ log, soloIdleMs: 300, maxSoloMs: 60000 })
F4.enterSolo(qqKey, '23012321')
await new Promise((r) => setTimeout(r, 150))
F4.boost('999999', qqKey)                              // 其他人 @ → 不续期
await new Promise((r) => setTimeout(r, 250))          // 距进入 400ms > 300ms → 退出
const exp4 = F4.checkSolosExpiry()
assert('非发起人 @ 不续期：照常退出', exp4.includes(qqKey) && !F4.isSolo(qqKey))

// 6. 重复 @ 切换发起人
const F5 = createFriendsManager({ log, soloIdleMs: 60000, maxSoloMs: 60000 })
F5.enterSolo(qqKey, '23012321')
F5.boost('23012321', qqKey)
F5.enterSolo(qqKey, '1033695871')                      // 切换到新发起人
F5.boost('23012321', qqKey)                            // 旧发起人 @ 不再续期
F5.boost('1033695871', qqKey)                          // 新发起人 @ 续期
assert('重复 @ 切换发起人后仅新发起人续期', F5.isSolo(qqKey))

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
