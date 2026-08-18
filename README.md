# dsh-qq-bridge

DeepSeek Harness × QQ 远程交互桥（OneBot 11）—— 独立 Cordis 插件包。

让 DeepSeek Harness 的智能体通过 QQ 聊天「活」起来：有人设、会记住群成员、
有社交节奏（不是每条都回）、能进入群聊「讨论」模式。

## ✨ 功能

| 模块 | 说明 |
|------|------|
| **人设** | 全局人设（config.persona，补丁热更新），可自由定制身份/性格/风格 |
| **能量节奏** | 群聊不是每条都回：回复后能量随机 `[100,1000]`，每分钟衰减 3，每条消息扣 10（挚友 17），能量 <0 才回；@ 必回 |
| **友好度** | 跨群共享，按用户维度：机器人发言前后各 5 条内成员 +1，被 @ +5；等级 陌生/认识/熟悉/挚友 |
| **成员认知** | 自动识别群成员 QQ 昵称/群名片，从聊天记录推断话题画像（游戏/音乐/吃喝等） |
| **讨论模式** | 群总友好度 > 成员数×80，或 2 分钟内发言人数 >5 时触发；能量 10 进入、回复后重置 30~60、< -24 退出 |
| **每群工作目录** | 每群独立 cwd（`~/Documents/qqbot/<群号>/`），目录外读写受限 |
| **私聊工作指令** | 私聊以 `!` 开头走真实 DSH 代理（不注入人设，独立会话，cwd 默认 `~/Documents/DshDesktop`），其余消息按配置的人设聊天 |
| **会话共享** | QQ 会话与 DSH Web UI 完全共享（in-process 架构） |

## 📦 安装

### 1. 放入 DSH profiles

将 `plugin/` 目录软链到 DSH profile 的 node_modules：

```bash
mkdir -p ~/.dsh/profiles/node_modules/@dsh-qq
ln -s <本仓库>/plugin ~/.dsh/profiles/node_modules/@dsh-qq/qq-bridge
```

### 2. 配置补丁

在 `~/.dsh/profiles/web/cordis.patch.yml` 注册插件：

```yaml
- insert:
    - id: qq-bridge
      name: '@dsh-qq/qq-bridge'
      config:
        onebotWs: 'ws://127.0.0.1:3001'
        onebotToken: '<NapCat WS token>'
        reloadToken: 1
        persona: |-
          你叫 XX，……（你的机器人人设写在这里）
          【回复铁律】
          - 每条回复 30 字以内
          - 禁止括号（）、禁止省略号……
          - 直接回答问题
        energy:
          range: [100, 1000]
        groups:
          '<群号>':
            replyStyle: 'casual'
            workdir: '/Users/<你>/Documents/qqbot/<群号>'
            allowOutside: false
            ack: false
```

### 3. 重启 DSH

改配置（补丁值变化）→ HMR 热更新，无需重启；改代码 → 需重启。

## ⚙️ 配置项

| 配置 | 默认 | 说明 |
|------|------|------|
| `onebotWs` | `ws://127.0.0.1:6700` | OneBot WS 地址（NapCat 正向 WS） |
| `onebotToken` | 空 | NapCat WS access token |
| `persona` | 留空 | 全局人设（补丁热更新；`DEFAULT_PERSONA` 兜底） |
| `energy.range` | `[100, 1000]` | 回复后重置能量区间 |
| `energy.decayPerMin` | `3` | 每分钟能量衰减 |
| `energy.msgCost` | `10` | 每条消息扣能（挚友 17） |
| `energy.contextWindow` | `8` | 触发时携带最近消息条数 |
| `workPrefix` | `!` | 私聊工作指令前缀（前缀开头 → 真实 DSH 代理） |
| `workCwd` | `~/Documents/DshDesktop` | 工作模式 DSH 代理 cwd |
| `memoryEnabled` | `true` | 群聊文件记忆（chatlog.md + profiles.md，prompt 改为读文件） |
| `clearCommand` | `清除缓存` | 群聊清除一周前聊天记录的命令词 |
| `profileWeekMs` | 7 天 | 用户档案每周自动更新间隔 |
| `groups.<群号>` | — | 按群覆盖（persona/replyStyle/workdir/allowOutside/ack） |

## 🧪 测试

```bash
# mock OneBot + mock LLM 端到端（详见原 smoke-test 的 --qq-e2e 思路）
node test/mock-onebot.mjs --port 6710 --message "你好"
```

## 📄 许可

MIT

## 🔗 相关

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（宿主框架）
- [NapCat](https://github.com/NapNeko/NapCatQQ)（QQ OneBot 11 框架）
