'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Loader2, Plus, Trash2, WandSparkles } from 'lucide-react'
import { getFreshAccessToken } from '@/lib/clientAuth'
import {
  GROWTH_LIMITS,
  SOCIAL_COPY_KEYS,
  SOCIAL_PLATFORMS,
  countWords,
  growthFieldIssues,
  measureLength,
  normalizeSocialCopies,
  normalizeTargetEntities,
  parseFaqList,
  type GrowthContentFields,
  type GrowthFaqItem,
  type SocialCopyKey,
} from '@/lib/growth'

/**
 * 一篇内容 / 一个页面上的运营物料编辑器（SEO 标题、描述、TL;DR、GEO 问答、
 * 实体、四平台社媒文案）。
 *
 * 为什么做成**受控组件**而不是自己存库：详情页的保存路径各不相同
 * （quiz-studio、stories/create、trends/edit 各有一套 upsert 与「缺列重试」），
 * 面板只负责「把值改对、把话说清楚」，落库仍由各自的保存按钮完成 —— 这样
 * 站长不会遇到「内容存了、物料没存」或者反过来的半截状态。
 *
 * 三件在 UI 上必须做对的事：
 *   ① 计数器用 `measureLength()`，与 AI 归一化、CI 断言同一个判断，
 *      不会出现「面板绿、生成后被切」；
 *   ② `warn` 只提示、`error`（超硬上限）才红 —— 老内容一个字段都没填是常态，
 *      不能让人连改一个错别字都改不动；
 *   ③ 「AI 生成」只填草案，不自动保存：填完人看一眼再按保存。
 */

export type GrowthDraft = {
  seo_title: string
  seo_description: string
  intro_summary: string
  ai_tldr_summary: string
  geo_faq_list: GrowthFaqItem[]
  target_entities: string[]
  social_copies: Partial<Record<SocialCopyKey, string>>
  og_image_url: string
  is_noindex: boolean
}

export const EMPTY_GROWTH_DRAFT: GrowthDraft = {
  seo_title: '',
  seo_description: '',
  intro_summary: '',
  ai_tldr_summary: '',
  geo_faq_list: [],
  target_entities: [],
  social_copies: {},
  og_image_url: '',
  is_noindex: false,
}

/** 从库里的行（`seo_topic_configs` / `quizzes` / `stories` / `articles`）取草稿。 */
export function draftFromRow(row: any): GrowthDraft {
  return {
    seo_title: String(row?.seo_title ?? ''),
    seo_description: String(row?.seo_description ?? ''),
    intro_summary: String(row?.intro_summary ?? ''),
    ai_tldr_summary: String(row?.ai_tldr_summary ?? ''),
    geo_faq_list: parseFaqList(row?.geo_faq_list),
    target_entities: normalizeTargetEntities(row?.target_entities),
    social_copies: normalizeSocialCopies(row?.social_copies),
    og_image_url: String(row?.og_image_url ?? ''),
    is_noindex: row?.is_noindex === true,
  }
}

/** 只取内容级字段（详情页保存用）。 */
export function draftToContentFields(draft: GrowthDraft): GrowthContentFields {
  return {
    seo_title: draft.seo_title.trim(),
    seo_description: draft.seo_description.trim(),
    target_entities: normalizeTargetEntities(draft.target_entities),
    ai_tldr_summary: draft.ai_tldr_summary.trim(),
    geo_faq_list: parseFaqList(draft.geo_faq_list),
    social_copies: normalizeSocialCopies(draft.social_copies),
    is_noindex: draft.is_noindex,
  }
}

/** 只取页面级字段（`seo_topic_configs` 的列）。 */
export function draftToPageFields(draft: GrowthDraft) {
  return {
    seo_title: draft.seo_title.trim(),
    seo_description: draft.seo_description.trim(),
    intro_summary: draft.intro_summary.trim(),
    ai_tldr_summary: draft.ai_tldr_summary.trim(),
    geo_faq_list: parseFaqList(draft.geo_faq_list),
    og_image_url: draft.og_image_url.trim(),
    is_noindex: draft.is_noindex,
  }
}

const FIELD =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/15 disabled:bg-slate-50 disabled:text-slate-400'

