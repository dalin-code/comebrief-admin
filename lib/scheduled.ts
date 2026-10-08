/**
 * 定时发布的「到点即已发布」判定与自愈工具（articles / stories / quizzes 共用）
 *
 * 背景：后台选「定时」时只写 scheduled_at + status = 'scheduled'。
 * 但 ComeBrief 前台的可见性规则是（见 ComeBrief/lib/visibility.ts 与
 * supabase/20_visibility.sql 的 articles_public_read 策略）：
 *
 *   status = 'published'
 *   或 (status = 'scheduled' and scheduled_at is not null and scheduled_at <= now())
 *
 * 于是会撞上这个尴尬状态：到点后【前台已经能看到这篇内容】，后台列表却还写着
 * 「定时」——因为后台读的是 status 原始值，而没有谁把 status 翻正
 * （真正的翻正依赖外部调度：/api/cron/publish + GitHub Actions 或 Vercel Cron，
 * 一旦那个定时器没配好/漏跑，状态就永远停在 scheduled）。
 *
 * 这里做两件事，让后台不再依赖外部调度器：
 *
 *   1. `effectiveStatus()` —— 展示层兜底：到点的定时内容一律按「已发布」显示，
 *      与前台可见性规则逐字对齐（前台看得见 = 后台显示已发布）。
 *   2. `publishDueRows()` —— 写库自愈：列表加载时把到点的行真正翻成 published
 *      （published_at 取 scheduled_at，而不是本次运行的 now()，避免补发时
 *      多篇内容拿到同一个时间戳、把首页按时间排序打乱）。
 *      stories 的前台是按 active 过滤的，所以同时置 active = true。
 *
 * 幂等：update 时二次校验 status = 'scheduled'，重复调用不会重复发布。
 * 降级：published_at / publish_error / active 等列不存在时自动剔除该字段重试
 *       （与 app/api/cron/publish/route.ts 的策略保持一致）。
 * 容错：写库失败（未登录、RLS 拒绝等）不抛错、不阻断列表渲染 —— 调用方
 *       拿到 failed 列表自行决定是否提示，展示层仍有 effectiveStatus 兜底。
 */

export type PublishTable = 'articles' | 'stories' | 'quizzes'

export type ScheduledRow = {
  id: string
  status?: string | null
  scheduled_at?: string | null
  active?: boolean | null
  published_at?: string | null
}

export type PublishDueResult = {
  /** 本次真正被翻成 published 的 id */
  flipped: string[]
  /** 尝试过但失败的（附错误原因），UI 可据此提示 */
  failed: Array<{ id: string; error: string }>
}

const toTime = (value: Date | number | string): number => {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  return new Date(value).getTime()
}

/** status / scheduled_at 维度上「已经到点」的行。 */
export function isDue(row: ScheduledRow | null | undefined, now: Date | number = Date.now()): boolean {
  if (String(row?.status || '').trim() !== 'scheduled') return false
  const raw = row?.scheduled_at
  if (!raw) return false
  const at = toTime(raw)
  return Number.isFinite(at) && at <= toTime(now)
}

/**
 * 展示用状态：到点的定时内容 = 已发布。
 *
 * status 为空的历史行沿用老的 active 布尔推断（与 stories / quizzes 列表页
 * 原本的 rowStatus() 行为一致）。
 */
export function effectiveStatus(
  row: ScheduledRow | null | undefined,
  now: Date | number = Date.now()
): string {
  if (isDue(row, now)) return 'published'
  const status = String(row?.status || '').trim()
  if (status) return status
  return row?.active === false ? 'draft' : 'published'
}

/** 该行「对外生效」的时间：已发布用 published_at，到点未翻正用 scheduled_at。 */
export function publishedAtOf(
  row: ScheduledRow | null | undefined,
  now: Date | number = Date.now()
): string | null {
  if (row?.published_at) return row.published_at
  if (isDue(row, now)) return row?.scheduled_at || null
  return null
}

/**
 * 逐级降级的更新载荷：由「最完整」到「最保守」，遇到缺列就换下一个。
 * articles 没有 active 的语义，不写它。
 */
function payloadCandidates(table: PublishTable, publishedAt: string): Array<Record<string, unknown>> {
  const base: Array<Record<string, unknown>> = [
    { status: 'published', published_at: publishedAt, publish_error: null },
    { status: 'published', published_at: publishedAt },
    { status: 'published' },
  ]

  if (table === 'articles') return base

  return [
    { status: 'published', active: true, published_at: publishedAt, publish_error: null },
    { status: 'published', active: true, published_at: publishedAt },
    { status: 'published', active: true },
    ...base,
  ]
}

const isMissingColumn = (message: string): boolean =>
  /Could not find the '([^']+)' column|column\s+\S+\s+does\s+not\s+exist/i.test(String(message || ''))

/**
 * 把 rows 里所有「到点」的行真正翻成 published。
 *
 * @param client 已登录（authenticated）的 supabase 客户端；service_role 亦可
 * @param table  articles / stories / quizzes
 * @param rows   列表里已经取到的行（需要 id / status / scheduled_at）
 */
export async function publishDueRows(
  client: any,
  table: PublishTable,
  rows: ScheduledRow[] | null | undefined,
  now: Date | number = Date.now()
): Promise<PublishDueResult> {
  const due = (rows || []).filter((row) => isDue(row, now))
  if (due.length === 0) return { flipped: [], failed: [] }

  const flipped: string[] = []
  const failed: Array<{ id: string; error: string }> = []

  for (const row of due) {
    const publishedAt = row.scheduled_at || new Date(toTime(now)).toISOString()
    let done = false
    let lastError = 'unknown'

    for (const payload of payloadCandidates(table, publishedAt)) {
      const res = await client
        .from(table)
        .update(payload)
        .eq('id', row.id)
        // 二次校验：并发或重复调用时，已经翻过的行不会被再次写入
        .eq('status', 'scheduled')
        .select('id')

      if (!res?.error) {
        done = true
        break
      }

      lastError = res.error.message || String(res.error)
      if (!isMissingColumn(lastError)) break
    }

    if (done) flipped.push(row.id)
    else failed.push({ id: row.id, error: lastError })
  }

  if (failed.length) {
    console.warn(`[scheduled] ${table} 到点内容发布失败 ${failed.length} 条：`, failed)
  }

  return { flipped, failed }
}

/**
 * 把「已翻正」的结果合并回列表状态，省掉一次重新查询。
 * 只改状态相关的字段，其余字段原样保留。
 */
export function markPublishedLocally<T extends ScheduledRow>(rows: T[], flipped: string[]): T[] {
  if (flipped.length === 0) return rows
  const ids = new Set(flipped)
  return rows.map((row) =>
    ids.has(row.id)
      ? ({
          ...row,
          status: 'published',
          active: true,
          published_at: row.scheduled_at || row.published_at || null,
        } as T)
      : row
  )
}
