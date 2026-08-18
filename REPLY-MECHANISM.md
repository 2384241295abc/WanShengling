# dsh-qq-bridge 回复机制详解

> 本文档描述 dsh-qq-bridge 插件当前（v0.3.x）的完整回复机制：一条 QQ 消息进来后，
> 从接收到回传的每一步逻辑、能量/冷却/solo/讨论四种节奏、以及后台状态查询方式。
> 代码对应：`plugin/index.mjs`（主流程）、`energy.mjs`（能量/冷却）、`friend.mjs`（友好度/solo）、
> `discussion.mjs`（讨论模式）、`reply-buffer.mjs`（回复缓冲）、`session.mjs`（会话管理）、`vision.mjs`（图片处理，对接 DSH 视觉插件）。

---

## 1. 总览：一条消息的旅程

```
QQ 消息 → NapCat(WS:3001) → onebot-client → onQqMessage(msg)
  ├─ 群聊: 成员观察 → 友好度记录 → @检测(boost) → 讨论触发检查
  │        → 能量闸(冷却 → @force / feed) → 会话 → prompt 内容块 → 入队
  │        → 回复缓冲(流式聚合) → 回传 QQ → 回复后节奏(讨论重置/冷却)
  ├─ 私聊: 工作指令(！前缀,白名单) → qq-work 会话(真代理,不注入人设)
  └─ 私聊: 普通消息 → 机器人人设会话
```

## 2. 消息入口：onQqMessage（index.mjs）

1. **文本提取与 @ 检测**：`extractText` 取纯文本；`isAtBot` 在文本过滤**之前**检测 @（@消息可能只有 @ 段、文本为空，也要触发）。
2. **空消息直接丢弃**：`if (!text && !isAt) return`。
3. **分类**：`qqKey = qq-<group|private>-<群号|QQ号>`；`isGroup` 区分群聊/私聊。

### 群聊前置（isGroup）

| 步骤 | 作用 |
|------|------|
| `members.observe` | 记录发言，建成员画像（昵称优先，群名片兜底） |
| `friends.recordMessage` | 入友好度滚动窗口（结算用） |
| `discussion.recordActivity` | 记录 2 分钟内活跃发言者（讨论触发判定） |
| `friends.checkSettle` | 机器人发言后满 5 句 → 结算窗口内成员 +1 |
| 惰性成员同步 | 每群首次拉 `get_group_member_list`，并检查讨论触发 |
| @ 时 `friends.boost` | 该用户友好度 +5（无论是否触发回复） |

### 私聊工作指令

- 前缀 `!` 或 `！`（全角兼容）开头 → **工作模式**：独立会话 `qq-work-<QQ号>`，
  cwd=`workCwd`（默认 `~/Documents/DshDesktop`），**不注入人设**，真实 DSH 代理。
- **白名单 `workUsers`**（补丁设 `['23012321']`）：
  - 非白名单用户发工作指令 → **静默忽略**（不回复、不建会话）；
  - 非白名单用户的人设聊天 → prompt 注入安全约束「禁读写本机文件，联网搜索不受限」。

## 3. 能量闸（群聊，energy.mjs）

**核心思想**：像真人一样不是每条都回。回复后能量随机恢复 `[100,1000]`，随时间衰减，
每条消息扣能量，**能量 < 0 才触发回复**；@ 则强制。

### 数值（DEFAULT_ENERGY，补丁可覆盖）

| 配置 | 默认 | 含义 |
|------|------|------|
| `range` | `[100,1000]` | 回复/冷却结束后能量随机恢复区间 |
| `decayPerMin` | `3` | 每分钟衰减（惰性：按距上次更新分钟数补算） |
| `msgCost` | `10` | 每条普通消息扣能（挚友 17） |
| `contextWindow` | `8` | 触发时携带的最近聊天记录条数 |
| `cooldownMs` | `5000` | 回复后冷却时长 |

### 三种触发方式

| 方式 | 逻辑 |
|------|------|
| **feed**（普通消息） | `能量 -= 成本(10/17)` → 返回 `能量 < 0`；未达标不回复 |
| **force**（@） | 能量置 `-1`（必然 <0），点名必回 |
| **feedCooldown**（冷却期） | 只入历史+计数，不判能量不触发 |

### 回复冷却（核心节奏）

```
回复发出 → beginCooldown(5s)：能量锁 -1，pendingSinceReply=0
  冷却期内：
    - @ 带文字 → breakCooldown（解除锁定+能量-1）→ 立即回复
    - 裸 @（无文字）→ 完全忽略（不缓冲不计数，防"问+裸@"回两句）
    - 普通消息 → feedCooldown 缓冲入历史，pending+1
  冷却到期（5s 定时器）→ cooldownExpired：
    - 能量恢复 random[100,1000]
    - pending>0 → replyFromCooldown 基于缓冲记录回一条（"刚刚有人说话了，自然接一句"）
    - pending=0 → 静默
```

### solo 状态（@ 触发，纯状态记录）

- **进入**：@ 消息真正触发回复时 `enterSolo`（记录发起人，重复 @ 切换）。
- **续期**：**仅当发起人在该群获得友好度**（该群结算 +1 / 该群 @ +5）才刷新计时——
  私聊或他群的友好度增长不会给此群 solo 续命（修复：活跃用户 solo 永不退出的问题）。
