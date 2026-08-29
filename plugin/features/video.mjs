/**
 * features/video.mjs —— 视频提取（🔒 预留接口，2026-08-30）
 *
 * 能力（规划）：群友发来的视频（video 段）→ 下载 → 提取音频（ASR 转文字）
 * / 抽关键帧（给视觉模型看）→ 提示模型，让万生玲能"看懂/听到"视频内容。
 *
 * 接入方式（与现有模块隔离）：
 *   本文件是骨架，已挂载到 registry；onMessage 检测到 video 段但**暂不处理**
 *   （保持现状：视频消息被忽略）。后续实现只需填 onMessage 内部：
 *
 *   1. const v = extractByType(ctx.msg.message, 'video')              // segments.mjs
 *   2. const saved = await downloadVideo(v[0], workdir, bot.request)  // segments.mjs（已实现下载）
 *   3. const frames = await extractVideoFrames(saved.path, workdir)   // 🔒 ffmpeg 预留
 *      const audio = await extractAudio(saved.path, workdir)          // 🔒 ffmpeg 预留
 *   4. ctx.text = `（收到一个视频，已提取关键帧：${frames.join(',')}，用视觉工具看）` → return false
 *
 * 依赖（deps）：{ bot, groups, config, log }（按需扩展）
 */

'use strict'

import { extractByType } from '../segments.mjs'

export function createVideoFeature(deps) {
  const { log } = deps

  return {
    name: 'video',

    /** 检测视频段；🔒 预留：实现见文件头注释，当前不处理不拦截（保持现状） */
    async onMessage(ctx) {
      const vids = extractByType(ctx.msg?.message, 'video')
      if (!vids.length) return false
      log('info', '[qq-bridge][video] 收到视频消息（预留能力，暂不解析）')
      return false
    },
  }
}
