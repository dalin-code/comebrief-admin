/**
 * 「同一份输入，短时间内别再问一次模型」（P2）。
 *
 * 为什么需要它（不是优化，是止损）：
 *   免费额度是按「每天/每分钟多少次请求」算的，而编辑页那几颗按钮没有防重复点击 ——
 *   模型回得慢，站长以为没点着，就连点三下；三下都是真请求，三倍地烧额度。
 *   摘要、标签这类**纯函数式**的任务（同样的输入就该得到同样的输出）完全可以复用上一次的结果。
 *
 * 两条能力：
 *   ① 结果记忆 —— 同样的 key 在 TTL 内直接返回上次的值；
 *   ② 并发去重（single-flight）—— 同一个 key 正在跑的时候，后来者等那一份结果，
 *      而不是另起一次请求。这一条才是「连点三下」的正解。
 *
 * ⚠️ 作用域：**单进程内存**。`npm run dev` 只有一个进程，效果最好；
 *    线上 Serverless 每个实例各记各的，属于「尽力而为」。
 *
 * ⚠️ 只用来包「同样输入 → 同样输出」的调用。翻译故意不用它（见 app/api/ai/excerpt 的说明）：
 *    「重译」这个动作的语义就是「换一版」，命中记忆会让站长以为按钮坏了。
 */
import { createHash } from 'node:crypto'

type Entry = { at: number; value: unknown }

const CACHE = new Map<string, Entry>()
const INFLIGHT = new Map<string, Promise<unknown>>()

/** 上限纯粹是防内存泄漏：超过就丢最早写进来的（Map 保持插入顺序，够用了） */
const MAX_ENTRIES = 100

/** 内容指纹 —— 长正文直接进 Map 的 key 太占地，也不便于日志里看 */
export const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')

export type MemoResult<T> = {
  value: T
  /** true = 没花额度：要么命中记忆，要么复用了同一时刻另一个请求的结果 */
  cached: boolean
}

/**
 * 包一层记忆 + 并发去重。
 *
 * @param key    内容指纹（调用方自己拼，务必把「会影响输出的一切」都算进去）
 * @param ttlMs  记忆有效期。别设太长 —— 站长改完正文重新点，就该拿到新结果
 * @param fn     真正的调用
 * @param opts.cache 判断这次的结果值不值得记住。默认都记；
 *                   AI 调用一定要传「只记成功」——不然一次 429 会被记 5 分钟，
 *                   站长改完配置回来点，还是那句「被限流了」，能气死人。
 */
export async function memoAiCall<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  opts?: { cache?: (value: T) => boolean }
): Promise<MemoResult<T>> {
  const hit = CACHE.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return { value: hit.value as T, cached: true }

  // 同一个 key 正在跑 → 等那一份，别再起一次（这就是「连点三下」的挡板）
  const running = INFLIGHT.get(key)
  if (running) {
    const value = (await running) as T
    return { value, cached: true }
  }

  const task = fn()
  INFLIGHT.set(key, task)
  try {
    const value = await task
    if (!opts?.cache || opts.cache(value)) {
      CACHE.set(key, { at: Date.now(), value })
      while (CACHE.size > MAX_ENTRIES) {
        const oldest = CACHE.keys().next().value
        if (oldest === undefined) break
        CACHE.delete(oldest)
      }
    }
    return { value, cached: false }
  } finally {
    INFLIGHT.delete(key)
  }
}

/**
 * 强制跳过记忆用的 key。
 *
 * 为什么需要：站长看到摘要不满意，正文一个字没改就再点一次 —— 这时候命中记忆
 * 会原样返回，他会以为按钮坏了。请求体里带 `fresh: true` 时用这个拼 key，
 * 等于「这次一定要重新问模型」。
 */
let freshSeq = 0
export const freshKey = (key: string) => `${key}|fresh:${++freshSeq}`

/** 自检页用 */
export const memoStats = () => ({ entries: CACHE.size, inflight: INFLIGHT.size })

/** 给测试用：清空 */
export const memoClear = () => {
  CACHE.clear()
  INFLIGHT.clear()
}
