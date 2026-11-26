'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2, Pencil, Search, Send, Settings2 } from 'lucide-react'
import IndexNowButton from '@/app/admin/_components/IndexNowButton'
import {
  GROWTH_DEFAULTS_FALLBACK,
  GROWTH_PAGE_PRESETS,
  normalizeTopicConfigList,
  pageReadiness,
  type GrowthDefaults,
  type GrowthPagePreset,
  type GrowthTopicConfig,
} from '@/lib/growth'
import { supabase } from '@/lib/supabase'
import PageConfigDrawer from '@/app/admin/_components/growth/PageConfigDrawer'
import { loadGrowthDefaults, pushSinglePage } from '@/app/admin/_components/growth/actions'

/**
 * 页面级 SEO / GEO 配置列表（`/admin/growth/topics`）。
 *
 * 数据来源是**两处合并**，不是只读库：
 *   · `GROWTH_PAGE_PRESETS`（代码里的 true source：4 个聚合页 + quiz_topics 分类页）
 *   · `seo_topic_configs`（站长填的文案）
 * 只读库的话，SQL 52 还没跑时整页空白，站长根本不知道该建哪些页；只读代码的话，
 * 手写 SQL 建的额外路径就永远不在列表里、永远编辑不到。所以合并 + 角标区分。
 *
 * 列表上的「就绪度」用 `pageReadiness()`：与抽屉、CI 断言同一套判定，
 * 不会出现「列表 5/5、抽屉说 3/5」。SEO 标题/描述显示的是**字符数**而不是
 * 全文 —— 一眼能看出「填了但会被截断」和「根本没填」的区别。
 */

type Item = {
  slug: string
  label: string
  preset: GrowthPagePreset | null
  config: GrowthTopicConfig | null
  group: 'hub' | 'topic' | 'custom'
}

type Filter = 'all' | 'hub' | 'topic' | 'custom'
type Todo = 'all' | 'todo' | 'ready'

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'hub', label: '聚合页' },
  { key: 'topic', label: '分类页' },
  { key: 'custom', label: '自定义路径' },
]

const TODOS: Array<{ key: Todo; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'todo', label: '待补' },
  { key: 'ready', label: '已就绪' },
]

function mergeItems(rows: GrowthTopicConfig[]): Item[] {
  const byPath = new Map<string, GrowthTopicConfig>()
  for (const row of rows) byPath.set(row.slug, row)

  const items: Item[] = GROWTH_PAGE_PRESETS.map((preset) => ({
    slug: preset.path,
    label: byPath.get(preset.path)?.page_name || preset.label,
    preset,
    config: byPath.get(preset.path) || null,
    group: preset.group,
  }))

  // 库里额外存在的路径（手写 SQL 建的、或历史遗留）排在最后，别藏在预置页中间
  for (const row of rows) {
    if (GROWTH_PAGE_PRESETS.some((preset) => preset.path === row.slug)) continue
    items.push({ slug: row.slug, label: row.page_name || row.slug, preset: null, config: row, group: 'custom' })
  }
  return items
}

