'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2, RotateCcw, Save } from 'lucide-react'
import {
  GROWTH_DEFAULTS_FALLBACK,
  GROWTH_DEFAULT_TEMPLATES,
  SOCIAL_COPY_KEYS,
  SOCIAL_COPY_LIMITS,
  normalizeGrowthDefaults,
  renderTemplate,
  type GrowthDefaults,
  type SocialCopyKey,
} from '@/lib/growth'
import { buildUtmUrl } from '@/lib/growth'
import { SITE_URL } from '@/lib/siteUrl'
import { loadGrowthDefaults, saveGrowthDefaults } from '@/app/admin/_components/growth/actions'

/**
 * 全局默认（`/admin/growth/defaults`，读写 `seo_global_defaults.social_utm`）。
 *
 * 这一页是三处逻辑的**单一事实来源**：
 *   · 生成 SEO 标题时的品牌后缀（`brand_suffix`）；
 *   · 社媒文案里 `{url}` 拼出来的 UTM（medium / campaign）；
 *   · 六条平台模板的出厂文本（`templates`）。
 *
 * 三个必须做对的地方：
 *   ① 留空 = 用出厂值，而不是存一个空字符串。`normalizeGrowthDefaults()`
 *      逐键回落，所以这里的空输入保存后会变成默认值 —— 这一点要写在提示里，
 *      否则站长会以为自己「成功清空了」；
 *   ② `{title}` / `{url}` / `{brand}` 三个占位符是渲染契约，页面上给一条
 *      实时预览，让人看得见替换后的结果；
 *   ③ 预览里的链接带真实 UTM —— 这段文案最终会被复制到 Reddit / TikTok，
 *      链接错了事后从 GA 里看不出来（全部归到 direct）。
 */

const FIELD =
  'h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/15'

const TEMPLATE_LABEL: Record<SocialCopyKey, string> = {
  reddit_title: 'Reddit 标题',
  reddit_body: 'Reddit 正文',
  tiktok_caption: 'TikTok 配文',
  pinterest_title: 'Pinterest 标题',
  pinterest_description: 'Pinterest 描述',
  x_post_copy: 'X 帖子',
}

/** 预览用的样例页：用真实存在的一条路径，UTM 拼出来立刻能点。 */
const PREVIEW_PATH = '/quizzes/topic/career'
const PREVIEW_TITLE = 'Free Career Quiz: Instant Results, No Sign-Up'

