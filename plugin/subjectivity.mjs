/**
 * subjectivity.mjs —— 消息对象主体性规则（基础回复规则，机制层，独立于人设）
 *
 * 解决：万生玲把群里所有消息都当成"对自己说的"，回复时以自己为核心。
 * 规则（用户在 2026-08-19 提出的基础回复规则，不写入 persona 文本）：
 *   1. 回复前先判断这条消息的对象主体：从最近的聊天记录能否清晰推测出是说给谁的；
 *   2. 对象主体是自己 → 正常回复；
 *   3. 对象主体是别人（约游戏/组队/互聊等）→ 不硬接不凑合，自然冒个泡（像真人刷群随口一句）；
 *   4. 推测不出 → 先回一句符合人设的询问（如"你是在跟我说？"），别硬接；
 *   5. 询问（回复以问号结尾）发出后开追问窗口：窗口内收到回应 →
 *      追加一次对象主体明确的回复。
 *
 * ⚠️ 全部可调参数来自 config（DEFAULTS.subjectivity，补丁可覆盖 → 热更新无需重启）：
 *   - askWindowMs   追问窗口时长（毫秒，默认 15000）
 *   - ruleText      基础规则文本（默认见 config.mjs）
 *   - followUpHint  窗口命中时的追加提示文本
 *
 * 对外接口：
 *   createSubjectivity({ log, askWindowMs, ruleText, followUpHint })
 *     → ruleText()        规则块文本（群聊 prompt 注入）
 *     → followUpHint()    窗口命中追加提示
 *     → onBotReply(qqKey, text)  机器人回复后调用：以问号结尾 → 开窗口
 *     → consume(qqKey)    命中并消费窗口（返回 true 表示应追加对象主体明确的回复）
 *     → clear()           清理全部窗口（disposer 调用）
 */

'use strict'

/** 回复是否为"对象询问"：以问号结尾（万生玲禁省略号，询问必然带问号收尾） */
function isAskText(text) {
  return /[？?]\s*$/.test(text || '')
}

export function createSubjectivity({ log = () => {}, askWindowMs = 15000, ruleText = '', followUpHint = '' } = {}) {
  /** qqKey -> 窗口到期时间戳 */
  const windows = new Map()

  function ruleTextFn() {
    return ruleText
  }

  function followUpHintFn() {
    return followUpHint
  }

  /** 机器人回复后调用：仅群聊（qq-group- 前缀）询问句（问号结尾）→ 开追问窗口。
   *  私聊天然主体明确（对方就是对象），不开窗。 */
  function onBotReply(qqKey, text) {
    if (!qqKey || !qqKey.startsWith('qq-group-') || !isAskText(text)) return
    windows.set(qqKey, Date.now() + askWindowMs)
    log('info', '[qq-bridge] 已开对象追问窗口 %s（%dms）', qqKey, askWindowMs)
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

  return { ruleText: ruleTextFn, followUpHint: followUpHintFn, onBotReply, consume, clear, stats }
}
