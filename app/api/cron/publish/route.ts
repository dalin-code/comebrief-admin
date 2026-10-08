import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'

/**
 * 定时发布引擎（P0）
 *
 * 背景：后台可以选「定时」并写入 scheduled_at，但没有任何东西在到点后把
 * status 从 'scheduled' 翻成 'published'，于是定时内容永远卡在草稿状态。
 * 这个路由就是那个「到点触发器」。
 *
 * 设计约束：
 * - 幂等：重复调用不会重复发布（update 时二次校验 status = 'scheduled'）
 * - 精确：published_at 取 scheduled_at，而不是本次运行的 now()。
 *   否则 cron 挂了一段时间后一次性补发，多篇内容会拿到同一个时间戳，
 *   首页按 published_at 排序的顺序就乱了。
 * - 可降级：阶段 0 的 SQL 还没跑时，published_at / publish_error 列可能不存在，
 *   此时自动退化成只更新 status，保证功能不至于整体不可用。
 * - service_role：绕过 RLS，也是唯一有权写这三张表的身份。
 *
 * 触发方式见 docs/scheduled-publishing.md
 */

export const runtime = 'nodejs'
export const maxDuration = 60

const TABLES = ['articles', 'stories', 'quizzes'] as const
type TableName = (typeof TABLES)[number]

/** 单次单表最多处理条数，防止异常数据导致长时间占用函数。 */
const MAX_PER_RUN = 200

const getBearer = (req: NextRequest) => {
  const h = req.headers.get('authorization') || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.trim() || ''
}

/** 判断 PostgREST 报错是不是「列不存在」，用于逐级降级。 */
const missingColumn = (message: string, table: TableName) => {
  const m1 = message.match(/Could not find the '([^']+)' column/i)
  const m2 = message.match(
    new RegExp(`column\\s+${table}\\.([a-zA-Z0-9_]+)\\s+does\\s+not\\s+exist`, 'i')
  )
  return Boolean(m1?.[1] || m2?.[1])
}

type RunResult = {
  table: TableName
  ok: boolean
  dry?: boolean
  published?: string[]
  would_publish?: string[]
  failed?: Array<{ id: string; error: string }>
  error?: string
}

async function publishDue(client: any, table: TableName, dry: boolean): Promise<RunResult> {
  const nowIso = new Date().toISOString()

  const picked = await client
    .from(table)
    .select('id,title,scheduled_at')
    .eq('status', 'scheduled')
    .not('scheduled_at', 'is', null)
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(MAX_PER_RUN)

  if (picked.error) {
    return { table, ok: false, error: `${picked.error.code || ''} ${picked.error.message || 'select failed'}`.trim() }
  }

  const rows = (picked.data || []) as Array<{ id: string; title?: string; scheduled_at?: string }>

  if (dry) {
    return { table, ok: true, dry: true, would_publish: rows.map((r) => r.id) }
  }

  const published: string[] = []
  const failed: Array<{ id: string; error: string }> = []

  for (const row of rows) {
    const publishedAt = row.scheduled_at || nowIso

    // stories 的前台是按 active 布尔值过滤的（ComeBrief 的 stories/page.tsx、
    // 首页 page.tsx、search 都带 .eq('active', true)），所以「到点上线」必须同时
    // 把 active 置真，否则 status 翻成 published 了、前台却依然看不到。
    //
    // quizzes 的前台【不】做 active 过滤（00_recon 已确认：22 条测验全是
    // active = false，却照常可见）。这里一并置真只是让 active 与 status 保持
    // 一致，多余但无害，并能防止日后给前台补上该过滤时踩雷。
    const withActive = table !== 'articles'

    // 由「最完整」到「最保守」依次尝试，遇到缺列就降级重试。
    const candidates: Array<Record<string, unknown>> = [
      ...(withActive
        ? [
            { status: 'published', active: true, published_at: publishedAt, publish_error: null },
            { status: 'published', active: true, published_at: publishedAt },
            { status: 'published', active: true },
          ]
        : []),
      { status: 'published', published_at: publishedAt, publish_error: null },
      { status: 'published', published_at: publishedAt },
      { status: 'published' },
    ]

    let done = false
    let lastError = 'unknown'

    for (const payload of candidates) {
      const res = await client
        .from(table)
        .update(payload)
        // 二次校验：并发或重复调用时，已经翻过的行不会被再次写入
        .eq('id', row.id)
        .eq('status', 'scheduled')
        .select('id')

      if (!res.error) {
        done = true
        break
      }

      lastError = res.error.message || String(res.error)
      if (!missingColumn(lastError, table)) break
    }

    if (done) published.push(row.id)
    else failed.push({ id: row.id, error: lastError })
  }

  return { table, ok: true, published, failed }
}

async function run(req: NextRequest, dry: boolean) {
  const startedAt = new Date().toISOString()

  const admin = getSupabaseAdminClient()
  if (!admin.ok) {
    return Response.json(
      { ok: false, error: admin.error || 'missing SUPABASE_SERVICE_ROLE_KEY', env: admin.env },
      { status: 500 }
    )
  }

  const results: RunResult[] = []
  for (const table of TABLES) {
    try {
      results.push(await publishDue(admin.client, table, dry))
    } catch (e: any) {
      results.push({ table, ok: false, error: e?.message || 'unexpected error' })
    }
  }

  const updated = {
    articles: results.find((r) => r.table === 'articles')?.published?.length ?? 0,
    stories: results.find((r) => r.table === 'stories')?.published?.length ?? 0,
    quizzes: results.find((r) => r.table === 'quizzes')?.published?.length ?? 0,
  }

  const errors = results.filter((r) => !r.ok).map((r) => ({ table: r.table, error: r.error }))
  const total = updated.articles + updated.stories + updated.quizzes

  if (total > 0 || errors.length > 0) {
    console.log('[cron-publish]', JSON.stringify({ startedAt, dry, updated, errors }))
  }

  return Response.json({
    ok: errors.length === 0,
    dry,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    updated,
    results,
    errors,
  })
}

/**
 * 鉴权：
 * - 配了 CRON_SECRET → 必须带对（Vercel Cron 会自动带上 Authorization: Bearer <CRON_SECRET>）
 * - 没配 CRON_SECRET → 生产环境拒绝执行，避免裸奔的公开写接口；开发环境放行方便调试
 *
 * 返回 null 表示放行，返回 Response 表示直接拒绝。
 */
function authorize(req: NextRequest): Response | null {
  const secret = (process.env.CRON_SECRET || '').trim()
  const provided = (new URL(req.url).searchParams.get('secret') || '').trim() || getBearer(req)

  if (secret) {
    if (provided === secret) return null
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  if (process.env.NODE_ENV === 'production') {
    return Response.json(
      {
        ok: false,
        error:
          'CRON_SECRET is not configured. Set it in the Vercel project env, then call this route with Authorization: Bearer <CRON_SECRET>.',
      },
      { status: 503 }
    )
  }

  return null
}

export async function GET(req: NextRequest) {
  const denied = authorize(req)
  if (denied) return denied
  return run(req, new URL(req.url).searchParams.get('dry') === '1')
}

export async function POST(req: NextRequest) {
  const denied = authorize(req)
  if (denied) return denied
  return run(req, new URL(req.url).searchParams.get('dry') === '1')
}
