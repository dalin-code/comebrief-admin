'use client'

/**
 * AI 起草向导（4 步）：趋势 → 选题 → 生成 → 应用。
 *
 * 为什么要向导而不是一个「一键生成」按钮：
 *   一卷测验有四个地方会出错 —— 选题不新、四档结果里有一档是「其他」、
 *   题目全是同一件事的换皮、文案像文案不像人。这四件事分别发生在四个阶段，
 *   把一个按钮盖在它们上面，出错时只能整卷重来；分成四步，每一步都有
 *   可检查的产出（条数 / 5 条规则 / 12 项检查），坏在哪儿就重跑哪儿。
 *
 * 关键设计：
 *   · **步骤可以来回走**：第 3 步「重写题目」不会把已经满意的文案冲掉；
 *   · **「全自动」跑到第 4 步就停**：草稿由人按保存，AI 不直接写库
 *     （和 QuizBatchImport 一样：导入一律落草稿，发布仍是人的动作）；
 *   · **校验与后台同一份**：`validateQuizKit` 的 5 条规则 + `enumerateAxe()` 的
 *     65,536 次全枚举，和 CI 的 check:quiz 同源 —— 这里绿灯，进编辑器就是绿灯。
 */

import React, { useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Info,
  Loader2,
  Pin,
  RefreshCw,
  Sparkles,
  Star,
  Wand2,
  X,
} from 'lucide-react'
import { getFreshAccessToken } from '@/lib/clientAuth'
import { compileQuizKit, summarizeCompiled, type CompiledSummary } from '@/lib/quizCompile'
import type { AxeQuiz } from '@/lib/quizAxes'
import {
  KIT_QUESTIONS,
  type KitArchetype,
  type KitMeta,
  type KitRule,
  type KitValidation,
  type QuizKit,
} from '@/lib/quizKit'
import {
  TREND_GEOS,
  TREND_WINDOWS,
  TREND_SOURCES,
  type TrendFetchResult,
  type TrendGeo,
  type TrendItem,
  type TrendSourceId,
  type TrendWindow,
} from '@/lib/quizTrends'
import type { HotWord } from '@/lib/quizLexicon'
import type { QuizIdea } from '@/lib/quizAi'

export type QuizAiApplyPayload = {
  title: string
  categories: string[]
  tags: string[]
  quiz: AxeQuiz
  meta: KitMeta
  hook?: string
}

type Props = {
  open: boolean
  onClose: () => void
  onApply: (payload: QuizAiApplyPayload) => void
  /** 最近已发布的标题：喂给选题那一步，避免又写一遍上个月写过的角度 */
  existingTitles?: string[]
}

type Busy = '' | 'trends' | 'ideas' | 'copy' | 'questions' | 'auto'

const STEP_LABELS = ['Trends', 'Idea', 'Generate', 'Apply']

const cn = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ')

/** 一句人话的错误：后端返回 `{error}` 就用它，否则给出状态码。 */
async function postJson<T>(path: string, body: unknown, retryAuth = true): Promise<T> {
  const token = await getFreshAccessToken()
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const data = (await response.json().catch(() => ({}))) as any
  if (response.status === 401 && retryAuth) {
    const fresh = await getFreshAccessToken(true)
    if (fresh && fresh !== token) return postJson<T>(path, body, false)
  }
  if (!response.ok || data?.error) {
    throw new Error(String(data?.error || `HTTP ${response.status}`))
  }
  return data as T
}

const sourceLabel = (id: TrendSourceId) => TREND_SOURCES.find((s) => s.id === id)?.label || id

