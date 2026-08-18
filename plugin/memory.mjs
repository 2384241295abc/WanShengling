/**
 * memory.mjs —— 群聊文件记忆
 *
 * 职责：
 *   - 每群聊天记录持久化到工作目录 chatlog.md（独立存储，模型直接读取）
 *   - 用户档案统一文档 profiles.md（每用户一条，所有群共享内容）
 *   - 「清除缓存」：重写 chatlog.md，只保留最近一周
 *   - 每周根据 chatlog + 现有 profiles 触发档案更新
 *
 * 设计：prompt 只发固定人设 + 「读取文件」指令，动态上下文由模型读文件获得；
 *       避免每次把滚动历史注入 prompt（省 token、上下文更完整）。
 */

'use strict'

import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 一周毫秒 */
export const WEEK_MS = 7 * 24 * 3600 * 1000

export function chatlogPath(workdir) { return join(workdir, 'chatlog.md') }
export function profilesPath(workdir) { return join(workdir, 'profiles.md') }

/** 追加一条聊天记录（形如 [MM-DD HH:mm] 昵称: 内容） */
export async function appendChat(workdir, line) {
  try {
    await mkdir(workdir, { recursive: true })
    await appendFile(chatlogPath(workdir), line + '\n')
  } catch {}
}

/** 读取最近 N 行聊天记录（供模型读文件用不到，供启发式/清理用） */
export async function readChatlog(workdir, maxLines = 500) {
  try {
    const txt = await readFile(chatlogPath(workdir), 'utf8')
    return txt.split('\n').filter(Boolean).slice(-maxLines)
  } catch { return [] }
}

/** 清除一周前的聊天记录（重写文件只保留最近一周）；返回删除条数 */
export async function clearChatOlderThanWeek(workdir, now = Date.now()) {
  try {
    const lines = await readChatlog(workdir, 100000)
    const keep = lines.filter((l) => {
      const m = /^\[(\d{2})-(\d{2}) (\d{2}):(\d{2})\]/.exec(l)
      if (!m) return true
      const d = new Date()
      d.setMonth(Number(m[1]) - 1, Number(m[2]))
      d.setHours(Number(m[3]), Number(m[4]), 0, 0)
      return now - d.getTime() < WEEK_MS
    })
    await writeFile(chatlogPath(workdir), keep.join('\n') + (keep.length ? '\n' : ''))
    return lines.length - keep.length
  } catch { return 0 }
}

/**
 * 固定记忆读取指令（注入 prompt）—— 模型先读文件再回，避免滚动上下文注入。
 * @param {string} workdir 群工作目录
 * @returns {string} 指令文本；memory 未启用时为空
 */
export function memoryInstruction(workdir) {
  return `（请先读取本目录下的 chatlog.md（该群最近聊天记录）和 profiles.md（用户档案），基于这些内容自然地接话。不要复述记录内容，不要重复自己刚说过的话。文件不存在就忽略。如果用户发了图片，图片内容提示里有本地路径，可用视觉工具查看。）`
}

/** 构建一条聊天记录行 */
export function chatLine(name, text) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `[${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}] ${name}: ${text}`
}
