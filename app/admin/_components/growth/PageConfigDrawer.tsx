'use client'

import { useState } from 'react'
import { Loader2, Send, X } from 'lucide-react'
import {
  normalizeTopicConfig,
  pageReadiness,
  type GrowthCategoryType,
  type GrowthDefaults,
  type GrowthPagePreset,
  type GrowthTopicConfig,
} from '@/lib/growth'
import { supabase } from '@/lib/supabase'
import GrowthPanel, {
  EMPTY_GROWTH_DRAFT,
  draftFromRow,
  draftToPageFields,
  type GrowthDraft,
} from './GrowthPanel'
import { missingColumnFromError, notifyRevalidate, pushSinglePage } from './actions'

/**
 * 页面级配置抽屉。
 *
 * 为什么是抽屉而不是 `/growth/topics/[slug]` 独立页：配置只有 9 个字段，
 * 但站长要「一页一页往过扫」—— 独立页每次都得回列表，扫 20 个分类要按 40 次
 * 返回。抽屉关掉就是列表，改完立刻能看到那张卡从「3/5」变成「5/5」。
 *
 * 保存是**整行 upsert**（不是 patch）：这一页的 9 个字段全在表单里，
 * 空字符串代表「清空该项」，必须真的写进去 —— 用 patch 就永远删不掉旧标题。
 */

type Props = {
  open: boolean
  /** 预置页（slug 与名称来自代码）；库里已有的非预置路径时为 null */
  preset: GrowthPagePreset | null
  /** 库里已有的行；没有就是新建 */
  row: GrowthTopicConfig | null
  slug: string
  defaults: GrowthDefaults
  onClose: () => void
  onSaved: (config: GrowthTopicConfig, note: string) => void
}

const FIELD =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/15'