export default function GrowthDefaultsPage() {
  const [form, setForm] = useState<GrowthDefaults>(GROWTH_DEFAULTS_FALLBACK)
  const [baseline, setBaseline] = useState<GrowthDefaults>(GROWTH_DEFAULTS_FALLBACK)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  // 首屏读取：先 await 再 setState（同步 setState in effect 会被 React Compiler 规则拦下）。
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const res = await loadGrowthDefaults()
      if (cancelled) return
      setForm(res.defaults)
      setBaseline(res.defaults)
      setError(res.ready ? '' : res.error || '还没读到 social_utm 这一行 —— 保存时会自动创建')
      setLoading(false)
    }
    run()
    return () => {
      cancelled = true
    }
  }, [])

  const patch = (next: Partial<GrowthDefaults>) => {
    setForm((prev) => ({ ...prev, ...next }))
    setNote('')
  }

  const patchTemplate = (key: SocialCopyKey, text: string) => {
    setForm((prev) => ({ ...prev, templates: { ...prev.templates, [key]: text } }))
    setNote('')
  }

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(baseline), [form, baseline])

  /** 预览链接：与社媒文案里 `{url}` 最终被替换成的那个地址一致。 */
  const previewUrl = useMemo(
    () =>
      buildUtmUrl(`${SITE_URL}${PREVIEW_PATH}`, {
        source: 'reddit',
        medium: form.utm_medium || GROWTH_DEFAULTS_FALLBACK.utm_medium,
        campaign: form.utm_campaign || GROWTH_DEFAULTS_FALLBACK.utm_campaign,
        content: PREVIEW_PATH.split('/').filter(Boolean).pop() || '',
      }),
    [form.utm_medium, form.utm_campaign]
  )

  const previewText = useMemo(() => {
    const normalized = normalizeGrowthDefaults(form)
    const vars = {
      title: renderTemplate(normalized.templates.reddit_title, { title: PREVIEW_TITLE, brand: normalized.brand_suffix }),
      url: previewUrl,
      brand: normalized.brand_suffix,
    }
    return renderTemplate(normalized.templates.reddit_body, vars)
  }, [form, previewUrl])

  const save = async () => {
    setBusy(true)
    setError('')
    setNote('')
    const normalized = normalizeGrowthDefaults(form)
    const res = await saveGrowthDefaults(normalized)
    setBusy(false)
    if (!res.ok) {
      setError(
        /relation .* does not exist|schema cache|Could not find the table/i.test(res.error)
          ? `表 seo_global_defaults 还不存在：先在 Supabase 跑 supabase/52_growth_seo_geo.sql（${res.error}）`
          : `保存失败：${res.error}`
      )
      return
    }
    setForm(normalized)
    setBaseline(normalized)
    setNote('已保存。留空的项按出厂值处理。')
  }

  const resetForm = () => {
    setForm(GROWTH_DEFAULTS_FALLBACK)
    setNote('已恢复为出厂值（还没保存，确认后点右侧保存）。')
  }

  return (
    <div className="min-h-screen bg-slate-50 px-6 py-10">
      <div className="mx-auto w-full max-w-4xl">
        <div className="mb-6">
          <Link
            href="/admin/growth/topics"
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-400 transition hover:text-slate-700"
          >
            <ArrowLeft className="h-3 w-3" /> 页面级 SEO / GEO
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-slate-900">全局默认</h1>
          <div className="mt-1 text-sm text-slate-500">
            品牌后缀、UTM 默认值、六条社媒模板。留空的字段保存时按出厂值处理（不会存成空字符串）。
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 py-12 text-xs text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> 读取 seo_global_defaults…
          </div>
        ) : (
          <div className="space-y-5">
            {error ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900">
                {error}
              </div>
            ) : null}
            {note ? (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800">
                {note}
              </div>
            ) : null}

            <section className="rounded-2xl border border-slate-200 bg-white p-6">
              <div className="mb-4 text-sm font-semibold text-slate-900">基础</div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="mb-1.5 text-xs font-semibold text-slate-700">品牌后缀</div>
                  <input
                    className={FIELD}
                    value={form.brand_suffix}
                    onChange={(e) => patch({ brand_suffix: e.target.value })}
                    placeholder={GROWTH_DEFAULTS_FALLBACK.brand_suffix}
                  />
                  <div className="mt-1 text-[11px] text-slate-400">
                    SEO 标题的尾部（<code>… | ComeBrief</code>）。已有标题不会被改写。
                  </div>
                </div>
                <div>
                  <div className="mb-1.5 text-xs font-semibold text-slate-700">默认 OG 图</div>
                  <input
                    className={FIELD}
                    value={form.default_og_image_url}
                    onChange={(e) => patch({ default_og_image_url: e.target.value })}
                    placeholder="留空 = 用前台各自的默认图"
                  />
                </div>
                <div>
                  <div className="mb-1.5 text-xs font-semibold text-slate-700">utm_medium</div>
                  <input
                    className={FIELD}
                    value={form.utm_medium}
                    onChange={(e) => patch({ utm_medium: e.target.value })}
                    placeholder={GROWTH_DEFAULTS_FALLBACK.utm_medium}
                  />
                </div>
                <div>
                  <div className="mb-1.5 text-xs font-semibold text-slate-700">utm_campaign</div>
                  <input
                    className={FIELD}
                    value={form.utm_campaign}
                    onChange={(e) => patch({ utm_campaign: e.target.value })}
                    placeholder={GROWTH_DEFAULTS_FALLBACK.utm_campaign}
                  />
                </div>
                <div className="sm:col-span-2">
                  <div className="mb-1.5 text-xs font-semibold text-slate-700">默认 subreddit</div>
                  <input
                    className={FIELD}
                    value={form.default_subreddit}
                    onChange={(e) => patch({ default_subreddit: e.target.value })}
                    placeholder={GROWTH_DEFAULTS_FALLBACK.default_subreddit}
                  />
                </div>
              </div>

              <label className="mt-5 flex items-start gap-3 rounded-xl border border-slate-200 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={form.auto_index_on_save}
                  onChange={(e) => patch({ auto_index_on_save: e.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-600"
                />
                <span>
                  <span className="text-xs font-semibold text-slate-700">保存后自动推送这一页（IndexNow）</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-400">
                    关掉之后，「保存并推送」按钮会退化成只保存 —— 想推就点列表里的「推送」。
                  </span>
                </span>
              </label>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-6">
              <div className="mb-1 text-sm font-semibold text-slate-900">社媒模板</div>
              <div className="mb-4 text-[11px] leading-relaxed text-slate-400">
                占位符：<code className="rounded bg-slate-100 px-1">{'{title}'}</code>{' '}
                <code className="rounded bg-slate-100 px-1">{'{url}'}</code>{' '}
                <code className="rounded bg-slate-100 px-1">{'{brand}'}</code>。生成文案时只替换这三个，别写别的花括号。
              </div>
              <div className="space-y-4">
                {SOCIAL_COPY_KEYS.map((key) => {
                  const text = form.templates[key] || ''
                  const over = text.length > SOCIAL_COPY_LIMITS[key]
                  return (
                    <div key={key}>
                      <div className="mb-1.5 flex items-center justify-between gap-3">
                        <span className="text-xs font-semibold text-slate-700">
                          {TEMPLATE_LABEL[key]}
                          <span className="ml-2 font-mono text-[10px] font-normal text-slate-400">{key}</span>
                        </span>
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[11px] tabular-nums ${over ? 'text-rose-600' : 'text-slate-400'}`}
                          >
                            {text.length}/{SOCIAL_COPY_LIMITS[key]}
                          </span>
                          <button
                            type="button"
                            onClick={() => patchTemplate(key, GROWTH_DEFAULT_TEMPLATES[key])}
                            className="text-[11px] font-semibold text-slate-400 underline transition hover:text-slate-700"
                          >
                            出厂
                          </button>
                        </div>
                      </div>
                      <textarea
                        className="min-h-[64px] w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-emerald-500/60"
                        value={text}
                        onChange={(e) => patchTemplate(key, e.target.value)}
                        placeholder={GROWTH_DEFAULT_TEMPLATES[key]}
                      />
                    </div>
                  )
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-slate-900 p-6 text-white">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold">预览 · Reddit 正文</div>
                <div className="text-[10px] text-slate-400">{previewUrl ? '链接已带 UTM' : 'URL 不可用'}</div>
              </div>
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-200">{previewText}</p>
              <div className="mt-3 truncate font-mono text-[10px] text-emerald-300">{previewUrl || '—'}</div>
            </section>

            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4">
              <button
                type="button"
                onClick={save}
                disabled={busy || !dirty}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-slate-900 px-5 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:bg-slate-300"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {busy ? '保存中…' : '保存'}
              </button>
              <button
                type="button"
                onClick={resetForm}
                disabled={busy}
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 px-4 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
              >
                <RotateCcw className="h-3.5 w-3.5" /> 恢复出厂值
              </button>
              <span className="ml-auto text-[11px] text-slate-400">
                {dirty ? '有未保存的改动' : '与已保存的一致'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