export default function QuizAiWizard({ open, onClose, onApply, existingTitles = [] }: Props) {
  const [step, setStep] = useState(0)
  const [geo, setGeo] = useState<TrendGeo>('US')
  const [window, setWindow] = useState<TrendWindow>('24h')
  const [sources, setSources] = useState<TrendSourceId[]>(
    TREND_SOURCES.filter((source) => source.defaultOn && source.id !== 'manual').map((source) => source.id)
  )
  const [manual, setManual] = useState('')
  const [pinned, setPinned] = useState<string[]>([])

  const [trendData, setTrendData] = useState<TrendFetchResult | null>(null)
  const [terms, setTerms] = useState<HotWord[]>([])
  const [excluded, setExcluded] = useState<string[]>([])

  const [ideas, setIdeas] = useState<QuizIdea[]>([])
  const [idea, setIdea] = useState<QuizIdea | null>(null)

  const [archetypes, setArchetypes] = useState<KitArchetype[]>([])
  const [copyProblems, setCopyProblems] = useState<string[]>([])
  const [kit, setKit] = useState<QuizKit | null>(null)
  const [validation, setValidation] = useState<KitValidation | null>(null)
  const [summary, setSummary] = useState<CompiledSummary | null>(null)

  const [busy, setBusy] = useState<Busy>('')
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  /** 不阻断流程的提示（例如模型输出被截断、只拿到 2 条选题） */
  const [notice, setNotice] = useState('')

  /** 一条标题链路的“最新值”：runAll 里 setState 还没生效就要用，所以留一份 ref。 */
  const itemsRef = useRef<TrendItem[]>([])

  /** 传给 AI 的趋势条目：默认全用，点掉的不要 —— 站长最懂「这个不能碰」。 */
  const included = useMemo(
    () => (trendData?.items ?? []).filter((item) => !excluded.includes(item.id)),
    [trendData, excluded]
  )

  const canApply = Boolean(kit && validation?.ok && archetypes.length === 4)

  /* ---------------------------------------------------------------- *
   * 请求
   * ---------------------------------------------------------------- */

  const loadTrends = async (): Promise<{ items: TrendItem[]; terms: HotWord[] } | null> => {
    setBusy('trends')
    setError('')
    setNotice('')
    try {
      const data = await postJson<any>('/api/admin/quiz/trends', {
        geo,
        window,
        sources,
        manual,
        pinned,
      })
      const items = (data.items ?? []) as TrendItem[]
      const nextTerms = (data.terms ?? []) as HotWord[]
      itemsRef.current = items
      setTrendData({
        items,
        sources: data.sources ?? [],
        geo: data.geo ?? geo,
        window: data.window ?? window,
        fetchedAt: data.fetchedAt ?? new Date().toISOString(),
        cached: Boolean(data.cached),
        filtered: Number(data.filtered) || 0,
      })
      setTerms(nextTerms)
      setExcluded([])
      // 把结果**返回**一份：runAll 里紧接着要用，
      // 而 setState 是异步的 —— 读 `included` 会读到上一轮的旧值（空数组）。
      return { items, terms: nextTerms }
    } catch (e: any) {
      setError(`采集失败：${e?.message || e}`)
      return null
    } finally {
      setBusy('')
    }
  }

  const makeIdeas = async () => {
    if (!included.length && !pinned.length) {
      setError('先抓一轮趋势，或粘贴两条')
      return
    }
    setBusy('ideas')
    setError('')
    setNotice('')
    try {
      const data = await postJson<any>('/api/admin/quiz/ideas', {
        trends: included,
        pinned,
        avoidTitles: existingTitles.slice(0, 12),
        count: 4,
      })
      const list = (data.ideas ?? []) as QuizIdea[]
      setIdeas(list)
      setIdea(null)
      setStep(1)
      setNotice(
        data.truncated
          ? `模型输出被截断，只拿到 ${list.length} 条选题；想要 4 条就再点一次「生成选题」。`
          : ''
      )
    } catch (e: any) {
      setError(`生成选题失败：${e?.message || e}`)
    } finally {
      setBusy('')
    }
  }

  const writeCopy = async (target: QuizIdea) => {
    setNotice('')
    const data = await postJson<any>('/api/admin/quiz/generate', {
      stage: 'copy',
      idea: target,
    })
    const next: KitArchetype[] = data.archetypes ?? []
    setArchetypes(next)
    setCopyProblems(data.problems ?? [])
    if (data.truncated) {
      setNotice('文案被截断：可能有原型缺 headline / summary，点「重写文案」再来一次。')
    }
    return next
  }

  const writeQuestions = async (target: QuizIdea, archs: KitArchetype[]) => {
    const data = await postJson<any>('/api/admin/quiz/generate', {
      stage: 'questions',
      idea: target,
      archetypes: archs,
      meta: {
        // 用 ref 而不是 `included`：runAll 里刚抓完趋势还没重渲染，闭包里的 included 是空的
        trendIds: itemsRef.current.slice(0, 20).map((item) => item.id),
        terms: pinned,
        keywords: [target.title],
        geo,
        window: String(window),
        fetchedAt: trendData?.fetchedAt,
      },
    })
    setKit(data.kit ?? null)
    setValidation(data.validation ?? null)
    setSummary(data.summary ?? null)
    if (data.truncated) {
      setNotice('题目被截断：缺的题会在规则里报「题目数量」—— 点「重写题目」再来一次。')
    }
    return data as { kit: QuizKit | null; validation: KitValidation | null; ok: boolean }
  }

  /**
   * 文案 → 题目，失败重来一次。
   *
   * 为什么是「重新写一遍文案」而不是「只重写题目」：模型把两个选项指向同一个
   * 原型，通常是因为它自己也分不清这两个结果的区别 —— 换一版更不重叠的文案
   * 比在旧文案上硬凑题目更容易过。重跑上限就一次，之后交给人工在矩阵里改。
   */
  const buildFromIdea = async (target: QuizIdea) => {
    setBusy('auto')
    setError('')
    setNotice('')
    setProgress('写四个结果的文案…')
    try {
      let archs = await writeCopy(target)
      if (archs.length !== 4) throw new Error(`原型数量是 ${archs.length}，不是 4`)

      setProgress(`写 ${KIT_QUESTIONS} 道题…`)
      let result = await writeQuestions(target, archs)
      if (!result.ok) {
        setProgress('题目没配平，换一版文案再来…')
        archs = await writeCopy(target)
        result = await writeQuestions(target, archs)
      }
      setStep(2)
      if (!result.ok) setError('题目还是没过校验：可以点「重写题目」，或先应用再在矩阵里改')
    } catch (e: any) {
      setError(`生成失败：${e?.message || e}`)
    } finally {
      setBusy('')
      setProgress('')
    }
  }

  /** 全自动：趋势 → 选题 → 文案 → 题目 → 停在第 4 步（保存仍由人按）。 */
  const runAll = async () => {
    setBusy('auto')
    setError('')
    setNotice('')
    try {
      // 已经在第一步抓过就复用；没抓过就现场抓一次
      let trends = included
      if (!trends.length && !manual.trim()) {
        setProgress('抓趋势…')
        const fetched = await loadTrends()
        trends = fetched?.items ?? []
        setBusy('auto')
      }
      if (!trends.length) throw new Error('没有可用的趋势条目：先抓一轮或在第一步粘贴两条')

      setProgress('生成选题…')
      const ideaData = await postJson<any>('/api/admin/quiz/ideas', {
        trends,
        pinned,
        avoidTitles: existingTitles.slice(0, 12),
        count: 4,
      })
      const list = (ideaData.ideas ?? []) as QuizIdea[]
      if (!list.length) throw new Error('模型没给出可用的选题')
      setIdeas(list)
      if (ideaData.truncated) setNotice(`选题被截断，只拿到 ${list.length} 条，先按第一条写。`)
      const target = list[0]
      setIdea(target)
      setBusy('')
      await buildFromIdea(target)
    } catch (e: any) {
      setError(`全自动失败：${e?.message || e}`)
      setBusy('')
    } finally {
      setProgress('')
    }
  }

  /** 只重写文案 / 只重写题目：各自带 loading 与错误捕获，避免点了没反应。 */
  const rewriteCopy = async () => {
    if (!idea) return
    setBusy('copy')
    setError('')
    try {
      const next = await writeCopy(idea)
      if (next.length !== 4) setError(`原型数量是 ${next.length}，不是 4：再点一次`)
    } catch (e: any) {
      setError(`重写文案失败：${e?.message || e}`)
    } finally {
      setBusy('')
    }
  }

  const rewriteQuestions = async () => {
    if (!idea) return
    if (archetypes.length !== 4) {
      setError('先有 4 个原型才能写题')
      return
    }
    setBusy('questions')
    setError('')
    setNotice('')
    try {
      const result = await writeQuestions(idea, archetypes)
      if (!result.ok) setError('题目没过校验：看下面的 blocker，再点一次或换文案')
    } catch (e: any) {
      setError(`重写题目失败：${e?.message || e}`)
    } finally {
      setBusy('')
    }
  }

  const apply = () => {
    if (!kit || !validation?.ok) return
    const compiled = compileQuizKit(kit)
    onApply({
      title: kit.title,
      categories: compiled.categories,
      tags: kit.tags,
      quiz: compiled.quiz,
      hook: kit.hook,
      meta: {
        ...kit.meta,
        pinned,
        geo,
        window: String(window),
        fetchedAt: trendData?.fetchedAt,
      },
    })
    onClose()
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
      <div className="flex h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-[32px] bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-100 px-8 py-5">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-slate-900 text-white">
              <Wand2 size={16} />
            </span>
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">AI authoring</p>
              <h2 className="text-sm font-black italic text-slate-900">Trends → Idea → Generate → Apply</h2>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {STEP_LABELS.map((label, index) => (
              <span
                key={label}
                className={cn(
                  'rounded-full px-3 py-1 text-[9px] font-black uppercase tracking-widest',
                  index === step
                    ? 'bg-slate-900 text-white'
                    : index < step
                      ? 'bg-emerald-50 text-emerald-600'
                      : 'bg-slate-50 text-slate-300'
                )}
              >
                {index + 1}. {label}
              </span>
            ))}
            <button
              type="button"
              onClick={onClose}
              className="ml-2 rounded-full p-2 text-slate-300 transition-all hover:bg-slate-50 hover:text-slate-900"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {error ? (
          <div className="flex items-start gap-2 border-b border-amber-100 bg-amber-50 px-8 py-3 text-[11px] font-bold text-amber-700">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button type="button" onClick={() => setError('')} className="text-amber-500">
              <X size={12} />
            </button>
          </div>
        ) : null}

        {notice ? (
          <div className="flex items-start gap-2 border-b border-sky-100 bg-sky-50 px-8 py-2.5 text-[11px] font-semibold text-sky-700">
            <Info size={13} className="mt-0.5 shrink-0" />
            <span className="flex-1">{notice}</span>
            <button type="button" onClick={() => setNotice('')} className="text-sky-500">
              <X size={12} />
            </button>
          </div>
        ) : null}

        <main className="flex-1 overflow-y-auto px-8 py-6">
          {step === 0 ? (
            <StepTrends
              geo={geo}
              window={window}
              sources={sources}
              manual={manual}
              pinned={pinned}
              busy={busy === 'trends'}
              trendData={trendData}
              terms={terms}
              excluded={excluded}
              onGeo={setGeo}
              onWindow={setWindow}
              onSources={setSources}
              onManual={setManual}
              onPinned={setPinned}
              onExcluded={setExcluded}
              onFetch={loadTrends}
            />
          ) : null}

          {step === 1 ? (
            <StepIdeas
              ideas={ideas}
              chosen={idea}
              busy={busy === 'ideas' || busy === 'auto'}
              onChoose={(next) => {
                setIdea(next)
                setStep(2)
              }}
              onBack={() => setStep(0)}
              onRegenerate={makeIdeas}
            />
          ) : null}

          {step === 2 ? (
            <StepGenerate
              idea={idea}
              archetypes={archetypes}
              copyProblems={copyProblems}
              validation={validation}
              summary={summary}
              busy={busy}
              progress={progress}
              onWriteCopy={rewriteCopy}
              onWriteQuestions={rewriteQuestions}
              onBuild={() => idea && buildFromIdea(idea)}
            />
          ) : null}

          {step === 3 ? (
            <StepApply
              kit={kit}
              validation={validation}
              summary={summary}
              idea={idea}
              archetypes={archetypes}
              canApply={canApply}
            />
          ) : null}
        </main>

        <footer className="flex items-center justify-between gap-3 border-t border-slate-100 px-8 py-4">
          <div className="text-[10px] font-bold text-slate-400">
            {progress || (trendData ? `${included.length} 条趋势 · ${terms.length} 个热词` : '先抓一轮趋势')}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={runAll}
              disabled={Boolean(busy)}
              className="flex items-center gap-2 rounded-2xl border-2 border-dashed border-slate-200 px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-400 transition-all hover:border-slate-900 hover:text-slate-900 disabled:opacity-40"
            >
              {busy === 'auto' ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              全自动
            </button>
            {step === 0 ? (
              <button
                type="button"
                onClick={makeIdeas}
                disabled={Boolean(busy) || (!included.length && !pinned.length)}
                className="flex items-center gap-2 rounded-2xl bg-slate-900 px-6 py-2.5 text-[10px] font-black uppercase tracking-widest text-white transition-all hover:bg-slate-800 disabled:opacity-30"
              >
                {busy === 'ideas' ? <Loader2 size={13} className="animate-spin" /> : <ArrowRight size={13} />}
                生成选题
              </button>
            ) : null}
            {step === 2 ? (
              <button
                type="button"
                onClick={() => setStep(3)}
                disabled={!kit}
                className="flex items-center gap-2 rounded-2xl bg-slate-900 px-6 py-2.5 text-[10px] font-black uppercase tracking-widest text-white transition-all hover:bg-slate-800 disabled:opacity-30"
              >
                <ArrowRight size={13} /> 审阅
              </button>
            ) : null}
            {step === 3 ? (
              <button
                type="button"
                onClick={apply}
                disabled={!canApply}
                className="flex items-center gap-2 rounded-2xl bg-emerald-600 px-6 py-2.5 text-[10px] font-black uppercase tracking-widest text-white transition-all hover:bg-emerald-700 disabled:opacity-30"
              >
                <Check size={13} /> 应用到编辑器
              </button>
            ) : null}
          </div>
        </footer>
      </div>
    </div>
  )
}

/* ================================================================== *
 * 第 1 步：趋势
 * ================================================================== */

type TrendsProps = {
  geo: TrendGeo
  window: TrendWindow
  sources: TrendSourceId[]
  manual: string
  pinned: string[]
  busy: boolean
  trendData: TrendFetchResult | null
  terms: HotWord[]
  excluded: string[]
  onGeo: (next: TrendGeo) => void
  onWindow: (next: TrendWindow) => void
  onSources: (next: TrendSourceId[]) => void
  onManual: (next: string) => void
  onPinned: (next: string[]) => void
  onExcluded: (next: string[]) => void
  onFetch: () => void
}

function StepTrends(props: TrendsProps) {
  const toggleSource = (id: TrendSourceId) =>
    props.onSources(
      props.sources.includes(id) ? props.sources.filter((s) => s !== id) : [...props.sources, id]
    )

  const togglePin = (term: string) =>
    props.onPinned(
      props.pinned.includes(term)
        ? props.pinned.filter((t) => t !== term)
        : [...props.pinned, term].slice(0, 8)
    )

  const toggleExclude = (id: string) =>
    props.onExcluded(
      props.excluded.includes(id) ? props.excluded.filter((x) => x !== id) : [...props.excluded, id]
    )

  const statusOf = (id: TrendSourceId) => props.trendData?.sources.find((s) => s.id === id)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto]">
        <label className="block space-y-1">
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">Region</span>
          <select
            value={props.geo}
            onChange={(e) => props.onGeo(e.target.value as TrendGeo)}
            className="w-full rounded-2xl bg-slate-50 px-4 py-2.5 text-[12px] font-bold text-slate-700 outline-none focus:bg-white"
          >
            {TREND_GEOS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">Window</span>
          <select
            value={props.window}
            onChange={(e) => props.onWindow(e.target.value as TrendWindow)}
            className="w-full rounded-2xl bg-slate-50 px-4 py-2.5 text-[12px] font-bold text-slate-700 outline-none focus:bg-white"
          >
            {TREND_WINDOWS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <button
            type="button"
            onClick={props.onFetch}
            disabled={props.busy}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-900 px-6 py-2.5 text-[10px] font-black uppercase tracking-widest text-white transition-all hover:bg-slate-800 disabled:opacity-40"
          >
            {props.busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            抓趋势
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {TREND_SOURCES.filter((source) => source.id !== 'manual').map((source) => {
          const on = props.sources.includes(source.id)
          const status = statusOf(source.id)
          return (
            <button
              key={source.id}
              type="button"
              onClick={() => toggleSource(source.id)}
              title={source.note}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[10px] font-bold transition-all',
                on
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 text-slate-400 hover:border-slate-400'
              )}
            >
              {source.label}
              {status ? (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-[9px] font-black',
                    status.ok
                      ? on
                        ? 'bg-emerald-400/20 text-emerald-200'
                        : 'bg-emerald-50 text-emerald-600'
                      : 'bg-rose-50 text-rose-500'
                  )}
                >
                  {status.ok ? status.count : '×'}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <label className="block space-y-1">
        <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">
          Manual paste · 一行一条，想测什么就写什么
        </span>
        <textarea
          value={props.manual}
          onChange={(e) => props.onManual(e.target.value)}
          rows={2}
          placeholder={'Taylor Swift engagement rumors\nbrat summer is back\nSquid Game season 3'}
          className="w-full resize-none rounded-2xl bg-slate-50 px-4 py-3 text-[12px] font-medium leading-relaxed text-slate-700 outline-none focus:bg-white"
        />
      </label>

      {props.trendData ? (
        <>
          <section className="space-y-2">
            <div className="flex items-baseline justify-between">
              <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                Hot words · 点星钉住（钉住的词一定会进提示词）
              </p>
              <p className="text-[9px] font-bold text-slate-300">
                {props.terms.length} 个 · 过滤掉 {props.trendData.filtered} 条
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {props.terms.slice(0, 36).map((word) => {
                const on = props.pinned.includes(word.term)
                return (
                  <button
                    key={`${word.kind}:${word.term}`}
                    type="button"
                    onClick={() => togglePin(word.term)}
                    title={`${word.kind} · ${word.sources.join(' / ') || 'manual'}`}
                    className={cn(
                      'flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-bold transition-all',
                      on
                        ? 'border-amber-400 bg-amber-50 text-amber-700'
                        : 'border-slate-200 text-slate-500 hover:border-slate-400'
                    )}
                  >
                    {on ? <Star size={9} className="fill-amber-400 text-amber-400" /> : <Pin size={9} />}
                    {word.term}
                    <span className="text-[8px] font-black uppercase text-slate-300">{word.kind[0]}</span>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="space-y-1">
            <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">
              Sources · 点掉不想用的条目（{props.trendData.items.length - props.excluded.length}/
              {props.trendData.items.length} 在用）
            </p>
            <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
              {props.trendData.items.map((item) => {
                const off = props.excluded.includes(item.id)
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => toggleExclude(item.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left text-[11px] transition-all',
                        off ? 'text-slate-300 line-through' : 'text-slate-600 hover:bg-slate-50'
                      )}
                    >
                      <span className="w-24 shrink-0 truncate text-[9px] font-black uppercase tracking-widest text-slate-300">
                        {sourceLabel(item.source)}
                      </span>
                      <span className="flex-1 truncate font-bold">{item.title}</span>
                      {item.score ? (
                        <span className="shrink-0 text-[9px] font-black tabular-nums text-slate-300">
                          {item.score.toLocaleString('en-US')}
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        </>
      ) : (
        <p className="rounded-2xl bg-slate-50 p-4 text-[10px] font-bold leading-relaxed text-slate-400">
          8 个公开源（Google Trends / Google News / Wikipedia / Reddit / Know Your Meme /
          Apple Music / PopCrave / BuzzFeed）+ 人工粘贴。单个源挂了不影响其他源；
          Google News 的 RSS 授权是「个人 / 非商业」，商用前请把它关掉。
        </p>
      )}
    </div>
  )
}

/* ================================================================== *
 * 第 2 步：选题
 * ================================================================== */

function StepIdeas(props: {
  ideas: QuizIdea[]
  chosen: QuizIdea | null
  busy: boolean
  onChoose: (idea: QuizIdea) => void
  onBack: () => void
  onRegenerate: () => void
}) {
  if (props.busy && !props.ideas.length) {
    return (
      <p className="flex items-center gap-2 text-[11px] font-bold text-slate-400">
        <Loader2 size={14} className="animate-spin" /> 正在读今天的热点…
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">
          选一个方向（点一下直接进入生成）
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={props.onBack}
            className="rounded-full px-3 py-1 text-[9px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-900"
          >
            返回趋势
          </button>
          <button
            type="button"
            onClick={props.onRegenerate}
            disabled={props.busy}
            className="flex items-center gap-1 rounded-full px-3 py-1 text-[9px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-900 disabled:opacity-40"
          >
            <RefreshCw size={10} /> 换一批
          </button>
        </div>
      </div>

      {props.ideas.length ? (
        <ul className="space-y-2">
          {props.ideas.map((idea, index) => {
            const active = props.chosen?.title === idea.title
            return (
              <li key={`${idea.title}-${index}`}>
                <button
                  type="button"
                  onClick={() => props.onChoose(idea)}
                  className={cn(
                    'w-full rounded-3xl border p-4 text-left transition-all',
                    active
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 hover:border-slate-900'
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-black italic leading-snug">{idea.title}</p>
                      {idea.hook ? (
                        <p className={cn('mt-1 text-[11px] font-bold', active ? 'text-white/70' : 'text-slate-500')}>
                          {idea.hook}
                        </p>
                      ) : null}
                      {idea.angle ? (
                        <p
                          className={cn(
                            'mt-2 text-[10px] font-medium leading-relaxed',
                            active ? 'text-white/50' : 'text-slate-400'
                          )}
                        >
                          {idea.angle}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-1">
                        {[idea.topicLabel, ...idea.tags].filter(Boolean).map((label) => (
                          <span
                            key={label}
                            className={cn(
                              'rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-widest',
                              active ? 'bg-white/10 text-white/70' : 'bg-slate-50 text-slate-400'
                            )}
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                      {idea.archetypes.length ? (
                        <p className={cn('mt-2 text-[10px] font-bold', active ? 'text-white/60' : 'text-slate-400')}>
                          四档：{idea.archetypes.join(' · ')}
                        </p>
                      ) : null}
                    </div>
                    <ArrowRight size={14} className={active ? 'text-white' : 'text-slate-300'} />
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="rounded-2xl bg-slate-50 p-4 text-[10px] font-bold text-slate-400">
          还没有选题：回到上一步抓趋势，或点「换一批」。
        </p>
      )}
    </div>
  )
}

/* ================================================================== *
 * 第 3 步：生成（文案 + 题目）
 * ================================================================== */

function RuleList({ rules }: { rules: KitRule[] }) {
  return (
    <ul className="space-y-1.5">
      {rules.map((rule) => (
        <li key={rule.id} className="rounded-2xl border border-slate-100 px-3 py-2">
          <div className="flex items-start gap-2">
            <span
              className={cn(
                'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
                rule.ok
                  ? 'bg-emerald-50 text-emerald-600'
                  : rule.level === 'blocker'
                    ? 'bg-rose-50 text-rose-600'
                    : 'bg-amber-50 text-amber-500'
              )}
            >
              {rule.ok ? (
                <Check size={9} strokeWidth={4} />
              ) : rule.level === 'blocker' ? (
                <X size={9} strokeWidth={4} />
              ) : (
                <AlertTriangle size={9} strokeWidth={3} />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'text-[10px] font-black leading-snug',
                  rule.ok ? 'text-slate-400' : 'text-slate-700'
                )}
              >
                {rule.label}
              </p>
              {!rule.ok && rule.detail ? (
                <p className="mt-0.5 text-[9px] font-medium leading-relaxed text-slate-400">{rule.detail}</p>
              ) : null}
            </div>
            {!rule.ok ? (
              <span className="shrink-0 text-[8px] font-black uppercase tracking-widest text-slate-300">
                {rule.level}
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}

function SummaryPanel({
  summary,
  archetypes,
}: {
  summary: CompiledSummary | null
  archetypes: KitArchetype[]
}) {
  if (!summary) return null
  const rows = archetypes.map((a) => ({ name: a.name || a.id, pct: summary.hitPct[a.id] ?? 0 }))
  const max = Math.max(...rows.map((row) => row.pct), 1)

  return (
    <div className="space-y-3 rounded-3xl bg-slate-50 p-4">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Pre-flight</p>
          <p className="mt-0.5 text-[9px] font-bold text-slate-400">
            {summary.total.toLocaleString('en-US')} 种答案组合 · 平局 {summary.tiePct.toFixed(1)}%
          </p>
        </div>
        <p
          className={cn(
            'text-3xl font-black leading-none tabular-nums',
            summary.health >= 90
              ? 'text-emerald-500'
              : summary.health >= 70
                ? 'text-amber-500'
                : 'text-rose-500'
          )}
        >
          {summary.health}
        </p>
      </div>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.name} className="flex items-center gap-2">
            <span className="w-40 shrink-0 truncate text-[10px] font-bold text-slate-600">{row.name}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white">
              <span
                className="block h-full rounded-full bg-slate-900"
                style={{ width: `${Math.max(2, (row.pct / max) * 100)}%` }}
              />
            </span>
            <span className="w-10 shrink-0 text-right text-[9px] font-black tabular-nums text-slate-400">
              {row.pct.toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
      {summary.blockers.length ? (
        <p className="text-[9px] font-bold text-rose-500">blocker：{summary.blockers.join('；')}</p>
      ) : null}
      {summary.warnings.length ? (
        <p className="text-[9px] font-bold text-amber-600">warning：{summary.warnings.join('；')}</p>
      ) : null}
    </div>
  )
}

function StepGenerate(props: {
  idea: QuizIdea | null
  archetypes: KitArchetype[]
  copyProblems: string[]
  validation: KitValidation | null
  summary: CompiledSummary | null
  busy: Busy
  progress: string
  onBuild: () => void
  onWriteCopy: () => void
  onWriteQuestions: () => void
}) {
  const working = Boolean(props.busy)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">正在写</p>
          <p className="text-[13px] font-black italic text-slate-900">{props.idea?.title || '（还没选选题）'}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={props.onWriteCopy}
            disabled={working || !props.idea}
            className="rounded-2xl border border-slate-200 px-4 py-2 text-[9px] font-black uppercase tracking-widest text-slate-500 hover:border-slate-900 hover:text-slate-900 disabled:opacity-40"
          >
            只重写文案
          </button>
          <button
            type="button"
            onClick={props.onWriteQuestions}
            disabled={working || props.archetypes.length !== 4}
            className="rounded-2xl border border-slate-200 px-4 py-2 text-[9px] font-black uppercase tracking-widest text-slate-500 hover:border-slate-900 hover:text-slate-900 disabled:opacity-40"
          >
            只重写题目
          </button>
          <button
            type="button"
            onClick={props.onBuild}
            disabled={working || !props.idea}
            className="flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-2 text-[9px] font-black uppercase tracking-widest text-white hover:bg-slate-800 disabled:opacity-40"
          >
            {working ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {props.archetypes.length ? '重新生成' : '生成文案 + 题目'}
          </button>
        </div>
      </div>

      {props.progress ? <p className="text-[10px] font-bold text-slate-400">{props.progress}</p> : null}

      {props.copyProblems.length ? (
        <ul className="space-y-1 rounded-2xl bg-amber-50 p-3 text-[10px] font-bold text-amber-700">
          {props.copyProblems.map((problem) => (
            <li key={problem}>· {problem}</li>
          ))}
        </ul>
      ) : null}

      {props.archetypes.length ? (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {props.archetypes.map((a) => (
            <div key={a.id} className="rounded-3xl border border-slate-200 p-4">
              <p className="text-[12px] font-black italic text-slate-900">{a.name}</p>
              {a.headline ? <p className="mt-1 text-[10px] font-bold text-slate-500">{a.headline}</p> : null}
              {a.summary ? (
                <p className="mt-1 line-clamp-3 text-[9px] font-medium leading-relaxed text-slate-400">
                  {a.summary}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-1">
                {(a.stats ?? []).map((stat) => (
                  <span
                    key={stat}
                    className="rounded-full bg-slate-50 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest text-slate-400"
                  >
                    {stat}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {props.validation ? <RuleList rules={props.validation.rules} /> : null}
      <SummaryPanel summary={props.summary} archetypes={props.archetypes} />
    </div>
  )
}

/* ================================================================== *
 * 第 4 步：审阅 / 应用
 * ================================================================== */

function StepApply(props: {
  kit: QuizKit | null
  validation: KitValidation | null
  summary: CompiledSummary | null
  idea: QuizIdea | null
  archetypes: KitArchetype[]
  canApply: boolean
}) {
  if (!props.kit) {
    return (
      <p className="rounded-2xl bg-slate-50 p-4 text-[10px] font-bold text-slate-400">
        还没有生成结果：回到上一步点「生成文案 + 题目」。
      </p>
    )
  }

  const kit = props.kit

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-slate-200 p-5">
        <p className="text-[15px] font-black italic leading-snug text-slate-900">{kit.title}</p>
        {kit.hook ? <p className="mt-1 text-[11px] font-bold text-slate-500">{kit.hook}</p> : null}
        <div className="mt-2 flex flex-wrap gap-1">
          {[kit.topicLabel, ...kit.tags].filter(Boolean).map((label) => (
            <span
              key={label}
              className="rounded-full bg-slate-50 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-slate-400"
            >
              {label}
            </span>
          ))}
          <span className="rounded-full bg-slate-50 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-slate-400">
            {kit.questions.length} 题 · {kit.archetypes.length} 个结果
          </span>
        </div>
        <p className="mt-3 text-[10px] font-medium leading-relaxed text-slate-400">
          应用后：标题 / 分类 / 标签 / 四个原型 / 8 题 × 4 选项全部填进编辑器，评分模型自动切成
          Archetype Matrix，权重按「主原型 3 分 + 下一个原型 1 分」生成。不会自动保存，也不会上线
          —— 你仍然要在右上角按 Save Draft。
        </p>
      </div>

      {props.validation ? <RuleList rules={props.validation.rules} /> : null}
      <SummaryPanel summary={props.summary} archetypes={props.archetypes} />

      {!props.canApply ? (
        <p className="flex items-start gap-2 rounded-2xl bg-rose-50 p-3 text-[10px] font-bold text-rose-600">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          还有 blocker 没过：先在上一页重写题目（或应用后进编辑器手工改），这里才能应用。
        </p>
      ) : null}
    </div>
  )
}