/** 计数器配色：空=灰，越界=红，偏短=琥珀，合规=绿。 */
function counterTone(state: 'empty' | 'short' | 'ok' | 'long') {
  return state === 'long'
    ? 'text-rose-600'
    : state === 'short'
      ? 'text-amber-600'
      : state === 'ok'
        ? 'text-emerald-600'
        : 'text-slate-400'
}

function Counter({ value, limits }: { value: string; limits: { min: number; max: number } }) {
  const m = measureLength(value, limits)
  return <span className={`text-[11px] tabular-nums ${counterTone(m.state)}`}>{m.text}</span>
}

function Label({ text, hint, right }: { text: string; hint?: string; right?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-end justify-between gap-3">
      <div>
        <div className="text-xs font-semibold text-slate-700">{text}</div>
        {hint ? <div className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{hint}</div> : null}
      </div>
      {right}
    </div>
  )
}

type Props = {
  scope: 'content' | 'page'
  value: GrowthDraft
  onChange: (next: GrowthDraft) => void
  /** 送进提示词的事实（正文截多少由调用方决定） */
  title: string
  category?: string
  body?: string
  url?: string
  pagePath?: string
  brandSuffix?: string
  disabled?: boolean
}

export default function GrowthPanel({
  scope,
  value,
  onChange,
  title,
  category,
  body,
  url,
  pagePath,
  brandSuffix,
  disabled = false,
}: Props) {
  const [busy, setBusy] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState('')
  const [openSocial, setOpenSocial] = useState(false)
  /**
   * 实体输入框保留用户原样（含逗号、空格），提交时才归一化 ——
   * 边打边归一化会在用户敲完逗号前把分隔符吞掉。
   */
  const [entityText, setEntityText] = useState(() => value.target_entities.join(', '))
  useEffect(() => {
    setEntityText(value.target_entities.join(', '))
  }, [value.target_entities])

  const patch = (next: Partial<GrowthDraft>) => onChange({ ...value, ...next })
  const tldrWords = countWords(value.ai_tldr_summary)
  const errors = growthFieldIssues(draftToContentFields(value)).filter((i) => i.level === 'error')

  /**
   * 生成草案。scope=page 时不要社媒与实体 —— 那两列在 `seo_topic_configs`
   * 里不存在，生成了也存不进去（表现是「点了保存、下次打开又空了」）。
   */
  const generate = async () => {
    if (!title.trim()) {
      setError('先填内容标题，AI 需要它当锚点')
      return
    }
    setBusy(true)
    setError('')
    setWarnings([])
    try {
      const token = await getFreshAccessToken()
      if (!token) throw new Error('登录已过期，请重新登录后再生成')
      const tasks = scope === 'page' ? ['seo', 'tldr', 'faq'] : ['seo', 'tldr', 'faq', 'entities', 'social']
      const res = await fetch('/api/admin/generate-growth-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ scope, tasks, title, category, body, url, pagePath, brandSuffix }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok !== true) throw new Error(data?.error || `生成失败（HTTP ${res.status}）`)

      const fields: Partial<GrowthContentFields> = data.fields || {}
      const next: GrowthDraft = { ...value }
      if (fields.seo_title !== undefined) next.seo_title = fields.seo_title
      if (fields.seo_description !== undefined) next.seo_description = fields.seo_description
      if (fields.ai_tldr_summary !== undefined) next.ai_tldr_summary = fields.ai_tldr_summary
      if (fields.geo_faq_list !== undefined) next.geo_faq_list = fields.geo_faq_list
      if (fields.target_entities !== undefined) next.target_entities = fields.target_entities
      if (fields.social_copies !== undefined) next.social_copies = fields.social_copies
      onChange(next)
      setWarnings(Array.isArray(data.warnings) ? data.warnings : [])
    } catch (e: any) {
      setError(String(e?.message || e).slice(0, 200))
    } finally {
      setBusy(false)
    }
  }

  const setFaq = (index: number, next: Partial<GrowthFaqItem>) => {
    const list = value.geo_faq_list.slice()
    list[index] = { ...list[index], ...next }
    patch({ geo_faq_list: list })
  }

  const addFaq = () => {
    if (value.geo_faq_list.length >= GROWTH_LIMITS.faq.max) return
    patch({ geo_faq_list: [...value.geo_faq_list, { question: '', answer: '' }] })
  }

  const removeFaq = (index: number) => {
    patch({ geo_faq_list: value.geo_faq_list.filter((_, i) => i !== index) })
  }

  const setCopy = (key: SocialCopyKey, text: string) => {
    patch({ social_copies: { ...value.social_copies, [key]: text } })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-900">SEO / GEO 运营物料</div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            AI 只填草案，落库仍走本页原来的保存按钮。
          </div>
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={disabled || busy}
          className="inline-flex h-9 items-center gap-2 rounded-xl bg-slate-900 px-4 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}
          {busy ? '生成中…' : 'AI 生成草案'}
        </button>
      </div>

      {error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>
      ) : null}
      {warnings.length > 0 ? (
        <ul className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {warnings.map((w, i) => (
            <li key={i}>· {w}</li>
          ))}
        </ul>
      ) : null}
      {errors.length > 0 ? (
        <ul className="space-y-1 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {errors.map((issue, i) => (
            <li key={i}>· {issue.message}</li>
          ))}
        </ul>
      ) : null}

      <div>
        <Label
          text="SEO 标题"
          hint="含品牌后缀，SERP 原样显示；超过 60 字符会被截断。"
          right={<Counter value={value.seo_title} limits={GROWTH_LIMITS.seoTitle} />}
        />
        <input
          className={FIELD}
          value={value.seo_title}
          disabled={disabled}
          onChange={(e) => patch({ seo_title: e.target.value })}
          placeholder="Free Career Quiz: Instant Results, No Sign-Up | ComeBrief"
        />
      </div>

      <div>
        <Label
          text="Meta 描述"
          hint="一句给价值、一句给范围；不要「点击这里 / 了解更多」。"
          right={<Counter value={value.seo_description} limits={GROWTH_LIMITS.seoDescription} />}
        />
        <textarea
          className={`${FIELD} min-h-[76px] resize-y`}
          value={value.seo_description}
          disabled={disabled}
          onChange={(e) => patch({ seo_description: e.target.value })}
        />
      </div>

      {scope === 'page' ? (
        <div>
          <Label
            text="页面导语"
            hint="H1 下方 2–3 句；空 = 不渲染，历史页面输出不变。"
            right={<Counter value={value.intro_summary} limits={{ min: 40, max: GROWTH_LIMITS.introSummary.max }} />}
          />
          <textarea
            className={`${FIELD} min-h-[64px] resize-y`}
            value={value.intro_summary}
            disabled={disabled}
            onChange={(e) => patch({ intro_summary: e.target.value })}
          />
        </div>
      ) : null}

      <div>
        <Label
          text="TL;DR 摘要"
          hint={`第三方百科口吻，${GROWTH_LIMITS.tldr.minWords}–${GROWTH_LIMITS.tldr.maxWords} 词；AI 搜索最爱引用这一段。`}
          right={
            <span
              className={`text-[11px] tabular-nums ${
                tldrWords === 0
                  ? 'text-slate-400'
                  : tldrWords > GROWTH_LIMITS.tldr.maxWords
                    ? 'text-rose-600'
                    : tldrWords < GROWTH_LIMITS.tldr.minWords
                      ? 'text-amber-600'
                      : 'text-emerald-600'
              }`}
            >
              {tldrWords} 词
            </span>
          }
        />
        <textarea
          className={`${FIELD} min-h-[96px] resize-y`}
          value={value.ai_tldr_summary}
          disabled={disabled}
          onChange={(e) => patch({ ai_tldr_summary: e.target.value })}
        />
      </div>

      <div className="space-y-3">
        <Label
          text={`GEO 问答（${value.geo_faq_list.length}/${GROWTH_LIMITS.faq.max}）`}
          hint="问题按真实搜索语序写；答案先一句话直接回答，再补一句。会同时输出 FAQPage 结构化数据。"
          right={
            <button
              type="button"
              onClick={addFaq}
              disabled={disabled || value.geo_faq_list.length >= GROWTH_LIMITS.faq.max}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
            >
              <Plus className="h-3 w-3" /> 加一组
            </button>
          }
        />
        {value.geo_faq_list.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">
            还没有问答。点「加一组」，或让 AI 生成草案。
          </div>
        ) : (
          <div className="space-y-3">
            {value.geo_faq_list.map((item, index) => (
              <div key={index} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-slate-400">Q{index + 1}</span>
                  <input
                    className={`${FIELD} h-9 py-1`}
                    value={item.question}
                    disabled={disabled}
                    onChange={(e) => setFaq(index, { question: e.target.value })}
                    placeholder="How long does the quiz take?"
                  />
                  <button
                    type="button"
                    onClick={() => removeFaq(index)}
                    disabled={disabled}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:text-slate-300"
                    aria-label={`删除第 ${index + 1} 组问答`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <textarea
                  className={`${FIELD} min-h-[64px] resize-y`}
                  value={item.answer}
                  disabled={disabled}
                  onChange={(e) => setFaq(index, { answer: e.target.value })}
                  placeholder="About one minute: eight questions, one answer each."
                />
                <div className="mt-1 flex justify-end">
                  <Counter value={item.answer} limits={{ min: 40, max: GROWTH_LIMITS.faq.answerMax }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {scope === 'page' ? (
        <div>
          <Label text="OG 图地址" hint="分享卡片用；留空则沿用站点默认图。" />
          <input
            className={FIELD}
            value={value.og_image_url}
            disabled={disabled}
            onChange={(e) => patch({ og_image_url: e.target.value })}
            placeholder="https://comebrief.com/og/quiz-career.png"
          />
        </div>
      ) : (
        <div>
          <Label
            text="目标实体"
            hint={`逗号分隔，${GROWTH_LIMITS.targetEntities.min}–${GROWTH_LIMITS.targetEntities.max} 个。仅运营参考，不渲染。`}
          />
          <input
            className={FIELD}
            value={entityText}
            disabled={disabled}
            onChange={(e) => setEntityText(e.target.value)}
            onBlur={() => patch({ target_entities: normalizeTargetEntities(entityText) })}
            placeholder="Career, MBTI, Job Satisfaction"
          />
        </div>
      )}

      {scope === 'content' ? (
        <div className="rounded-xl border border-slate-200">
          <button
            type="button"
            onClick={() => setOpenSocial((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2.5 text-left"
          >
            <span>
              <span className="text-xs font-semibold text-slate-700">社媒文案</span>
              <span className="ml-2 text-[11px] text-slate-400">
                {SOCIAL_COPY_KEYS.filter((key) => (value.social_copies[key] || '').trim()).length}/
                {SOCIAL_COPY_KEYS.length} 已填
              </span>
            </span>
            <span className="text-[11px] text-slate-400">{openSocial ? '收起' : '展开'}</span>
          </button>
          {openSocial ? (
            <div className="space-y-4 border-t border-slate-100 p-3">
              {SOCIAL_PLATFORMS.map((platform) => (
                <div key={platform.key}>
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    {platform.label}
                  </div>
                  <div className="space-y-2.5">
                    {platform.fields.map((field) => {
                      const text = value.social_copies[field.key] || ''
                      return (
                        <div key={field.key}>
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <span className="text-[11px] text-slate-500" title={field.hint}>
                              {field.label}
                            </span>
                            <Counter
                              value={text.replace(/\{url\}/g, 'x'.repeat(40))}
                              limits={{ min: 0, max: field.limit }}
                            />
                          </div>
                          {field.multiline ? (
                            <textarea
                              className={`${FIELD} min-h-[60px] resize-y`}
                              value={text}
                              disabled={disabled}
                              onChange={(e) => setCopy(field.key, e.target.value)}
                              placeholder={field.hint}
                            />
                          ) : (
                            <input
                              className={FIELD}
                              value={text}
                              disabled={disabled}
                              onChange={(e) => setCopy(field.key, e.target.value)}
                              placeholder={field.hint}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
              <p className="text-[11px] leading-relaxed text-slate-400">
                正文里的 {'{url}'} 会在复制时替换成带 UTM 的本页链接，不要手写裸链接。
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <label className="flex items-start gap-3 rounded-xl border border-slate-200 px-3 py-2.5">
        <input
          type="checkbox"
          checked={value.is_noindex}
          disabled={disabled}
          onChange={(e) => patch({ is_noindex: e.target.checked })}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-rose-600"
        />
        <span>
          <span className="text-xs font-semibold text-slate-700">不进索引（noindex, follow）</span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-400">
            仍可被抓取，只是不进搜索结果，并从 sitemap 剔除。用于「有流量但不该出现在 SERP」的页面。
          </span>
        </span>
      </label>
    </div>
  )
}

