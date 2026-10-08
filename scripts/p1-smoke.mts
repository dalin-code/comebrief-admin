/**
 * P1 冒烟测试：验证 lib/aiProvider.ts 的三条关键链路
 *   1. Gemini 直连 + JSON 模式
 *   2. system / user 分层注入（systemInstruction 真的生效）
 *   3. 主模型挂了 → 自动走 AI_MODEL_FALLBACK 兜底
 *
 * 用法：node scripts/p1-smoke.mts
 */
import { readFileSync, existsSync } from 'node:fs'
import { callText, describeAiRouting } from '../lib/aiProvider.ts'
import { buildStorySystemPrompt, buildStoryUserPrompt } from '../lib/storyPrompt.ts'

// node 直接跑脚本不会自动加载 .env.local，这里手动灌进 process.env
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('=')
    if (i <= 0) continue
    const k = s.slice(0, i).trim()
    const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (k && !process.env[k]) process.env[k] = v
  }
}

const line = (t: string) => console.log(`\n===== ${t} =====`)

line('路由表：每个任务会用哪个模型')
for (const r of describeAiRouting()) {
  console.log(`  ${r.task.padEnd(10)} ${r.ok ? '✓' : '✗'} ${r.spec.padEnd(26)} ${r.ok ? r.provider : r.error}`)
}

line('测试 1：Gemini 直连 + JSON 模式')
const t1 = await callText({
  task: 'util',
  prompt: '把这句话变成 JSON：{"ok": true, "note": "你好"}。只输出 JSON，不要别的。',
  jsonMode: true,
  maxOutputTokens: 200,
  temperature: 0.2,
})
console.log(t1.ok ? `✓ ${t1.provider}/${t1.model} ${t1.ms}ms → ${t1.text.slice(0, 120)}` : `✗ ${t1.status} ${t1.error}`)

line('测试 2：system / user 分层（写作宪法走 systemInstruction）')
const t2 = await callText({
  task: 'story',
  system: buildStorySystemPrompt(),
  prompt: buildStoryUserPrompt({
    combo: { genre: ['悬疑'], pov: ['第一人称'], pace: ['快'], style: ['白描'], ending: ['留白'], length: 400 },
    tagsByDimension: {},
    idea: '便利店店员发现监控里每天凌晨三点都有一个穿雨衣的人在门口站十分钟，从不进门。',
    materials: '',
    length: 400,
  }),
  temperature: 0.9,
  maxOutputTokens: 1600,
  timeoutMs: 55000,
})
if (t2.ok) {
  console.log(`✓ ${t2.provider}/${t2.model} ${t2.ms}ms 截断=${t2.truncated}`)
  console.log(t2.text.slice(0, 320).replace(/\n+/g, ' '))
} else {
  console.log(`✗ ${t2.status} ${t2.error}`)
}

line('测试 3：主模型不存在 → 自动兜底 AI_MODEL_FALLBACK')
const t3 = await callText({
  task: 'util',
  model: 'gemini:gemini-does-not-exist-xyz',
  prompt: '只回四个字：兜底成功',
  maxOutputTokens: 100,
  retries: 0,
})
console.log(
  t3.ok
    ? `✓ 兜底生效：${t3.provider}/${t3.model} attempts=${t3.attempts} ${t3.ms}ms → ${t3.text.slice(0, 60)}`
    : `✗ ${t3.status} ${t3.error}`
)
