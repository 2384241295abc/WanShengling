# dsh-qq-bridge

DeepSeek Harness × QQ 远程交互桥（OneBot 11）—— 独立 Cordis 插件包（v0.3.3）。

让 DeepSeek Harness 的智能体通过 QQ 聊天「活」起来：可定制人设、群聊文件记忆、
识图、社交节奏（不是每条都回）、讨论模式、用户友好度与档案。
可通过对话远程操控你的 dsh 处理工作——私聊消息前加 `!` 进入工作模式。

> **模板化设计**：人设/机器人名/群配置全部可配，仓库本身不含任何具体人设（`DEFAULT_PERSONA` 留空），
> fork 后填自己的设定即可跑。

## ✨ 功能

| 模块 | 说明 |
|------|------|
| **插件架构** | `registry.mjs` 轻量 feature 宿主：`onMessage/onPrompt/onSessionEvent/onReply` 四钩子；内置 `features/vision`(识图)、`features/commands`(指令)，新能力 `features.register(createXxxFeature(deps))` 即接入 |
| **人设** | `config.persona` 补丁热更新；`botName` 机器人显示名；`DEFAULT_PERSONA` 模板留空自行填写 |
| **群聊文件记忆** | 每群 `chatlog.md`(聊天记录独立存储) + `profiles.md`(每用户档案统一文档)；prompt 改为「固定人设+读文件指令」，模型读文件获得上下文；每周 agent 静默更新档案 |
| **识图(可选依赖)** | QQ 表情包/图片：平时纯图只记录不回复，solo 模式看图后主动回复；识别结果入库 chatlog、图片文件用完即删；识别失败按疑似色情内容处理。需 DSH 视觉插件(modlens/free-vision)提供 `image_understand` 工具 |
| **能量节奏** | 群聊不是每条都回：回复后能量随机 `[500,1500]`，每分钟衰减 3，每条消息扣 10(挚友 17)，`能量<0` 才回；@ 必回 |
| **回复冷却** | 回复后 15s 冷却：冷却内普通消息只缓冲，@ 带文字可打破；冷却到期恢复能量并补回一条 |
| **友好度** | 跨群共享，按用户维度：机器人发言前后各 5 条内成员 +1，被 @ +5；等级 陌生/认识/熟悉/挚友；持久化到 `~/.dsh/qq-bridge-friendly.json` |
| **成员认知** | 自动识别 QQ 昵称(优先)/群名片(兜底)，从聊天记录推断话题画像 |
| **solo 点名** | 群内 @ → 进入 solo(纯状态记录，节奏统一走冷却)，发起人该群友好度 60s 未上升自动退出 |
| **讨论模式** | 群总友好度 > 成员数×80，或 2 分钟内发言人数 >5 时触发；能量 10 进入、回复后重置 30~60 并进入冷却（含冷却到期自动回复后重新冷却，每 cdMs 至多回一条）、< -24 退出 |
| **指令** | `/友好度`、`/友好度 <群号>`(查友好度)、`/能量`、`/能量 <群号>`(查能量/冷却/讨论/solo，维护用)、`/清除缓存`(清一周前聊天记录，白名单) —— 指令统一 `/` 前缀 |
| **私聊工作指令** | 私聊以 `!` 开头走真实 DSH 代理(独立会话 `qq-work-<user>`，cwd=`workCwd`，不注入人设)，受 `workUsers` 白名单约束 |
| **每群工作目录** | 每群独立 cwd(`~/Documents/qqbot/<群号>/`)，目录外读写受限(`allowOutside` 可放行) |
| **会话共享** | QQ 会话与 DSH Web UI 完全共享(in-process 架构) |

## 🏗️ 架构

```
QQ 消息 → NapCat(WS:3001) → onebot-client → onQqMessage(宿主)
   ├─ features.onMessage   指令/纯图等(返回 true=拦截)
   ├─ 群聊: 成员观察 → 友好度 → 讨论 → 能量闸(冷却/@/feed)
   ├─ 会话 ensure → prompt 内容块(features.onPrompt 追加) → 入队
   ├─ 回复缓冲(流式聚合) → 回传 QQ → onReply 钩子(写 chatlog/回灌)
   └─ features.onSessionEvent  识别结果捕获/回合清理
```

**模块清单**（`plugin/`）：
`index.mjs`(宿主) · `config.mjs` · `persona.mjs` · `group-config.mjs` · `energy.mjs` · `friend.mjs` · `discussion.mjs` · `members.mjs` · `session.mjs` · `memory.mjs` · `vision.mjs`(图片库) · `registry.mjs`(插件宿主) · `reply-buffer.mjs` · `handlers.mjs` · `onebot-client.mjs` · `features/vision.mjs`(识图插件) · `features/commands.mjs`(指令插件)