export default function GrowthTopicsPage() {
  const [rows, setRows] = useState<GrowthTopicConfig[]>([])
  const [defaults, setDefaults] = useState<GrowthDefaults>(GROWTH_DEFAULTS_FALLBACK)
  const [loading, setLoading] = useState(true)
  const [tableMissing, setTableMissing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null)

  const [filter, setFilter] = useState<Filter>('all')
  const [todo, setTodo] = useState<Todo>('all')
  const [query, setQuery] = useState('')

  const [openSlug, setOpenSlug] = useState('')
  const [drawerSeq, setDrawerSeq] = useState(0)
  const [pushing, setPushing] = useState('')

  // 首屏读取：先 await 再 setState（同步 setState in effect 会被 React Compiler 规则拦下）。
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const [listRes, defaultsRes] = await Promise.all([
        supabase.from('seo_topic_configs').select('*').order('slug'),
        loadGrowthDefaults(),
      ])
      if (cancelled) return

      setDefaults(defaultsRes.defaults)
      if (listRes.error) {
        const message = listRes.error.message || ''
        setRows([])
        setLoadError(message)
        setTableMissing(/relation .* does not exist|schema cache|Could not find the table/i.test(message))
      } else {
        setRows(normalizeTopicConfigList(listRes.data))
        setLoadError('')
        setTableMissing(false)
      }
      setLoading(false)
    }
    run()
    return () => {
      cancelled = true
    }
  }, [])

  const items = useMemo(() => mergeItems(rows), [rows])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((item) => {
      if (filter !== 'all' && item.group !== filter) return false
      const readiness = item.config ? pageReadiness(item.config) : null
      const isReady = readiness ? readiness.level === 'ready' : false
      if (todo === 'todo' && isReady) return false
      if (todo === 'ready' && !isReady) return false
      if (!q) return true
      return item.slug.toLowerCase().includes(q) || item.label.toLowerCase().includes(q)
    })
  }, [items, filter, todo, query])

  const stats = useMemo(() => {
    const total = items.length
    let ready = 0
    let configured = 0
    for (const item of items) {
      if (!item.config) continue
      configured += 1
      if (pageReadiness(item.config).level === 'ready') ready += 1
    }
    return { total, configured, ready }
  }, [items])

  const activeItem = items.find((item) => item.slug === openSlug) || null

  const pushItem = async (slug: string) => {
    setPushing(slug)
    const res = await pushSinglePage(slug)
    setPushing('')
    setNotice({ kind: res.ok ? 'ok' : 'warn', text: `${slug} · ${res.message}` })
  }

  return (
    <div className="min-h-screen bg-slate-50 px-6 py-10">
      <div className="mx-auto w-full max-w-6xl">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link
              href="/admin/growth"
              className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-400 transition hover:text-slate-700"
            >
              <ArrowLeft className="h-3 w-3" /> 增长引擎
            </Link>
            <h1 className="mt-2 text-2xl font-semibold text-slate-900">页面级 SEO / GEO</h1>
            <div className="mt-1 text-sm text-slate-500">
              聚合页与分类页的标题、描述、导语、TL;DR、问答、OG 图。留空 = 前台继续用原来的默认文案。
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/admin/growth/defaults"
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
            >
              <Settings2 className="h-3.5 w-3.5" /> 全局默认
            </Link>
            <IndexNowButton className="h-9 rounded-xl px-3 text-[11px]" />
          </div>
        </div>

        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          {[
            { label: '页面总数', value: stats.total, hint: '代码预置 + 库里自定义路径' },
            { label: '已建配置', value: stats.configured, hint: 'seo_topic_configs 里的行数' },
            { label: '完全就绪', value: stats.ready, hint: '5 项全填（含 ≥3 组问答）' },
          ].map((card) => (
            <div key={card.label} className="rounded-2xl border border-slate-200 bg-white px-5 py-4">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{card.label}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{card.value}</div>
              <div className="mt-1 text-[11px] text-slate-400">{card.hint}</div>
            </div>
          ))}
        </div>

        {tableMissing ? (
          <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900">
            <b>表 seo_topic_configs 还不存在。</b>先在 Supabase SQL Editor 整份执行{' '}
            <code className="rounded bg-amber-100 px-1">supabase/52_growth_seo_geo.sql</code>，再刷新本页。
            下面列出的预置页来自代码，可以看，但存不进去。
          </div>
        ) : loadError ? (
          <div className="mb-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700">
            读取配置失败：{loadError}
          </div>
        ) : null}

        {notice ? (
          <div
            className={`mb-5 flex items-start justify-between gap-4 rounded-2xl border px-4 py-3 text-xs ${
              notice.kind === 'ok'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-amber-200 bg-amber-50 text-amber-900'
            }`}
          >
            <span className="leading-relaxed">{notice.text}</span>
            <button type="button" onClick={() => setNotice(null)} className="shrink-0 text-[11px] underline">
              关闭
            </button>
          </div>
        ) : null}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition ${
                filter === f.key ? 'bg-slate-900 text-white' : 'bg-white text-slate-500 hover:text-slate-800'
              }`}
            >
              {f.label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-slate-200" />
          {TODOS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTodo(t.key)}
              className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition ${
                todo === t.key ? 'bg-emerald-500 text-emerald-950' : 'bg-white text-slate-500 hover:text-slate-800'
              }`}
            >
              {t.label}
            </button>
          ))}
          <div className="relative ml-auto w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜路径或页面名…"
              className="h-9 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-xs text-slate-900 outline-none focus:border-emerald-500/60"
            />
          </div>
        </div>


        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="hidden grid-cols-[minmax(0,1fr)_80px_110px_70px_60px_150px] gap-3 border-b border-slate-100 px-5 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 md:grid">
            <span>页面</span>
            <span>类型</span>
            <span>就绪度</span>
            <span>问答</span>
            <span>更新</span>
            <span className="text-right">操作</span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 px-5 py-12 text-xs text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> 读取配置…
            </div>
          ) : visible.length === 0 ? (
            <div className="px-5 py-12 text-center text-xs text-slate-400">
              没有符合条件的页面。换个筛选，或把搜索框清空。
            </div>
          ) : (
            visible.map((item) => {
              const readiness = item.config ? pageReadiness(item.config) : null
              const percent = readiness?.percent ?? 0
              const bar =
                readiness?.level === 'ready'
                  ? 'bg-emerald-500'
                  : readiness?.level === 'partial'
                    ? 'bg-amber-400'
                    : 'bg-slate-200'
              return (
                <div
                  key={item.slug}
                  className="grid gap-3 border-b border-slate-50 px-5 py-3 last:border-0 md:grid-cols-[minmax(0,1fr)_80px_110px_70px_60px_150px] md:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-900">{item.label}</span>
                      {item.group === 'custom' ? (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-500">
                          自定义
                        </span>
                      ) : null}
                      {item.config?.is_noindex ? (
                        <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[9px] font-bold text-rose-600">
                          noindex
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-slate-400">{item.slug}</div>
                    <div className="mt-1 text-[10px] text-slate-400 md:hidden">
                      {readiness
                        ? `${readiness.filled}/${readiness.total} 项 · ${item.config?.geo_faq_list.length || 0} 组问答`
                        : '未创建'}
                    </div>
                  </div>

                  <div className="text-[11px] text-slate-500">
                    {item.config?.category_type || item.preset?.category_type || 'general'}
                  </div>

                  <div>
                    {readiness ? (
                      <>
                        <div className="flex items-center justify-between text-[10px] tabular-nums text-slate-400">
                          <span>
                            {readiness.filled}/{readiness.total}
                          </span>
                          <span>{percent}%</span>
                        </div>
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                          <div className={`h-full rounded-full ${bar}`} style={{ width: `${percent}%` }} />
                        </div>
                      </>
                    ) : (
                      <span className="text-[11px] text-amber-600">未创建</span>
                    )}
                  </div>

                  <div className="text-[11px] tabular-nums text-slate-500">
                    {item.config?.geo_faq_list.length || 0}/5
                  </div>

                  <div className="text-[10px] text-slate-400">
                    {item.config?.updated_at ? item.config.updated_at.slice(5, 10) : '—'}
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => pushItem(item.slug)}
                      disabled={pushing === item.slug}
                      title="只把这一页报给 Bing / Yandex"
                      className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-[11px] font-semibold text-slate-500 transition hover:bg-slate-50 disabled:text-slate-300"
                    >
                      {pushing === item.slug ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Send className="h-3 w-3" />
                      )}
                      推送
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDrawerSeq((seq) => seq + 1)
                        setOpenSlug(item.slug)
                      }}
                      className="inline-flex h-8 items-center gap-1 rounded-lg bg-slate-900 px-2.5 text-[11px] font-semibold text-white transition hover:bg-slate-800"
                    >
                      <Pencil className="h-3 w-3" /> 编辑
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
          「推送」走 IndexNow 单条模式：只推这一个地址，混入别的域名会被服务端 400 拦下。整站回填用右上角的
          IndexNow 按钮（按 sitemap 推全量）。
        </p>
      </div>

      {activeItem ? (
        <PageConfigDrawer
          // 每次打开都换 key：抽屉的表单初值来自 props，重挂载才能保证不带上一次的草稿
          key={`${activeItem.slug}#${drawerSeq}`}
          open={Boolean(openSlug)}
          preset={activeItem.preset}
          row={activeItem.config}
          slug={activeItem.slug}
          defaults={defaults}
          onClose={() => setOpenSlug('')}
          onSaved={(config, note) => {
            setRows((prev) => {
              const next = prev.filter((row) => row.slug !== config.slug)
              next.push(config)
              return next
            })
            if (note) setNotice({ kind: 'ok', text: `${config.slug} · ${note}` })
          }}
        />
      ) : null}
    </div>
  )
}