export default function PageConfigDrawer({ open, preset, row, slug, defaults, onClose, onSaved }: Props) {
  // 表单初值直接由 props 推导，不在 effect 里回填：列表页用 `key` 保证换页/存完重挂载，
  // 这样就不会把上一页的文案带到这一页（也避免 React Compiler 报 set-state-in-effect）。
  const [draft, setDraft] = useState<GrowthDraft>(() => (row ? draftFromRow(row) : EMPTY_GROWTH_DRAFT))
  const [pageName, setPageName] = useState(() => row?.page_name || preset?.label || '')
  const [categoryType, setCategoryType] = useState<GrowthCategoryType>(
    () => row?.category_type || preset?.category_type || 'general'
  )
  const [busy, setBusy] = useState<'' | 'save' | 'push'>('')
  const [error, setError] = useState('')
  /** 只推送（不保存）时的回执；保存的回执交给列表页的横幅 —— 保存后本组件会重挂载。 */
  const [pushNote, setPushNote] = useState('')

  if (!open) return null

  const preview = normalizeTopicConfig({
    slug,
    page_name: pageName,
    category_type: categoryType,
    ...draftToPageFields(draft),
  })
  const readiness = pageReadiness(preview)

  /** 保存（可选：保存后顺手推这一页）。缺列就剔掉重试，别让整行失败。 */
  const save = async (alsoPush: boolean) => {
    if (!slug) return
    if (!pageName.trim()) {
      setError('页面名称不能为空')
      return
    }
    setBusy('save')
    setError('')
    setPushNote('')

    let payload: Record<string, unknown> = {
      slug,
      page_name: pageName.trim().slice(0, 60),
      category_type: categoryType,
      ...draftToPageFields(draft),
    }

    let lastError = ''
    for (let i = 0; i < 10; i += 1) {
      const { error: dbError } = await supabase.from('seo_topic_configs').upsert(payload, { onConflict: 'slug' })
      if (!dbError) {
        lastError = ''
        break
      }
      lastError = dbError.message
      const column = missingColumnFromError(dbError.message)
      if (column && column in payload) {
        const next = { ...payload }
        delete next[column]
        payload = next
        continue
      }
      break
    }

    if (lastError) {
      setBusy('')
      setError(
        /relation .* does not exist|schema cache/i.test(lastError)
          ? `表 seo_topic_configs 还不存在：先在 Supabase 跑 supabase/52_growth_seo_geo.sql（${lastError}）`
          : `保存失败：${lastError}`
      )
      return
    }

    const { data } = await supabase.from('seo_topic_configs').select('*').eq('slug', slug).maybeSingle()
    const saved = normalizeTopicConfig(data || payload)

    const parts: string[] = ['已保存']
    const revalidate = await notifyRevalidate()
    if (revalidate.ok) parts.push('前台缓存已刷新')
    else if (revalidate.message) parts.push(revalidate.message)

    let pushMessage = ''
    if (alsoPush && defaults.auto_index_on_save) {
      const push = await pushSinglePage(slug)
      pushMessage = push.message
      parts.push(push.message)
    }

    setBusy('')
    onSaved(saved, parts.join(' · '))
  }

  const pushOnly = async () => {
    setBusy('push')
    setError('')
    setPushNote('')
    const res = await pushSinglePage(slug)
    setBusy('')
    if (res.ok) setPushNote(res.message)
    else setError(res.message)
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="关闭" onClick={onClose} className="absolute inset-0 bg-slate-900/30" />
      <div className="relative flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900">{pageName || preset?.label || '页面配置'}</div>
            <div className="mt-1 truncate font-mono text-[11px] text-slate-400">{slug}</div>
            <div className="mt-2 flex items-center gap-2">
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">
                {readiness.filled}/{readiness.total} 项就绪
              </span>
              {row ? (
                <span className="text-[10px] text-slate-400">
                  最近更新 {row.updated_at ? row.updated_at.slice(0, 10) : '—'}
                </span>
              ) : (
                <span className="text-[10px] text-amber-600">尚未创建</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-400 hover:bg-slate-50"
            aria-label="关闭抽屉"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1.5 text-xs font-semibold text-slate-700">页面名称</div>
              <input className={FIELD} value={pageName} onChange={(e) => setPageName(e.target.value)} />
            </div>
            <div>
              <div className="mb-1.5 text-xs font-semibold text-slate-700">类型</div>
              <select
                className={FIELD}
                value={categoryType}
                onChange={(e) => setCategoryType(e.target.value as GrowthCategoryType)}
                disabled={!!preset}
              >
                <option value="general">general</option>
                <option value="quiz">quiz</option>
                <option value="story">story</option>
                <option value="brief">brief</option>
              </select>
            </div>
          </div>

          <GrowthPanel
            scope="page"
            value={draft}
            onChange={setDraft}
            title={pageName || preset?.label || slug}
            pagePath={slug}
            url={slug}
            brandSuffix={defaults.brand_suffix}
            disabled={busy !== ''}
          />

          {error ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>
          ) : null}
          {pushNote ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              {pushNote}
            </div>
          ) : null}
        </div>

        <footer className="flex flex-wrap items-center gap-3 border-t border-slate-100 px-6 py-4">
          <button
            type="button"
            onClick={() => save(false)}
            disabled={busy !== ''}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-slate-900 px-5 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:bg-slate-300"
          >
            {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            保存
          </button>
          <button
            type="button"
            onClick={() => save(true)}
            disabled={busy !== ''}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-emerald-500 px-5 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:bg-slate-200 disabled:text-slate-500"
          >
            保存并推送
          </button>
          <button
            type="button"
            onClick={pushOnly}
            disabled={busy !== '' || !row}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 px-4 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:text-slate-300"
          >
            <Send className="h-3.5 w-3.5" /> 只推送此页
          </button>
          <span className="ml-auto text-[11px] text-slate-400">
            {defaults.auto_index_on_save ? '保存时默认推送（可在全局默认里关掉）' : '保存时默认不推送'}
          </span>
        </footer>
      </div>
    </div>
  )
}