- **退出**：`checkSolosExpiry` 每 10s 检查，发起人在该群友好度超过 `soloIdleMs`（默认 60s）未上升即退出。
- ⚠️ 当前 solo **不影响回复节奏**（已统一走冷却），仅在状态文件中可见。

### 讨论模式（discussion.mjs）

- **进入**：群友好度总和 > 成员数×80，或 2 分钟内发言人数 > 5。
- **节奏**：进入能量=10；每次回复后能量重置 `[30,60]`；能量 < -24 退出。
- **效果**：更活跃的多人讨论节奏（不走 5s 冷却）。

## 4. 回复后节奏（index.mjs 回复成功路径）

```
if (isGroup && energy.enabled) {
  if (discussion.isActive) → discussion.onReply(能量重置30~60)
  else                     → startCooldown(5s)          // 含 solo，统一冷却
}
if (isGroup) → friends.markReply(设置结算点)
else         → 私聊回复后对方友好度 +1
```

## 5. Prompt 内容块（按注入顺序）

| 顺序 | 块 | 说明 |
|------|-----|------|
| 1 | 人设 | 补丁 `persona`（v5.0：普通爱聊天的朋友，2~3 句节奏） |
| 2 | 成员认知 | 群聊：昵称/印象/发言次数 |
| 3 | 讨论环境 | 仅讨论模式激活时注入 |
| 4 | 友好度认知 | 当前说话者的友好度与关系（中性信息，无语气指令——语气由人设决定） |
| 5 | 能量上下文 | 群聊：最近 `contextWindow` 条聊天记录（含机器人自己上一条，标 `botName`） |
| 6 | 图片提示 | 消息带图时保存到工作目录并提示路径（模型用视觉工具查看） |
| 7 | 用户文本 | 或纯 @ 时的"（对方@了你）" |
| 7 | 工作目录提示 | `allowOutside` 决定"只能访问此目录"或"可读目录外" |
| 8 | 安全约束 | **仅非白名单用户**：「禁本机文件，联网搜索不受限」 |

注：`replyFromCooldown`（冷却补回）只含 1/2/3/5/7 块，无友好度认知与安全约束
（会话历史中已带约束，群级闲聊风险低）。

## 6. 回复缓冲（reply-buffer.mjs）

- `assistant/chunk`（流式增量）累积 → `assistant/message`（step 终稿）入列 → `turn/end` 消费队头
- 发送前 `sanitize`：剔除模型偶发的 `<system-reminder>`/`<available_skills>` 模仿块
- 长回复按 `maxChunkLength`(3500) 分块；超过 `forceFlushMs`(30s) 提示"内容有点多"
- 回复发出后经 `onReply` 回调 → `energy.recordBotReply` 回灌（治"重复自己/衔接断裂"）

## 7. 后台状态查询

| 文件 | 内容 | 更新 |
|------|------|------|
| `~/.dsh/qq-bridge-energy.json` | 各群 `energy/cooldown/solo/discussion/historyLen` | 每 30s 落盘 + 退出时最终落盘 |
| `~/.dsh/qq-bridge-friendly.json` | 全员友好度（按 QQ 号） | 友好度变化后防抖 10s 保存 |

QQ 内命令：「友好度」/「友好度 <群号>」→ 查群内全员友好度（白名单内可用）。

## 8. 关键配置速查（补丁 cordis.patch.yml）

| 配置 | 默认 | 说明 |
|------|------|------|
| `energy.range` | `[100,1000]` | 能量恢复区间 |
| `energy.cooldownMs` | `5000` | 回复冷却（热更新可调） |
| `energy.soloIdleMs` | `60000` | solo 状态超时 |
| `workUsers` | `[]` | 工作指令白名单（空=全部允许） |
| `workCwd` | `~/Documents/DshDesktop` | 工作模式目录 |
| `persona` | v5.0 | 人设文本（补丁 HMR 即时生效） |
| `groups.<群号>` | — | 按群覆盖（replyStyle/workdir/allowOutside/ack 等） |

## 9. 已知边界

- **能量闸只作用于群聊**：私聊每条都回（不走能量/冷却）。
- **工作模式不注入人设、不走能量闸**：白名单用户 `！指令` 直接真代理执行。
- **冷却补回回复**基于缓冲记录，不重复计数（不重跑观察/结算副作用）。
- solo 状态为纯记录，改回"快速陪聊"需恢复回复后能量=10 分支（当前按用户要求统一走冷却）。


## 10. 群聊文件记忆（2026-08-19 新增）

- **chatlog.md**（每群工作目录）：聊天记录独立存储（`[MM-DD HH:mm] 昵称: 内容`，含机器人回复与图片识别结果）。
- **profiles.md**（每群工作目录，统一一个文档）：每个用户一份人物档案（昵称/性格/兴趣/熟识度），每周由 agent 静默更新（基于 chatlog + 已有档案）。
- **prompt 模式**：`memoryEnabled=true` 时群聊 prompt 只发「固定人设 + 读文件指令」，模型用工具读取 chatlog.md/profiles.md，不再注入滚动上下文（省 token、上下文更完整）；`false` 回退旧注入模式。
- **清除缓存**：仅白名单用户(23012321)私聊发 `清除缓存` → 清除**全部群** chatlog.md 中一周前的记录；其他用户/群聊均不能触发。
- 安全约束：非白名单用户只允许读取 chatlog.md/profiles.md 与提示中图片路径，禁止写/执行。
