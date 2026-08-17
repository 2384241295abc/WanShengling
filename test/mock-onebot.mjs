/**
 * Mock OneBot 11 WS 服务器 —— 端到端测试 dsh-qq-bridge 用
 *
 * 行为：
 *  - 接受插件（正向 WS 客户端）的连接（可选 Bearer token 校验）
 *  - 连接后 2 秒发送一条伪造的私聊文本消息，触发桥接链
 *  - 打印收到的全部 action（send_private_msg 等），并回 echo 响应
 *
 * 运行：node mock-onebot.mjs --port 6710 [--token xxx] [--message "文本"]
 * ws 库来源：优先 $WS_PATH（CI/跨机由调用方传入），其次相对本文件探测项目内位置。
 */
'use strict'

import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

function resolveWs() {
  if (process.env.WS_PATH) return process.env.WS_PATH
  // 相对本文件（qq-bridge/test/）探测项目内 ws：desktop 根 node_modules / resources/harness
  const here = fileURLToPath(new URL('.', import.meta.url))
  const proj = require('node:path').resolve(here, '..', '..')
  const candidates = [
    require('node:path').join(proj, 'node_modules', 'ws'),
    require('node:path').join(proj, 'resources', 'harness', 'node_modules', '.pnpm', 'node_modules', 'ws'),
    require('node:path').join(proj, 'resources', 'harness', 'node_modules', 'ws'),
  ]
  for (const c of candidates) {
    try { require.resolve(c); return c } catch { /* next */ }
  }
  throw new Error('找不到 ws 库，请设置 WS_PATH 指向 ws 包目录')
}

const args = process.argv.slice(2)
function arg(name, def) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const PORT = Number(arg('port', '6710'))
const TOKEN = arg('token', '')
const DELAY = Number(arg('delay', '2000'))
const GAP = Number(arg('gap', '6000'))
// 消息脚本：竖线分隔，每项 `type:id:text`，如
//   --script "private:10001:你好|group:20002:大家好"
// private 的 id 是 user_id；group 的 id 是 group_id（发送者 user_id 固定 10001）
// 默认：一条私聊消息
const SCRIPT = (arg('script', null) || `private:10001:${arg('message', '你好，请介绍一下你自己')}`)
  .split('|').map((s) => {
    const parts = s.split(':')
    const type = parts.shift()
    const id = Number(parts.shift())
    return {
      type,
      user_id: type === 'group' ? 10001 : id,
      group_id: type === 'group' ? id : undefined,
      text: parts.join(':'),
    }
  })

const { WebSocketServer } = require(resolveWs())
const httpServer = createServer()
const wss = new WebSocketServer({ server: httpServer, maxPayload: 10 * 1024 * 1024 })

wss.on('connection', (ws, req) => {
  // token 校验（Authorization: Bearer <token>）
  const auth = req.headers.authorization || ''
  if (TOKEN && auth !== `Bearer ${TOKEN}`) {
    console.log(`[mock] 拒绝连接（token 不匹配）: ${auth}`)
    ws.close(4001, 'unauthorized')
    return
  }
  console.log(`[mock] 插件已连接 ${req.socket.remoteAddress}:${req.socket.remotePort}`)

  // 生命周期事件
  ws.send(JSON.stringify({
    post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect',
    self_id: 10000, time: Math.floor(Date.now() / 1000),
  }))

  // 按脚本逐条发送消息（每条间隔 GAP ms）
  let msgId = 1001
  SCRIPT.forEach((entry, i) => {
    setTimeout(() => {
      const msg = {
        post_type: 'message',
        message_type: entry.type,
        user_id: entry.user_id,
        ...(entry.group_id !== undefined ? { group_id: entry.group_id } : {}),
        message_id: msgId++,
        message: [{ type: 'text', data: { text: entry.text } }],
        raw_message: entry.text,
        self_id: 10000,
        time: Math.floor(Date.now() / 1000),
      }
      console.log(`[mock] >>> 发送 QQ ${entry.type} 消息: ${entry.text}`)
      ws.send(JSON.stringify(msg))
    }, DELAY + i * GAP)
  })

  ws.on('message', (data) => {
    let obj
    try { obj = JSON.parse(String(data)) } catch { console.log('[mock] 非 JSON:', String(data).slice(0, 200)); return }
    console.log(`[mock] <<< action: ${obj.action} echo=${obj.echo}`, JSON.stringify(obj.params ?? {}).slice(0, 300))
    // echo 响应
    ws.send(JSON.stringify({
      status: 'ok', retcode: 0, data: { message_id: Math.floor(Math.random() * 1e6) }, echo: obj.echo,
    }))
    // 对发送类动作高亮打印文本内容
    if (obj.action === 'send_private_msg' || obj.action === 'send_group_msg') {
      const msg = obj.params?.message
      const text = typeof msg === 'string' ? msg : (Array.isArray(msg) ? msg.map((s) => s?.data?.text ?? '').join('') : '')
      console.log(`\n========== QQ 收到回复（${obj.action}） ==========\n${text}\n===========================================\n`)
    }
  })

  ws.on('close', () => console.log('[mock] 插件断开'))
})

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] OneBot 11 mock 服务器已就绪: ws://127.0.0.1:${PORT} (token=${TOKEN || '无'})`)
})