详细机制见仓库内 **[REPLY-MECHANISM.md](REPLY-MECHANISM.md)**。

## 📦 安装

### 1. 放入 DSH profiles

将 `plugin/` 目录软链到 DSH profile 的 node_modules：

```bash
mkdir -p ~/.dsh/profiles/node_modules/@dsh-qq
ln -s <本仓库>/plugin ~/.dsh/profiles/node_modules/@dsh-qq/qq-bridge
```

### 2. 配置补丁

在 `~/.dsh/profiles/web/cordis.patch.yml` 注册插件（完整模板见 `plugin/cordis.patch.yml`）：

```yaml
- insert:
    - id: qq-bridge
      name: '@dsh-qq/qq-bridge'
      config:
        onebotWs: 'ws://127.0.0.1:3001'
        onebotToken: '<NapCat WS token>'
        botName: '你的机器人名'          # 聊天记录里的自称
        persona: |-                    # 你的机器人人设（改这里即热更新）
          你叫 XX，……（身份/性格/说话风格/回复规则）
        workUsers: ['<你的QQ号>']       # 工作指令白名单；空=全部允许
        energy:
          range: [500, 1500]
        groups:
          '<群号>':
            replyStyle: 'casual'
            workdir: '/Users/<你>/Documents/qqbot/<群号>'
            allowOutside: false
            ack: false
```

### 3. 启动

改补丁**配置值** → HMR 热更新，无需重启；改**代码**(.mjs) → 重启 3080 宿主。

### 4. 识图依赖（可选）

识图需要 DSH 部署了视觉插件（如 `@liustack/modlens`、`dsh-free-vision`），
为纯文本模型提供 `image_understand` 工具。未部署时图片仅记录不识别。

## ⚙️ 配置项

| 配置 | 默认 | 说明 |
|------|------|------|
| `onebotWs` | `ws://127.0.0.1:6700` | OneBot WS 地址（NapCat 正向 WS） |
| `onebotToken` | 空 | NapCat WS access token |
| `botName` | `''` | 机器人显示名（聊天记录/安全约束自称；空=用"我"） |
| `persona` | 留空 | 全局人设（补丁热更新；`DEFAULT_PERSONA` 模板留空） |
| `workUsers` | `[]` | 工作指令白名单（空=全部允许） |
| `workPrefix` | `!` | 私聊工作指令前缀 |
| `workCwd` | `~/Documents/DshDesktop` | 工作模式 DSH 代理 cwd |
| `memoryEnabled` | `true` | 群聊文件记忆（chatlog.md + profiles.md，prompt 改为读文件） |
| `clearCommand` | `清除缓存` | `/清除缓存` 命令词（白名单可执行） |
| `profileWeekMs` | 7 天 | 用户档案每周自动更新间隔 |
| `energy.range` | `[500, 1500]` | 回复后重置能量区间 |
| `energy.decayPerMin` | `3` | 每分钟能量衰减 |
| `energy.msgCost` | `10` | 每条消息扣能（挚友 17） |
| `energy.cooldownMs` | `15000` | 回复冷却毫秒 |
| `energy.soloIdleMs` | `60000` | solo 状态超时 |
| `groups.<群号>` | — | 按群覆盖（persona/replyStyle/workdir/allowOutside/ack） |

## ⌨️ 指令

| 指令 | 说明 | 权限 |
|------|------|------|
| `/友好度` | 查当前群全员友好度 | 白名单 |
| `/友好度 <群号>` | 查指定群友好度 | 白名单 |
| `/能量` | 查当前群能量/冷却/讨论/solo/缓冲（维护用） | 白名单 |
| `/能量 <群号>` | 查指定群能量状态 | 白名单 |
| `/清除缓存` | 清除全部群一周前的聊天记录 | 白名单 |

指令统一 `/` 前缀；无前缀的相同文本按普通聊天处理。

## 🧪 测试

```bash
# mock OneBot WS 服务器（发一条私聊消息触发桥接链，打印收到的 action）
node test/mock-onebot.mjs --port 6710 --message "你好"
```

## 📄 许可

MIT

## 🔗 相关

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（宿主框架）
- [NapCat](https://github.com/NapNeko/NapCatQQ)（QQ OneBot 11 框架）
- [modlens](https://github.com/liustack/modlens)（DSH 视觉插件，识图依赖）
