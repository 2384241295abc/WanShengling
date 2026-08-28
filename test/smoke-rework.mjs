// 冒烟：2026-08-29 重构后的能量/冷却状态机（无定时器/无补回，消息驱动）
import { createEnergyManager } from '../plugin/energy.mjs'
import { createReplyBuffer } from '../plugin/reply-buffer.mjs'
import { createFriendsManager } from '../plugin/friend.mjs'

let pass = 0, fail = 0
const assert = (n, c) => { c ? pass++ : fail++; console.log((c ? '✅' : '❌'), n) }

// ===== 1. 能量状态机：回复后进入冷却 + 能量重置 =====
const E = createEnergyManager({ energy: { cooldownMs: 300, range: [30, 90], msgCost: 10 } })
const k = 'qq-group-1'
E.beginCooldown(k, 300)
assert('回复后进入冷却', E.inCooldown(k) === true)
const e0 = E.getEnergy(k)
assert('回复后能量在 range 内（未锁 -1）', e0 >= 0 && e0 <= 60)

// ===== 2. 冷却期消息扣能量（feed）但不触发 =====
E.feed(k, 'u1', '消息A')
E.feed(k, 'u1', '消息B')
assert('冷却期 feed 不入触发（仍在冷却）', E.inCooldown(k) === true)
const e1 = E.getEnergy(k)
assert('冷却期 feed 扣能量', e1 === e0 - 20)

// ===== 3. 冷却到期后消息自然触发（无定时器：到期由 inCooldown 自然失效）=====
await new Promise((r) => setTimeout(r, 350))
assert('冷却自然到期（无定时器也失效）', E.inCooldown(k) === false)
// 活跃群：能量已被扣到负数 → 下一条 feed 触发
E.feed(k, 'u1', '消息C')
const st = E.stats()[k]
assert('到期后消息触发（能量<0）', st.energy < 0 || st.energy - 10 < 0)   // feed 扣 10 后应 <0

// ===== 4. reply-buffer：去重跳过仍通知 onReply(sent:false) =====
const sent = []
const events = []
const RB = createReplyBuffer({
  sendText: async (t, txt) => { sent.push(txt); return txt },
  log: () => {},
  onReply: (ev) => events.push(ev),
})
const target = { message_type: 'group', group_id: '1' }
RB.enqueue('s1', target)
await RB.onEvent('s1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '你好' }] } } })
await RB.onEvent('s1', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
RB.enqueue('s2', target)
await RB.onEvent('s2', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '你好' }] } } })
await RB.onEvent('s2', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
assert('去重后只发 1 条', sent.length === 1)
assert('去重跳过后仍回调 onReply(sent:false)', events.length === 2 && events[1].sent === false)
assert('正常发送回调 onReply(sent:true)', events[0].sent === true)

// ===== 5. soloOwner 接口 =====
const F = createFriendsManager({ log: () => {}, soloIdleMs: 60000 })
F.enterSolo('qq-group-2', '23012321')
assert('soloOwner 返回发起人', F.soloOwner('qq-group-2') === '23012321')
assert('非 solo 返回 null', F.soloOwner('qq-group-3') === null)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
