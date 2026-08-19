/**
 * subjectivity.mjs —— 消息对象主体性规则（基础回复规则，机制层，独立于人设）
 *
 * 解决：万生玲把群里所有消息都当成"对自己说的"，回复时以自己为核心。
 * 规则（用户在 2026-08-19 提出的基础回复规则，不写入 persona 文本）：
 *   1. 回复前先判断这条消息的对象主体：从最近的聊天记录能否清晰推测出是说给谁的；
 *   2. 能推测出 → 按该对象主体回复（别把每条消息都当成对自己说的）；
 *   3. 推测不出 → 先回一句符合人设的询问（如"你是在跟我说？"），别硬接；
 *   4. 询问（回复以问号结尾）发出后开 15 秒追问窗口：窗口内收到回应 →
 *      追加一次对象主体明确的回复。
 *
 * 对外接口：
 *   createSubjectivity({ log })
 *     → ruleText()        规则块文本（群聊 prompt 注入）
 *     → onBotReply(qqKey, text)  机器人回复后调用：以问号结尾 → 开 15s 窗口
 *     → consume(qqKey)    命中并消费窗口（返回 true 表示应追加对象主体明确的回复）
 *     → clear()           清理全部窗口（disposer 调用）
 */

'use strict'

/** 追问窗口时长：询问发出后等多久的澄清回应 */
const ASK_WINDOW_MS = 15000

/** 基础回复规则文本（机制层，不随人设走） */
const SUBJECT_RULE = `【回复前先看对象】
- 回复前先判断：这句话是说给谁的？从最近的聊天记录能清晰推测出对象主体吗？
- 能推测出 → 就按这个对象主体回复，别把每条消息都当成对你说的。
- 推测不出 → 先回一句符合你人设的询问（比如"你是在跟我说？"），别硬接。`

/** 窗口命中时注入的追加提示（提示模型这次回复要给出对象主体明确的回复） */
const FOLLOW_UP_HINT = `（对方刚刚回应了你刚才的询问。判断这条消息的对象主体是否已明确：明确了就给出对象主体明确的回复；还没明确就自然接一句。）`

/** 回复是否为"对象询问"：以问号结尾（万生玲禁省略号，询问必然带问号收尾） */
function isAskText(text) {
  return /[？?]\s*$/.test(text || '')
}

export function createSubjectivity({ log = () => {} } = {}) {
  /** qqKey -> 窗口到期时间戳 */
  const windows = new Map()

  function ruleText() {
    return SUBJECT_RULE
  }

  function followUpHint() {
    return FOLLOW_UP_HINT
  }

  /** 机器人回复后调用：仅群聊（qq-group- 前缀）询问句（问号结尾）→ 开 15s 追问窗口。
   *  私聊天然主体明确（对方就是对象），不开窗。 */
  function onBotReply(qqKey, text) {
    if (!qqKey || !qqKey.startsWith('qq-group-') || !isAskText(text)) return
    windows.set(qqKey, Date.now() + ASK_WINDOW_MS)
    log('info', '[qq-bridge] 已开对象追问窗口 %s（15s）', qqKey)
  }

  /** 命中并消费窗口：窗口未过期返回 true（仅一次，消费后即关闭） */
  function consume(qqKey) {
    const exp = windows.get(qqKey)
    if (!exp) return false
    windows.delete(qqKey)
    if (exp <= Date.now()) return false
    log('info', '[qq-bridge] 追问窗口命中 %s → 追加对象主体明确的回复', qqKey)
    return true
  }

  /** 清理全部窗口（disposer） */
  function clear() {
    windows.clear()
  }

  /** 当前窗口状态快照（调试） */
  function stats() {
    return Object.fromEntries([...windows.entries()].map(([k, exp]) => [k, exp - Date.now()]))
  }

  return { ruleText, followUpHint, onBotReply, consume, clear, stats }
}
