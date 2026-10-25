'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  X, Loader2, Sparkles, Dices, Save, Trash2, AlertTriangle, CheckCircle2, PenLine, RotateCcw,
  ClipboardCheck, Wand2, ChevronDown, ChevronUp, Layers, Plus,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { getFreshAccessToken } from '@/lib/clientAuth'
import {
  DIMENSIONS,
  LENGTH_PRESETS,
  countChineseChars,
  htmlToPlainText,
  toStoryHtml,
  type DimensionKey,
  type StoryCombo,
  type StorySkill,
  type StoryTag,
} from '@/lib/storyPrompt'
import {
  REVIEW_DIMENSIONS,
  SEVERITY_LABEL,
  pickDefaultIssueIds,
  scoreTone,
  type ReviewIssue,
  type StoryReview,
} from '@/lib/storyReview'
import {
  MATERIAL_FIRST_LENGTH,
  MAX_BATCH_STORIES,
  deriveBatchSeed,
  isMaterialFirst,
  makeSeed,
  normalizeMaterialList,
  normalizeSeed,
} from '@/lib/storySelection'
import type { StorySkeleton } from '@/lib/storyPlan'
import { surfaceIdentity, type StorySurface, type SurfaceIdentity } from '@/lib/storyIdentity'
import type { StorySection } from '@/lib/storyWrite'

type StorySeeds = {
  seed: string
  variantIndex: number
  skeletonSeed: string
  surfaceSeed: string
  proseSeed: string
}

type StoryPlanResponse = {
  seed: string
  variantIndex: number
  seeds: StorySeeds
  skeleton: StorySkeleton
  surface?: StorySurface
  fingerprint?: string
  recipeId?: string | null
  resolved?: {
    combo?: Partial<Record<DimensionKey, string[]>>
    skill?: { code: string; name?: string } | null
    seed?: string
    variantIndex?: number
  }
  resolvedTags?: Array<{ dimension: string; names: string[] }>
  warnings?: string[]
}

export type GeneratedStory = {
  title: string
  excerpt: string
  html: string
  chars: number
  warnings: string[]
  /** 这一版实际用的改编底本；批量里每篇不同，改稿 / 换版要沿用同一份 */
  materials?: string
  /** 服务端回执：这一版是哪套写法写的（留个痕，方便对比几版稿子） */
  skill?: { code: string; name: string } | null
  /** 这一版是不是写到模型的输出上限就断了 —— 「接着写下去」的自动补字就是看这个 */
  truncated?: boolean
  /** P4：分段稿。每一段可以单独重写，前后段逐字保留 */
  sections?: StorySection[]
  /** P4：这一版用的骨架 / 表皮 / Seed；「换一版」只换表皮，不动骨架 */
  skeleton?: StorySkeleton
  surface?: StorySurface
  seed?: string
  variantIndex?: number
  seeds?: StorySeeds
  fingerprint?: string
  recipeId?: string | null
  shareCode?: string
  resolved?: {
    combo?: Partial<Record<DimensionKey, string[]>>
    skill?: { code: string; name?: string } | null
    seed?: string
    variantIndex?: number
  }
}

type Preset = { id: string; name: string; combo: StoryCombo; updated_at?: string }

type BatchResult = {
  index: number
  title: string
  draftId?: string
  warnings: string[]
  error?: string
  /** 这一批一共要写几篇 —— 用来告诉站长中断后还剩几篇没生成 */
  total?: number
}

export type StoryComposerProps = {
  open: boolean
  onClose: () => void
  /** 生成完成 → 交给编辑页：切到中文页签、写进标题/摘要/正文 */
  onApply: (story: GeneratedStory) => void
  /** 「接着写下去」：取当前中文正文的纯文本 */
  getCurrentZhText: () => string
  /** 「接着写下去」拿到的新段落 → 追加到正文末尾 */
  onAppend: (html: string) => void
  /** 上一次用的组合，编辑页保存着，换页回来还在 */
  combo: StoryCombo
  onComboChange: (combo: StoryCombo) => void
  /** 正文里已经有中文内容了 —— 插入前要确认一次 */
  hasExistingContent: boolean
  /** 正在编辑的文章 id：写进 story_recipe_variants，作为逐字复现的来源 */
  sourceArticleId?: string | null
  showToast: (msg: string, type: 'success' | 'error') => void
}

const EMPTY_COMBO: StoryCombo = { length: 1500 }

/** 读回文章 / 预设里的素材列表；旧数据只有单篇 `materials` 时兼容成一项。 */
const materialListFromCombo = (combo: StoryCombo): string[] => {
  const list = normalizeMaterialList(combo.materialsList)
  if (list.some((item) => item.trim())) return list
  return [String(combo.materials ?? '').trim()]
}

/**
 * 服务端「这次没成」的状态码 —— 不是「你不该这么做」，所以值得自动重发一次。
 * 501/500/424 之类是代码或数据的问题，重发多少次结果都一样，别浪费站长时间。
 */
const TRANSIENT_STATUS = new Set([502, 503])
/** 重发前的等待：给对面一点喘息，也避免拿同一个坏连接再撞一次 */
const TRANSIENT_RETRY_WAIT_MS = 800

/**
 * 自动续写（「接着写下去」）的刹车值。
 *
 * 站长 2026-10 的原话：「当 AI 请求模型字数达到上限后，点击续写可以自动延续往下写，
 * 而不是卡在那里不动」。所以续写不再只发一次请求：
 *   写不到目标字数、或这一轮又被长度上限截断 → 自动再续一轮，直到写够或撞到上限。
 * 一轮大概 20–40 秒，三轮封顶 —— 再长就该让站长自己判断了，不能让他干等五分钟。
 */
const MAX_AUTO_CONTINUE_ROUNDS = 3
/** 一轮至少要新增这么多字才算「有进展」；低于这个数就停手（模型在复读，再续也是浪费） */
const CONTINUE_MIN_GAIN = 60
/** 写到目标字数的这个比例就算够了，不必再续 */
const CONTINUE_ENOUGH_RATIO = 0.92

/** 严重度 → 徽章配色（只有这一处用，就近放着） */
const severityTone = (s: ReviewIssue['severity']) =>
  s === 'high' ? 'bg-rose-100 text-rose-600' : s === 'mid' ? 'bg-amber-100 text-amber-700' : 'bg-slate-200 text-slate-500'

/**
 * ✨ AI 创作面板（编辑页右上角「AI 创作」按钮打开）。
 *
 * 只负责「生成中文短篇」这一件事：
 *   选标签 → 写构思 → 生成 → 预览 → 插入编辑器 / 接着写下去
 * 翻译成英文不在这里 —— 那是语言页签旁边那颗按钮干的事（对整篇文章生效）。
 */
export function StoryComposer({
  open,
  onClose,
  onApply,
  getCurrentZhText,
  onAppend,
  combo,
  onComboChange,
  hasExistingContent,
  sourceArticleId,
  showToast,
}: StoryComposerProps) {
  const [tags, setTags] = useState<StoryTag[]>([])
  const [tagError, setTagError] = useState('')
  const [loadingTags, setLoadingTags] = useState(false)
  const [presets, setPresets] = useState<Preset[]>([])
  const [loadingPresets, setLoadingPresets] = useState(false)
  const [savingPreset, setSavingPreset] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [showPresetInput, setShowPresetInput] = useState(false)
  const [idea, setIdea] = useState('')
  /** 多篇参考素材：按顺序对应第 1..N 篇；至少保留一个输入框 */
  const [materialInputs, setMaterialInputs] = useState<string[]>(() => materialListFromCombo(combo))
  /** 标签库默认收起，避免七排标签一打开就铺满整屏 */
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [preview, setPreview] = useState<GeneratedStory | null>(null)
  const [applied, setApplied] = useState(false)
  const [busy, setBusy] = useState<'idle' | 'generate' | 'batch' | 'continue' | 'review' | 'rewrite' | 'section'>('idle')
  /** 批量创作：一次写几篇（1 就是普通生成），以及跑到第几篇、已经落库几篇 */
  const [batchCount, setBatchCount] = useState(1)
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; created: number } | null>(null)
  const [batchResults, setBatchResults] = useState<BatchResult[]>([])
  /** 分段流水线的进度：规划骨架 → 逐段写 → 收尾 */
  const [progress, setProgress] = useState<{ phase: 'plan' | 'write' | 'finalize'; current: number; total: number } | null>(null)
  /** 正在重写哪一段（null = 没有单段任务） */
  const [sectionBusy, setSectionBusy] = useState<number | null>(null)
  /** 每段的「重写要求」草稿，按段号存 */
  const [sectionNotes, setSectionNotes] = useState<Record<number, string>>({})
  /** 展开查看/重写哪一段 */
  const [openSection, setOpenSection] = useState<number | null>(0)
  /** 前面的段被改过之后，从这一段开始后面的稿子可能已经对不上 */
  const [staleFrom, setStaleFrom] = useState<number | null>(null)
  // P3：自评报告 + 勾选要改的条目（评审一出来就按「必改 / 低分维度」默认勾好）
  const [review, setReview] = useState<StoryReview | null>(null)
  const [reviewSkill, setReviewSkill] = useState<{ code: string; name: string } | null>(null)
  const [reviewWarnings, setReviewWarnings] = useState<string[]>([])
  const [picked, setPicked] = useState<string[]>([])
  // 站长自己写的评价与想法 —— 和 AI 的清单一起当改稿依据（见 handleRewrite）；
  // 重写之后不清空：下一轮的诉求多半还是这几句，让他接着改。
  const [reviewNotes, setReviewNotes] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [tipSide, setTipSide] = useState<'left' | 'right'>('left')
  const [skills, setSkills] = useState<StorySkill[]>([])
  const [skillError, setSkillError] = useState('')
  /** 自动续写到第几轮 / 这一轮已补多少字（按钮上显示进度用） */
  const [continueRound, setContinueRound] = useState(0)
  const [continueGain, setContinueGain] = useState(0)
  /**
   * 「不要再撞」的往期标题：打开面板时从库里捞最近 12 篇（recentTitles），
   * 加上本次会话里刚生成出来的（sessionTitles）。两个合起来交给服务端写进提示词 ——
   * 这是对抗「文章同质化」最直接的一招，见 lib/storyPrompt.ts 的 buildStorySetting。
   */
  const [recentTitles, setRecentTitles] = useState<string[]>([])
  const [sessionTitles, setSessionTitles] = useState<string[]>([])

  const selection = combo || EMPTY_COMBO
  const length = Number(selection.length) || 1500
  /** 单篇生成 / 续写 / 改稿只用第 1 篇素材；批量时每篇各取各的。 */
  const materials = materialInputs[0] || ''
  /**
   * 素材优先模式：填了底本，情节就由底本决定。
   * 这时篇幅固定 2500（1500 常把底本后半段压成一句总结），标签只改文风，
   * 服务端也会强制同一套规则 —— 这里只负责把状态说清楚、把无效按钮锁掉。
   */
  const materialFirst = isMaterialFirst(materials)
  const hasAnyMaterial = materialInputs.some((item) => isMaterialFirst(item))
  const effectiveLength = materialFirst ? MATERIAL_FIRST_LENGTH : length
  const skillCode = selection.skill || ''
  const activeSkill = skills.find((s) => s.code === skillCode) || null
  const lastResolved = selection.lastResolved || null
  const lastResolvedSummary = lastResolved
    ? DIMENSIONS.filter((d) => (lastResolved.combo?.[d.key] || []).length)
        .map((d) => `${d.label} ${(lastResolved.combo?.[d.key] || []).join('＋')}`)
        .join(' · ')
    : ''
  const seedValue = selection.seed || ''
  const variantIndex = Math.max(0, Math.trunc(Number(selection.variantIndex) || 0))
  const storySections = preview?.sections || []

  const tagsByDim = useMemo(() => {
    const map: Partial<Record<DimensionKey, StoryTag[]>> = {}
    for (const t of tags) {
      if (!map[t.dimension]) map[t.dimension] = []
      map[t.dimension]!.push(t)
    }
    for (const key of Object.keys(map) as DimensionKey[]) {
      map[key]!.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.name.localeCompare(b.name))
    }
    return map
  }, [tags])

  // 打开面板时拉一次标签和预设（直连 Supabase，和 settings 页一个路子，不需要额外 API 路由）
  useEffect(() => {
    if (!open) return
    let alive = true
    const load = async () => {
      setLoadingTags(true)
      setTagError('')
      const { data, error: err } = await supabase
        .from('story_tags')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
      if (!alive) return
      if (err) {
        setTagError(
          /does not exist|schema cache|relation/i.test(err.message || '')
            ? '标签库还没建好：请先在 Supabase 里执行 supabase/42_story_tags.sql'
            : `读取标签失败：${err.message}`
        )
      } else {
        setTags((data || []) as StoryTag[])
      }
      setLoadingTags(false)

      setLoadingPresets(true)
      const { data: ps } = await supabase
        .from('story_presets')
        .select('id,name,combo,updated_at')
        .order('updated_at', { ascending: false })
        .limit(30)
      if (!alive) return
      setPresets(((ps || []) as any[]).map((p) => ({ id: p.id, name: p.name, combo: (p.combo || {}) as StoryCombo })))
      setLoadingPresets(false)

      // 写法库（story_skills）—— 站长的「怎么写」预设。表没建也照样能写稿，只是没有这一栏
      const { data: sk, error: skErr } = await supabase
        .from('story_skills')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
      if (!alive) return
      if (skErr) {
        setSkillError(
          /does not exist|schema cache|relation/i.test(skErr.message || '')
            ? '写法库还没建好：请先在 Supabase 里执行 supabase/43_story_skills.sql'
            : `读取写法失败：${skErr.message}`
        )
      } else {
        setSkills((sk || []) as StorySkill[])
      }

      // 往期标题：交给服务端写进「不要再撞」那一段。
      // 读不到（列名对不上 / 网络抖）也不影响写稿，只是少一层去重，所以静默降级。
      const { data: recentArticles, error: recentErr } = await supabase
        .from('articles')
        .select('title_zh,title')
        .order('created_at', { ascending: false })
        .limit(12)
      if (!alive) return
      if (recentErr) {
        console.warn('[story-composer] 读往期标题失败，本次不做查重：', recentErr.message)
        setRecentTitles([])
      } else {
        setRecentTitles(
          ((recentArticles || []) as any[])
            .map((r) => String(r?.title_zh || r?.title || '').trim())
            .filter(Boolean)
        )
      }
    }
    load()
    return () => {
      alive = false
    }
  }, [open])

  // 打开面板 / 换文章时，把该文章保存的素材列表读回来。
  // 注意不能把 combo 放进依赖：输入素材会同步给父组件，一放就会边打字边重置光标。
  useEffect(() => {
    if (!open) {
      setShowAdvanced(false)
      return
    }
    const list = materialListFromCombo(combo)
    setMaterialInputs(list)
    setBatchCount((prev) => Math.min(MAX_BATCH_STORIES, Math.max(prev, list.length)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sourceArticleId])

  // 标签库挂了就自动展开，别让站长对着一行「高级设置」猜为什么没标签
  useEffect(() => {
    if (tagError) setShowAdvanced(true)
  }, [tagError])

  // 生成本来就要等十几秒 —— 给个跳动的秒数，免得以为卡死了
  useEffect(() => {
    if (busy === 'idle') return
    setElapsed(0)
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [busy])

  const toggleTag = (dim: DimensionKey, name: string) => {
    const max = DIMENSIONS.find((d) => d.key === dim)?.max ?? 1
    const cur = selection[dim] || []
    let next: string[]
    if (cur.includes(name)) next = cur.filter((n) => n !== name)
    else if (max <= 1) next = [name]
    else next = [...cur, name].slice(-max)
    onComboChange({ ...selection, [dim]: next })
  }

  /** 再点一次已选中的写法 = 取消（回到库里的默认写法） */
  const toggleSkill = (code: string) => {
    onComboChange({ ...selection, skill: skillCode === code ? '' : code })
  }

  const rerollDim = (dim: DimensionKey) => {
    const pool = tagsByDim[dim] || []
    if (!pool.length) return
    const max = DIMENSIONS.find((d) => d.key === dim)?.max ?? 1
    const take = Math.random() < 0.35 ? max : 1
    const picked = [...pool].sort(() => Math.random() - 0.5).slice(0, take)
    onComboChange({ ...selection, [dim]: picked.map((t) => t.name) })
  }

  const rerollAll = () => {
    // 有底本时不随机补标签：随机设定会把底本的人物关系 / 事件 / 结局往另一条路拽。
    // 想换文风请到「高级设置」里手动选，标签仍然只改表层。
    if (hasAnyMaterial) {
      showToast('已有改编底本：不随机抽标签。要换文风请到「高级设置」手动选。', 'error')
      return
    }
    const next: StoryCombo = { length, idea: selection.idea, materials: selection.materials }
    for (const d of DIMENSIONS) {
      const pool = tagsByDim[d.key] || []
      if (!pool.length) continue
      const take = Math.random() < 0.4 ? d.max : 1
      next[d.key] = [...pool]
        .sort(() => Math.random() - 0.5)
        .slice(0, take)
        .map((t) => t.name)
    }
    onComboChange(next)
    showToast('已随机抽一套设定 🎲', 'success')
  }

  /** 素材列表的每次改动都同步进 story_combo，重开面板 / 存预设时不会丢 */
  const commitMaterialInputs = (next: string[]) => {
    const list = (next.length ? next : ['']).slice(0, MAX_BATCH_STORIES)
    setMaterialInputs(list)
    onComboChange({ ...selection, materials: list[0] || '', materialsList: list })
  }

  const updateMaterial = (index: number, value: string) => {
    commitMaterialInputs(materialInputs.map((item, i) => (i === index ? value : item)))
  }

  const addMaterial = () => {
    if (materialInputs.length >= MAX_BATCH_STORIES) return
    const next = [...materialInputs, '']
    commitMaterialInputs(next)
    // 素材 2 默认就是「生成 2 篇」；已经手动选了更多篇时不往回缩
    setBatchCount((prev) => Math.min(MAX_BATCH_STORIES, Math.max(prev, next.length)))
  }

  const removeMaterial = (index: number) => {
    const next = materialInputs.length <= 1 ? [''] : materialInputs.filter((_, i) => i !== index)
    commitMaterialInputs(next)
    setBatchCount((prev) => Math.max(1, Math.min(prev, next.length)))
  }

  const resetAll = () => {
    onComboChange({ length })
    setMaterialInputs([''])
    setBatchCount(1)
    setPreview(null)
    setApplied(false)
    setError('')
    setBatchResults([])
  }

  /**
   * 取一张尽量新鲜的 access_token；拿不到就返回空串。
   *
   * 实现搬去了 lib/clientAuth.ts —— 封面 / 正文图片直传 Storage 要用同一份逻辑
   * （那边还多一层「票被判定过期就换票重传」的自救），两份各写各的迟早走样。
   */
  const getFreshToken = getFreshAccessToken

  const apiPost = async (url: string, payload: unknown) => {
    const send = (token: string) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      })

    /**
     * 一次完整投递：取新鲜票 → 401 就换票重发 → 解析 JSON。
     * 独立成函数是因为下面「暂时性失败重发一次」时，得把这套换票逻辑再走一遍。
     */
    const deliver = async () => {
      const token = await getFreshToken(false)
      if (!token) throw new Error('登录状态失效，请刷新页面重新登录')

      let resp = await send(token)
      // 后台不认这张票：多半是刚刚过期 —— 换一张新的重发一次。
      // 只重试一次（换出来的还是同一张票就不重发），避免原地打转。
      let refreshedToken = ''
      if (resp.status === 401) {
        refreshedToken = await getFreshToken(true)
        if (refreshedToken && refreshedToken !== token) resp = await send(refreshedToken)
      }

      const json = await resp.json().catch(() => ({}))
      return { resp, json, refreshedToken }
    }

    let { resp, json, refreshedToken } = await deliver()

    /*
     * 暂时性失败自动重发一次 —— 这两种都不是「你操作错了」，而是「这次没赶上」：
     *   502 = 服务端到模型服务的网络断了（实测最常见：TLS 握手被中途 reset，约 5 秒就抛，
     *         表现为一句没头没脑的 fetch failed）。这种抖一下的失败重发几乎必成。
     *   503 = 服务端连不上 Supabase 校验登录态，同样是网络抖一下。
     * 504 故意不重发：那说明模型已经跑了五十多秒没回话，再等一遍就是让站长干等两分钟，
     * 不如把话讲清楚，让站长自己决定。
     */
    if (TRANSIENT_STATUS.has(resp.status)) {
      await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_WAIT_MS))
      ;({ resp, json, refreshedToken } = await deliver())
    }

    if (!resp.ok || !json?.ok) {
      // 拿着刚换出来的新凭证还被拒 → 不是「过期」能解释的：这张登录态本身已经作废
      // （在别处退出过 / 后台换了 Supabase 项目），只能重新登录。别让站长对着 unauthorized 猜。
      if (resp.status === 401 && refreshedToken) {
        throw new Error(`${json?.error || 'unauthorized'} —— 已自动换新登录凭证仍被拒绝，请退出后台重新登录一次`)
      }
      throw new Error(json?.error || `请求失败（${resp.status}）`)
    }
    return json.data
  }

  const resolvedTagsPayload = (map?: Partial<Record<DimensionKey, string[]>>) =>
    DIMENSIONS.map((d) => ({ dimension: d.key, names: map?.[d.key] || [] })).filter((x) => x.names.length)

  /**
   * P4 的分段写作流水线：骨架/表皮由 /plan 给，正文一段段写，最后只让模型起标题摘要。
   * 好处是每一段都能单独重写，且“后面才揭晓的事”不会在第二段就被写掉。
   */
  const runWritePipeline = async (
    plan: StoryPlanResponse,
    options?: { sourceArticleId?: string | null; materials?: string }
  ) => {
    const { skeleton } = plan
    const surface = plan.surface
    if (!skeleton?.beats?.length) throw new Error('规划结果里没有骨架，请重试')
    if (!surface) throw new Error('规划结果里没有人物/地点设定，请重试')

    /** 批量时每篇用自己那一份素材；单篇流程不传就用输入框第一份 */
    const writingMaterials = options?.materials === undefined ? materials : options.materials
    // 批量里可能前面几篇有底本、后面自由创作：篇幅必须逐篇算，不能拿第一篇的状态套全批
    const writingLength = isMaterialFirst(writingMaterials) ? MATERIAL_FIRST_LENGTH : length
    const resolvedSkill = plan.resolved?.skill || null
    const writingSkill = resolvedSkill?.code || skillCode
    const resolvedTags = plan.resolvedTags || resolvedTagsPayload(plan.resolved?.combo)
    const sections: StorySection[] = []

    for (let i = 0; i < skeleton.beats.length; i++) {
      setProgress({ phase: 'write', current: i + 1, total: skeleton.beats.length })
      const data = await apiPost('/api/ai/story/section', {
        mode: 'write',
        skeleton,
        surface,
        seeds: plan.seeds,
        seed: plan.seed,
        variantIndex: plan.variantIndex,
        sectionIndex: i,
        previousSections: sections,
        idea,
        materials: writingMaterials,
        length: writingLength,
        skill: writingSkill,
        resolvedTags,
      })
      const section = data?.section as StorySection | undefined
      if (!section?.html?.trim()) throw new Error(`第 ${i + 1} 段没有写出来，请重试`)
      sections.push(section)
    }

    setProgress({ phase: 'finalize', current: sections.length, total: skeleton.beats.length })
    const data = await apiPost('/api/ai/story/finalize', {
      skeleton,
      surface,
      seeds: plan.seeds,
      seed: plan.seed,
      variantIndex: plan.variantIndex,
      sections,
      idea,
      materials: writingMaterials,
      length: writingLength,
      skill: writingSkill,
      recipeId: plan.recipeId || null,
      sourceArticleId: options?.sourceArticleId === undefined ? sourceArticleId || null : options.sourceArticleId,
    })

    const sectionWarnings = sections.flatMap((s) => s.warnings || [])
    const story: GeneratedStory = {
      title: String(data?.title || '未命名短篇'),
      excerpt: String(data?.excerpt || ''),
      html: toStoryHtml(String(data?.html || sections.map((s) => s.html).join('\n'))),
      chars: Number(data?.chars || countChineseChars(htmlToPlainText(sections.map((s) => s.html).join('\n')))),
      materials: writingMaterials,
      warnings: Array.from(
        new Set([
          ...(plan.warnings || []),
          ...sectionWarnings,
          ...(Array.isArray(data?.warnings) ? data.warnings.map(String) : []),
        ])
      ),
      skill: data?.skill || resolvedSkill,
      truncated: false,
      sections,
      skeleton,
      surface,
      seed: plan.seed,
      variantIndex: plan.variantIndex,
      seeds: plan.seeds,
      fingerprint: plan.fingerprint || surface.fingerprint,
      recipeId: data?.recipeId || plan.recipeId || null,
      shareCode: data?.shareCode ? String(data.shareCode) : '',
      resolved: {
        combo: plan.resolved?.combo,
        skill: resolvedSkill,
        seed: plan.seed,
        variantIndex: plan.variantIndex,
      },
    }
    setPreview(story)
    setOpenSection(0)
    setSectionNotes({})
    setStaleFrom(null)
    if (story.title) setSessionTitles((prev) => [story.title, ...prev].slice(0, 12))
    return story
  }

  const handleGenerate = async () => {
    // 不再要求「至少选一个标签」：未选的维度由服务端每次重新随机补全。
    // 历史只放在 lastResolved 里展示，绝不回填成选中 —— 否则同质化永远治不好。
    setBusy('generate')
    setError('')
    setBatchResults([])
    setPreview(null)
    setApplied(false)
    setReview(null)
    setReviewSkill(null)
    setPicked([])
    setReviewNotes('')
    setProgress({ phase: 'plan', current: 0, total: 0 })
    try {
      // 「不要再撞」的名单：库里最近 12 篇 + 本次会话刚生成的几篇。
      // 不传也能生成，只是没有这层去重 —— 那就是「文章同质化」的来源。
      const avoidTitles = [...sessionTitles, ...recentTitles].slice(0, 16)
      const plan = (await apiPost('/api/ai/story/plan', {
        mode: 'full',
        combo: selection,
        idea,
        materials,
        length: effectiveLength,
        skill: skillCode,
        seed: seedValue || undefined,
        variantIndex,
        avoidTitles,
        sourceArticleId: sourceArticleId || null,
      })) as StoryPlanResponse

      const story = await runWritePipeline(plan)
      onComboChange({
        ...selection,
        idea,
        materials,
        length,
        skill: skillCode,
        seed: plan.seed,
        variantIndex: plan.variantIndex,
        lastResolved: {
          combo: plan.resolved?.combo || {},
          skill: story.skill || plan.resolved?.skill || null,
          seed: plan.seed,
          variantIndex: plan.variantIndex,
          at: new Date().toISOString(),
        },
      })
      showToast(
        `写好了：${story.chars} 字 · ${story.sections?.length || 0} 段 · Seed ${plan.seed}${
          plan.variantIndex ? ` · v${plan.variantIndex}` : ''
        }`,
        'success'
      )
    } catch (e: any) {
      setError(e?.message || '生成失败')
    } finally {
      setBusy('idle')
      setProgress(null)
    }
  }

  /**
   * 批量创作：一次写完 1–5 篇，每篇直接落库成「草稿」。
   *
   * 两件事必须同时成立，否则批量只会造出五篇像同一篇的东西：
   *   · 每篇换一个 Seed（标题、骨架、正文都不同）；
   *   · 把前几篇的人名/城市/地点/时间/物件作为 forbidden 传给 /plan，
   *     服务端在表皮层避开它们 —— 读者先看到的不是「同一个主角又来了」。
   */
  const handleBatchGenerate = async () => {
    if (busy !== 'idle') return
    const total = Math.max(1, Math.min(MAX_BATCH_STORIES, Math.trunc(Number(batchCount) || 1)))
    const baseSeed = normalizeSeed(seedValue || makeSeed())
    let created = 0
    let currentIndex = 0
    let currentTitle = ''
    setBatchResults([])
    setBusy('batch')
    setError('')
    setPreview(null)
    setApplied(false)
    setReview(null)
    setReviewSkill(null)
    setPicked([])
    setReviewNotes('')
    setBatchProgress({ current: 1, total, created: 0 })
    setProgress({ phase: 'plan', current: 0, total: 0 })
    onComboChange({ ...selection, seed: baseSeed, variantIndex: 0 })
    try {
      const forbidden: SurfaceIdentity[] = []
      const batchTitles: string[] = []
      let lastPlan: StoryPlanResponse | null = null
      let lastStory: GeneratedStory | null = null

      for (let i = 0; i < total; i++) {
        currentIndex = i
        currentTitle = ''
        setBatchProgress({ current: i + 1, total, created })
        setProgress({ phase: 'plan', current: 0, total: 0 })
        const batchSeed = deriveBatchSeed(baseSeed, i)
        const storyMaterials = String(materialInputs[i] || '').trim()
        const plan = (await apiPost('/api/ai/story/plan', {
          mode: 'full',
          combo: {
            ...selection,
            seed: batchSeed,
            variantIndex: 0,
            materials: storyMaterials,
            materialsList: materialInputs,
          },
          idea,
          materials: storyMaterials,
          length: isMaterialFirst(storyMaterials) ? MATERIAL_FIRST_LENGTH : length,
          skill: skillCode,
          seed: batchSeed,
          variantIndex: 0,
          avoidTitles: [...batchTitles, ...sessionTitles, ...recentTitles].slice(0, 16),
          forbiddenIdentities: forbidden,
          sourceArticleId: null,
        })) as StoryPlanResponse

        const story = await runWritePipeline(plan, { sourceArticleId: null, materials: storyMaterials })
        lastPlan = plan
        lastStory = story
        currentTitle = story.title
        if (story.surface) forbidden.push(surfaceIdentity(story.surface))
        batchTitles.push(story.title)

        const saved = (await apiPost('/api/admin/articles/draft', {
          title: story.title,
          title_zh: story.title,
          excerpt: '',
          excerpt_zh: story.excerpt,
          content_zh_html: story.html,
          story_combo: {
            ...selection,
            materials: storyMaterials,
            materialsList: [storyMaterials],
            length: isMaterialFirst(storyMaterials) ? MATERIAL_FIRST_LENGTH : length,
            seed: plan.seed,
            variantIndex: plan.variantIndex,
            skill: story.skill?.code || skillCode,
            batch: { index: i + 1, total },
          },
          category: 'AI',
        })) as { id?: string } | null
        created += 1
        setBatchResults((prev) => [
          ...prev,
          {
            index: i + 1,
            title: story.title,
            draftId: saved?.id || '',
            warnings: [...(plan.warnings || []), ...(story.warnings || [])],
            total,
          },
        ])
        setBatchProgress({ current: i + 1, total, created })
      }

      if (lastPlan && lastStory) {
        onComboChange({
          ...selection,
          idea,
          materials,
          length,
          skill: skillCode,
          seed: baseSeed,
          variantIndex: lastPlan.variantIndex,
          lastResolved: {
            combo: lastPlan.resolved?.combo || {},
            skill: lastStory.skill || lastPlan.resolved?.skill || null,
            seed: lastPlan.seed,
            variantIndex: lastPlan.variantIndex,
            at: new Date().toISOString(),
          },
        })
      }
      showToast(`已创建 ${created} 篇草稿 —— 到 TRENDS 列表逐篇检查、翻译、补封面`, 'success')
    } catch (e: any) {
      const message = e?.message || '批量生成失败'
      setBatchResults((prev) => {
        // 已经落库的那一篇在 try 里 push 过了；这里只补「中断在第几篇」
        if (prev.some((x) => x.index === currentIndex + 1)) return prev
        return [...prev, { index: currentIndex + 1, title: currentTitle, warnings: [], error: message, total }]
      })
      setError(
        created
          ? `批量生成中断：已经创建 ${created} 篇草稿，后面的没有继续。${message}`
          : message
      )
    } finally {
      setBusy('idle')
      setProgress(null)
      setBatchProgress(null)
    }
  }

  /** 发一个新 Seed：下一篇文章换一副骨架，但当前预览不丢 */
  const handleNewSeed = () => {
    onComboChange({ ...selection, seed: makeSeed(), variantIndex: 0 })
    setError('')
    showToast('已换新 Seed：下次生成用新骨架', 'success')
  }

  /**
   * 同 Seed 换一版：骨架逐字不动，只让表皮层换人、换地点、换物件，正文整篇重写。
   * 这是「同 Seed = 同骨架」和「每次读到不一样的故事」同时成立的用法。
   */
  const handleVariant = async () => {
    const baseSeed = preview?.seed || seedValue
    if (!preview?.skeleton || !baseSeed) {
      showToast('先完整生成一篇，才能同骨架换一版', 'error')
      return
    }
    const nextVariant = (preview.variantIndex ?? variantIndex) + 1
    // 批量里每篇底本不同：换版必须沿用「这一版」的底本，不能抓输入框第一份
    const baseMaterials = preview.materials ?? materials
    setBusy('generate')
    setError('')
    setApplied(false)
    setReview(null)
    setReviewSkill(null)
    setPicked([])
    setProgress({ phase: 'plan', current: 0, total: 0 })
    try {
      const plan = (await apiPost('/api/ai/story/plan', {
        mode: 'surface',
        skeleton: preview.skeleton,
        seed: baseSeed,
        variantIndex: nextVariant,
        combo: { ...selection, ...(preview.resolved?.combo || {}) },
        idea,
        materials: baseMaterials,
        length: effectiveLength,
        skill: preview.skill?.code || skillCode,
        sourceArticleId: sourceArticleId || null,
      })) as StoryPlanResponse

      const story = await runWritePipeline(plan, { materials: baseMaterials })
      onComboChange({
        ...selection,
        idea,
        materials,
        length,
        seed: baseSeed,
        variantIndex: nextVariant,
        lastResolved: {
          combo: plan.resolved?.combo || {},
          skill: story.skill || plan.resolved?.skill || null,
          seed: baseSeed,
          variantIndex: nextVariant,
          at: new Date().toISOString(),
        },
      })
      showToast(`已换一版（v${nextVariant}）：骨架不变，人物/地点/正文全换`, 'success')
    } catch (e: any) {
      setError(e?.message || '换一版失败')
    } finally {
      setBusy('idle')
      setProgress(null)
    }
  }

  /** 只重写某一段：前后段原样保留；改前面的段会提示后面可能对不上 */
  const handleSectionRewrite = async (index: number) => {
    if (!preview?.skeleton || !preview.surface || !storySections[index]) return
    const current = storySections[index]
    setBusy('section')
    setSectionBusy(index)
    setError('')
    try {
      const data = await apiPost('/api/ai/story/section', {
        mode: 'rewrite',
        skeleton: preview.skeleton,
        surface: preview.surface,
        seeds: preview.seeds,
        seed: preview.seed || seedValue,
        variantIndex: preview.variantIndex ?? variantIndex,
        sectionIndex: index,
        previousSections: storySections.slice(0, index),
        html: current.html,
        notes: sectionNotes[index] || '',
        idea,
        materials: preview.materials ?? materials,
        length: effectiveLength,
        skill: preview.skill?.code || skillCode,
        resolvedTags: resolvedTagsPayload(preview.resolved?.combo),
      })
      const section = data?.section as StorySection | undefined
      if (!section?.html?.trim()) throw new Error('重写没有返回正文，原稿已保留')

      const nextSections = storySections.map((s, i) => (i === index ? section : s))
      const mergedHtml = toStoryHtml(nextSections.map((s) => s.html).join('\n'))
      const mergedChars = countChineseChars(htmlToPlainText(mergedHtml))
      setPreview((prev) =>
        prev
          ? {
              ...prev,
              sections: nextSections,
              html: mergedHtml,
              chars: mergedChars,
              warnings: Array.from(new Set([...prev.warnings, ...(section.warnings || [])])),
            }
          : prev
      )
      setStaleFrom(index < nextSections.length - 1 ? index + 1 : null)
      setApplied(false)
      setReview(null)
      setReviewSkill(null)
      setPicked([])
      showToast(
        section.isFinal && !section.ended
          ? `第 ${index + 1} 段已重写，但结尾还不够明确，建议再收一次`
          : `第 ${index + 1} 段已重写：${current.chars} → ${section.chars} 字`,
        'success'
      )
    } catch (e: any) {
      setError(e?.message || '这一段重写失败（原稿没有动）')
    } finally {
      setBusy('idle')
      setSectionBusy(null)
    }
  }

  /**
   * 「接着写下去」—— 自动续写到写够、或撞到轮次上限为止。
   *
   * 三个关键点（都是实际用出来的坑）：
   *   1. 续写的"底稿"是**预览**，不一定是编辑器。以前只认编辑器正文，
   *      生成完还没点「插入编辑器」就点续写，只会得到一句「正文里还没有中文内容」——看着就像卡住了。
   *   2. 一轮不够就自己再来一轮。模型常写到输出上限就断，一轮只能补几百字；
   *      以前点一次才动一次，站长得反复点；现在一次点击一直补到目标字数。
   *   3. 已经插进编辑器的，续写要两边一起长（预览和编辑器各加一段），
   *      否则预览会比编辑器旧，再点「插入编辑器」反而把新续的内容盖掉。
   */
  const handleContinue = async () => {
    if (preview?.skeleton) {
      showToast('这一版已经按骨架逐段写完并收尾了；写得不顺的段落请用「重写这段」', 'error')
      return
    }
    const previewText = preview ? htmlToPlainText(preview.html).trim() : ''
    const draftText = previewText || getCurrentZhText().trim()
    if (draftText.length < 50) {
      showToast('正文里还没有中文内容，先写一段或先生成一篇', 'error')
      return
    }

    setBusy('continue')
    setError('')
    setContinueRound(0)
    setContinueGain(0)
    try {
      let accText = draftText
      let rounds = 0
      let gained = 0
      let lastTruncated = false
      // 预览可能是批量里的某一篇：续写沿用这一版自己的底本
      const continueMaterials = preview?.materials ?? materials

      for (let round = 1; round <= MAX_AUTO_CONTINUE_ROUNDS; round++) {
        setContinueRound(round)
        const data = await apiPost('/api/ai/story', {
          combo: selection,
          idea,
          materials: continueMaterials,
          length: effectiveLength,
          // 续写要沿用预览这一版实际用的写法；只传当前选择会把随机抽到的写法换掉
          skill: preview?.skill?.code || skillCode,
          continueFrom: accText,
        })
        const pieceHtml = toStoryHtml(String(data?.html || ''))
        const pieceChars = Number(data?.chars || 0)
        // 这一轮几乎没写出东西 —— 再点也是复读，停手，别耗站长时间
        if (!pieceHtml.trim() || pieceChars < CONTINUE_MIN_GAIN) break

        rounds = round
        gained += pieceChars
        accText = `${accText}\n${htmlToPlainText(pieceHtml)}`
        lastTruncated = Boolean(data?.truncated)
        setContinueGain(gained)

        setPreview((prev) =>
          prev
            ? {
                ...prev,
                html: `${prev.html}${pieceHtml}`,
                chars: (prev.chars || 0) + pieceChars,
                warnings: [],
                truncated: lastTruncated,
              }
            : prev
        )
        // 预览就是这一版的草稿；编辑器里已经有稿子的（已插入），让它一起长
        if (!preview || applied) onAppend(pieceHtml)

        // 写够了、这一轮也没被截断 → 收工
        if (!lastTruncated && countChineseChars(accText) >= effectiveLength * CONTINUE_ENOUGH_RATIO) break
      }

      if (!rounds) {
        setError('这一轮没写出新内容。换个构思，或者把篇幅调大一点再试。')
        return
      }
      onComboChange({ ...selection, idea, materials, materialsList: materialInputs, length, skill: skillCode })
      showToast(
        lastTruncated
          ? `已续写 ${gained} 字（${rounds} 轮 · 又被输出上限截断，可以再点一次继续补）`
          : `已续写 ${gained} 字（${rounds} 轮）`,
        'success'
      )
    } catch (e: any) {
      setError(e?.message || '续写失败')
    } finally {
      setBusy('idle')
      setContinueRound(0)
      setContinueGain(0)
    }
  }

  /**
   * P3 第二遍：自评 —— 拿预览里的稿子换一份 6 维体检报告。
   * 只读不改：评审失败也不影响已经生成的稿子。
   * 站长若已经写了自己的评价，也一并给模型 —— 他关心的位置必须被评到（打分锚点照旧）。
   */
  const handleReview = async () => {
    if (!preview) return
    setBusy('review')
    setError('')
    try {
      const data = await apiPost('/api/ai/story/review', {
        title: preview.title,
        html: preview.html,
        materials: preview.materials ?? materials,
        length: effectiveLength,
        notes: reviewNotes.trim(),
        skill: preview.skill?.code || skillCode,
      })
      const r = data?.review as StoryReview
      if (!r?.scores?.length) throw new Error('自评返回的格式不对，请重试')
      setReview(r)
      setReviewSkill(data?.skill ?? null)
      // 默认勾「必改 + 没到 8 分的维度」——高分维度别动，改多了反而改坏
      setPicked(pickDefaultIssueIds(r))
      setReviewWarnings(Array.isArray(data?.warnings) ? data.warnings.map(String) : [])
      showToast(`自评完成：${r.total} 分 · ${r.issues.length} 条待改`, 'success')
    } catch (e: any) {
      setError(e?.message || '自评失败')
    } finally {
      setBusy('idle')
    }
  }

  /**
   * P3 第三遍：定向重写 —— 只改「勾选的 AI 条目 + 站长自己写的意见」，其余逐字保留。
   * 只有站长意见、一条 AI 条目都没勾也能改：他自己看出来的问题，凭什么非得 AI 先点头。
   *
   * 2026-10 修的一个洞：以前这里只传 issues / notes，站长填的【本篇构思】和【参考素材】
   * 压根没上去 —— 所以他写「主要情节参考我给的素材」，模型手里没有素材，只能猜着改，
   * 改完还是原来那一套。现在三样一起传；他要是明确要求改情节，后端会按情节级改动处理
   * （返回 plotLevel，篇幅变了是正常的）。
   */
  const handleRewrite = async () => {
    if (!preview) return
    const notes = reviewNotes.trim()
    const issues = (review?.issues || []).filter((i) => picked.includes(i.id))
    if (!issues.length && !notes) {
      showToast('先勾选要改的条目，或者在下面写几句你的想法', 'error')
      return
    }
    setBusy('rewrite')
    setError('')
    // 预览可能是批量里的某一篇：改稿沿用这一版自己的底本
    const rewriteMaterials = preview.materials ?? materials
    try {
      const data = await apiPost('/api/ai/story/rewrite', {
        title: preview.title,
        excerpt: preview.excerpt,
        html: preview.html,
        issues,
        notes,
        // 构思与参考素材跟着一起传：他说「按素材改编」时，模型才拿得到那份素材
        idea,
        materials: rewriteMaterials,
        // 改稿要沿用预览实际用的写法；只传当前选择会把随机抽到的写法换掉
        skill: preview.skill?.code || skillCode,
      })
      setPreview({
        title: String(data?.title || preview.title),
        excerpt: String(data?.excerpt || ''),
        html: toStoryHtml(String(data?.html || '')),
        chars: Number(data?.chars || 0),
        materials: rewriteMaterials,
        warnings: Array.isArray(data?.warnings) ? data.warnings.map(String) : [],
        skill: preview.skill,
      })
      // 改完这一版已经不是刚才被评的那一版：旧评分作废，也要重新「插入编辑器」
      // （站长写的意见保留 —— 他多半就是拿这几句在反复磨）
      setReview(null)
      setReviewSkill(null)
      setReviewWarnings([])
      setPicked([])
      setApplied(false)
      const basis = [issues.length ? `${issues.length} 条清单` : '', notes ? '你的意见' : ''].filter(Boolean).join(' + ')
      const plotLevel = Boolean(data?.plotLevel)
      showToast(
        plotLevel
          ? `已按${basis}做了情节级改写：${data?.before ?? '?'} → ${data?.after ?? '?'} 字（篇幅跟着变是正常的，请通读）`
          : `已按${basis}重写：${data?.before ?? '?'} → ${data?.after ?? '?'} 字`,
        'success'
      )
    } catch (e: any) {
      setError(e?.message || '重写失败（原稿没有动）')
    } finally {
      setBusy('idle')
    }
  }

  /** 重写按钮上的字：改稿依据有几份（AI 清单 / 站长意见），按钮就说几份 */
  const rewriteLabel = (() => {
    const hasNotes = !!reviewNotes.trim()
    if (picked.length && hasNotes) return `按 ${picked.length} 条 + 你的意见重写`
    if (picked.length) return `按勾选的 ${picked.length} 条重写`
    return hasNotes ? '按你的意见重写' : '勾选条目，或写下你的意见'
  })()

  const togglePicked = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const handleApply = () => {
    if (!preview) return
    if (preview.chars < 50) {
      showToast('内容太短了，先续写一点再插入', 'error')
      return
    }
    if (hasExistingContent && !applied && !window.confirm('正文里已经有中文内容了，插入会整篇替换掉它。要继续吗？')) return
    onComboChange({ ...selection, idea, materials, materialsList: materialInputs, length, skill: skillCode })
    onApply(preview)
    setApplied(true)
  }

  const applyPreset = (p: Preset) => {
    const next: StoryCombo = { ...(p.combo || {}), length: Number(p.combo?.length) || 1500 }
    onComboChange({ ...selection, ...next })
    setIdea(String(p.combo?.idea || ''))
    const list = materialListFromCombo(next)
    setMaterialInputs(list)
    setBatchCount(Math.max(1, Math.min(MAX_BATCH_STORIES, list.length)))
    showToast(`已套用预设：${p.name}`, 'success')
  }

  const savePreset = async () => {
    const autoName =
      DIMENSIONS.filter((d) => (selection[d.key] || []).length)
        .slice(0, 3)
        .map((d) => (selection[d.key] || []).join('＋'))
        .join('·') || '未命名组合'
    const name = (presetName.trim() || autoName).slice(0, 30)
    setSavingPreset(true)
    try {
      const { error: err } = await supabase
        .from('story_presets')
        .insert([{ name, combo: { ...selection, idea, materials, materialsList: materialInputs, length } }])
      if (err) throw err
      const { data } = await supabase
        .from('story_presets')
        .select('id,name,combo,updated_at')
        .order('updated_at', { ascending: false })
        .limit(30)
      setPresets(((data || []) as any[]).map((p) => ({ id: p.id, name: p.name, combo: (p.combo || {}) as StoryCombo })))
      setPresetName('')
      setShowPresetInput(false)
      showToast('预设已保存到云端', 'success')
    } catch (e: any) {
      const dup = e?.code === '23505'
      showToast(dup ? `已经有叫「${name}」的预设了，换个名字` : `保存预设失败：${e?.message || e}`, 'error')
    } finally {
      setSavingPreset(false)
    }
  }

  const deletePreset = async (p: Preset) => {
    if (!window.confirm(`删除预设「${p.name}」？`)) return
    const { error: err } = await supabase.from('story_presets').delete().eq('id', p.id)
    if (err) {
      showToast(`删除失败：${err.message}`, 'error')
      return
    }
    setPresets((prev) => prev.filter((x) => x.id !== p.id))
  }

  if (!open) return null

  const chosenSummary = DIMENSIONS.filter((d) => (selection[d.key] || []).length)
    .map((d) => `${d.label} ${(selection[d.key] || []).join('＋')}`)
    .join(' · ')
  const pickedTagCount = DIMENSIONS.reduce((sum, d) => sum + (selection[d.key] || []).length, 0)

  const tipWidth = 240

  /** 批量结果：成功几篇、中断几篇、还剩几篇没轮到 */
  const batchOkCount = batchResults.filter((x) => !x.error).length
  const batchErrorCount = batchResults.filter((x) => x.error).length
  const batchTotal = Math.max(0, ...batchResults.map((x) => x.total || 0))
  const batchSkipped = batchErrorCount ? Math.max(0, batchTotal - batchResults.length) : 0

  return (
    <>
      {/* 遮罩：点一下关掉 */}
      <div className="fixed inset-0 bg-slate-900/25 backdrop-blur-[2px] z-[79]" onClick={onClose} />

      <aside className="fixed inset-y-0 right-0 z-[80] w-full sm:w-[560px] lg:w-[640px] bg-white shadow-2xl flex flex-col">
        {/* 头部 */}
        <header className="flex items-start justify-between gap-4 px-8 py-7 border-b border-slate-100 shrink-0">
          <div>
            <h2 className="text-xl font-black italic tracking-tighter text-left flex items-center gap-2">
              <Sparkles size={18} className="text-indigo-500" /> AI 创作
            </h2>
            <p className="text-[9px] font-black uppercase tracking-[0.3em] text-slate-400 mt-1.5 text-left">
              Story Composer · 生成中文短篇
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={rerollAll}
              disabled={hasAnyMaterial}
              title={hasAnyMaterial ? '已填改编底本：不随机抽标签（可在高级设置里手动选）' : '随机抽一整套设定'}
              className="w-10 h-10 flex items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600 hover:bg-indigo-100 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <Dices size={18} />
            </button>
            <button
              type="button"
              onClick={resetAll}
              title="清空所有选择"
              className="w-10 h-10 flex items-center justify-center rounded-2xl bg-slate-50 text-slate-400 hover:bg-slate-100 transition-all"
            >
              <RotateCcw size={16} />
            </button>
            <button
              type="button"
              onClick={onClose}
              title="关闭"
              className="w-10 h-10 flex items-center justify-center rounded-2xl bg-slate-900 text-white hover:scale-105 transition-all"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {/* 主体（可滚动） */}
        <div className="flex-1 overflow-y-auto px-8 py-7 space-y-7">
          {/* 上一次实际用了什么 —— 只读记录；不回填成选中，避免随机结果变成默认 */}
          {lastResolved && (
            <div className="p-4 rounded-3xl bg-slate-50 border border-slate-100 text-left">
              <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                上次实际用到 · 仅记录，不会自动选中
              </p>
              <p className="mt-1.5 text-[11px] font-bold text-slate-500 leading-relaxed">
                {lastResolvedSummary || '（没有记录到标签）'}
                {lastResolved.skill?.code && (
                  <span className="text-indigo-500"> · 写法 {lastResolved.skill.code}（{lastResolved.skill.name}）</span>
                )}
                {lastResolved.seed && (
                  <span className="text-slate-400">
                    {' '}
                    · Seed {lastResolved.seed}
                    {lastResolved.variantIndex ? ` · v${lastResolved.variantIndex}` : ''}
                  </span>
                )}
              </p>
              {lastResolved.at && (
                <p className="mt-1 text-[9px] font-bold text-slate-300">
                  {new Date(lastResolved.at).toLocaleString('zh-CN')}
                </p>
              )}
            </div>
          )}

          {/* 分段流水线进度：规划骨架 → 逐段写 → 收尾 */}
          {progress && (busy === 'generate' || busy === 'batch') && (
            <div className="p-5 rounded-3xl bg-indigo-50/70 border border-indigo-100 text-left space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-[11px] font-black text-indigo-700">
                  <Loader2 size={13} className="animate-spin" />
                  {batchProgress
                    ? `批量创作 ${batchProgress.current}/${batchProgress.total} 篇 · 已建 ${batchProgress.created} 篇草稿`
                    : progress.phase === 'plan'
                      ? '正在规划骨架、人物与场景…'
                      : progress.phase === 'write'
                        ? `正在写第 ${progress.current}/${progress.total} 段…`
                        : '正文写完，正在起标题与摘要…'}
                </span>
                <span className="text-[10px] font-black text-indigo-400">{elapsed}s</span>
              </div>
              <div className="h-1.5 rounded-full bg-white overflow-hidden">
                <div
                  className="h-full rounded-full bg-indigo-500 transition-all"
                  style={{
                    width: `${Math.min(
                      100,
                      progress.phase === 'plan' ? 6 : progress.phase === 'write' ? 8 + (progress.current / Math.max(1, progress.total)) * 86 : 96
                    )}%`,
                  }}
                />
              </div>
              <p className="text-[9px] font-bold text-indigo-400 leading-relaxed">
                每段有独立的字数硬边界和「禁止提前揭晓」；写坏了可以只重写那一段。
              </p>
            </div>
          )}


          {skills.length > 0 && (
            <div className="space-y-2.5 pb-7 border-b border-slate-100">
              <div className="flex items-center justify-between px-1">
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 text-left">
                  <span className="text-slate-300 mr-1.5">笔法</span>
                  写法
                  <span className="ml-2 font-bold tracking-normal normal-case text-slate-300">
                    {materialFirst
                      ? '只改腔调 · 不选 = 按底本平实改编（不随机）'
                      : hasAnyMaterial
                        ? '有素材的篇目不选 = 不抽写法；没素材的篇目照常随机'
                        : '不选 = 每次随机抽一种写法'}
                  </span>
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                {skills.map((s) => {
                  const active = skillCode === s.code
                  return (
                    <button
                      key={s.id || s.code}
                      type="button"
                      onClick={() => toggleSkill(s.code)}
                      onMouseEnter={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect()
                        setTipSide(rect.right + tipWidth > window.innerWidth ? 'right' : 'left')
                      }}
                      className={`group relative px-3.5 py-2 rounded-2xl text-[11px] font-bold border transition-all ${
                        active
                          ? 'bg-indigo-600 text-white border-indigo-600 shadow-lg'
                          : 'bg-white text-slate-500 border-slate-100 hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <span className="font-black mr-1.5">{s.code}</span>
                      {s.name}
                      {/* 鼠标停住就能看到「一句话卖点 / 这套写法是什么 / 适合什么题材」 */}
                      <span
                        className={`pointer-events-none absolute top-full mt-2 ${
                          tipSide === 'left' ? 'left-0' : 'right-0'
                        } z-[90] hidden group-hover:block w-72 p-4 rounded-2xl bg-amber-50 border border-amber-200 shadow-xl text-left`}
                      >
                        <span className="block text-[10px] font-black text-amber-900 mb-1.5 normal-case tracking-normal">
                          {s.tagline || s.name}
                        </span>
                        <span className="block text-[10px] leading-relaxed text-amber-800 normal-case tracking-normal">
                          {s.summary}
                        </span>
                        {s.best_for && (
                          <span className="block text-[10px] leading-relaxed text-amber-600 mt-1.5 normal-case tracking-normal">
                            适合：{s.best_for}
                          </span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {skillError && (
            <div className="p-5 rounded-3xl bg-amber-50 border border-amber-100 text-[11px] font-bold text-amber-700 leading-relaxed text-left">
              {skillError}
            </div>
          )}

          {/* 高级设置：七排标签默认收起来，选过的组合仍以一行摘要露在外面 */}
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              className="w-full flex items-center justify-between gap-3 px-1 py-1.5 text-left group"
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <span className="w-8 h-8 shrink-0 rounded-2xl bg-indigo-50 text-indigo-500 flex items-center justify-center group-hover:bg-indigo-100 transition-colors">
                  <Layers size={14} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[10px] font-black uppercase tracking-widest text-slate-500">
                    高级设置
                  </span>
                  <span className={`block text-[9px] font-bold mt-0.5 ${tagError ? 'text-rose-500' : 'text-slate-300'}`}>
                    {tagError
                      ? '标签库读取失败'
                      : loadingTags
                        ? '正在装载标签…'
                        : materialFirst
                          ? '标签只改文风 / 人称 · 不随机补全'
                          : hasAnyMaterial
                            ? '有素材的篇目只改文风 / 人称 · 不随机补全'
                            : '标签库 · 未选的维度每次随机抽'}
                  </span>
                </span>
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <span
                  className={`px-2.5 py-1 rounded-full text-[9px] font-black ${
                    pickedTagCount ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-400'
                  }`}
                >
                  {pickedTagCount ? `已选 ${pickedTagCount}` : '未选'}
                </span>
                {showAdvanced ? (
                  <ChevronUp size={14} className="text-slate-400" />
                ) : (
                  <ChevronDown size={14} className="text-slate-400" />
                )}
              </span>
            </button>

            {!showAdvanced && (
              <p className="px-1 text-[9px] font-bold text-slate-400 leading-relaxed text-left truncate">
                {chosenSummary ||
                  (materialFirst
                    ? '已填素材：情节以底本为准，标签只改文风 / 人称。'
                    : '全部留空也行：没选的维度会由系统每次随机补全。')}
              </p>
            )}

            {showAdvanced && (
              <div className="space-y-5 pt-2">
                {loadingTags && (
                  <div className="flex items-center gap-3 text-[11px] font-bold text-slate-400">
                    <Loader2 size={14} className="animate-spin" /> 正在装载 48 个标签…
                  </div>
                )}

                {tagError && (
                  <div className="p-5 rounded-3xl bg-rose-50 border border-rose-100 text-[11px] font-bold text-rose-600 leading-relaxed text-left">
                    {tagError}
                  </div>
                )}

                {!tagError &&
                  DIMENSIONS.map((dim) => {
              const rowTags = tagsByDim[dim.key] || []
              const picked = selection[dim.key] || []
              return (
                <div key={dim.key} className="space-y-2.5">
                  <div className="flex items-center justify-between px-1">
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 text-left">
                      <span className="text-slate-300 mr-1.5">{dim.cn}</span>
                      {dim.label}
                      <span className="ml-2 font-bold tracking-normal normal-case text-slate-300">{dim.hint}</span>
                      {dim.max > 1 && <span className="ml-2 text-[8px] text-indigo-400">可多选（最多 {dim.max}）</span>}
                    </label>
                    <button
                      type="button"
                      onClick={() => rerollDim(dim.key)}
                      title={`随机抽一个${dim.label}`}
                      className="text-slate-300 hover:text-indigo-500 transition-colors"
                    >
                      <Dices size={14} />
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {rowTags.map((tag) => {
                      const active = picked.includes(tag.name)
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() => toggleTag(dim.key, tag.name)}
                          onMouseEnter={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect()
                            setTipSide(rect.right + tipWidth > window.innerWidth ? 'right' : 'left')
                          }}
                          className={`group relative px-3.5 py-2 rounded-2xl text-[11px] font-bold border transition-all ${
                            active
                              ? 'bg-slate-900 text-white border-slate-900 shadow-lg'
                              : 'bg-white text-slate-500 border-slate-100 hover:border-slate-300 hover:bg-slate-50'
                          }`}
                        >
                          {tag.name}
                          {/* 黄色提示：鼠标停住就能看到「是什么 / 例句 / 什么时候用」 */}
                          <span
                            className={`pointer-events-none absolute top-full mt-2 ${
                              tipSide === 'left' ? 'left-0' : 'right-0'
                            } z-[90] hidden group-hover:block w-60 p-4 rounded-2xl bg-amber-50 border border-amber-200 shadow-xl text-left`}
                          >
                            <span className="block text-[10px] font-black text-amber-900 mb-1.5 normal-case tracking-normal">
                              {tag.summary || tag.name}
                            </span>
                            {tag.example && (
                              <span className="block text-[10px] leading-relaxed text-amber-800 normal-case tracking-normal">
                                例句：{tag.example}
                              </span>
                            )}
                            {tag.usage_note && (
                              <span className="block text-[10px] leading-relaxed text-amber-600 mt-1.5 normal-case tracking-normal">
                                适用：{tag.usage_note}
                              </span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
                  })}
              </div>
            )}
          </div>

          {/* 构思 —— 这一栏比任何标签都重要 */}
          <div className="space-y-2.5 pt-4 border-t border-slate-100">
            <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 text-left block">
              本篇构思
              <span className="ml-2 font-bold tracking-normal normal-case text-slate-300">写具体一点，AI 会照着它写</span>
            </label>
            <textarea
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              rows={3}
              placeholder="例如：合租的室友连续一周半夜出门，我决定跟踪他。"
              className="w-full p-5 bg-slate-50 rounded-3xl border border-slate-100 outline-none text-[13px] font-medium leading-relaxed resize-none focus:border-indigo-200 focus:bg-white transition-all"
            />
          </div>

          {/* 参考素材 —— 有素材就是「改编底本」：以它为主线情节，AI 只补细节与衔接 */}
          <div className="space-y-3">
            <div className="flex items-end justify-between gap-3">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 text-left block">
                参考素材 · 改编底本
                <span className="ml-2 font-bold tracking-normal normal-case text-slate-300">
                  可留空 · 一篇对应一篇 · 填了即「素材优先」
                </span>
              </label>
              <button
                type="button"
                onClick={addMaterial}
                disabled={materialInputs.length >= MAX_BATCH_STORIES}
                title={
                  materialInputs.length >= MAX_BATCH_STORIES
                    ? `一次批量最多 ${MAX_BATCH_STORIES} 篇`
                    : '再加一篇素材（自动把批量篇数加到对应数量）'
                }
                className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-2xl bg-indigo-50 border border-indigo-100 text-[9px] font-black uppercase tracking-widest text-indigo-600 hover:bg-indigo-100 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                <Plus size={12} /> 添加素材
              </button>
            </div>

            <div className="space-y-3">
              {materialInputs.map((item, index) => {
                const active = index < batchCount
                return (
                  <div
                    key={index}
                    className={`rounded-3xl border p-3.5 transition-colors ${
                      active ? 'bg-slate-50 border-slate-100' : 'bg-white border-dashed border-slate-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3 px-1 mb-2">
                      <span className="flex items-center gap-2 text-[9px] font-black uppercase tracking-widest text-slate-400">
                        素材 {index + 1}
                        <span
                          className={`px-2 py-0.5 rounded-full text-[8px] font-black tracking-normal normal-case ${
                            active ? 'bg-indigo-50 text-indigo-500' : 'bg-slate-100 text-slate-300'
                          }`}
                        >
                          {active ? `→ 第 ${index + 1} 篇` : `第 ${index + 1} 篇未启用`}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => removeMaterial(index)}
                        title={materialInputs.length <= 1 ? '清空这一篇素材' : `删除素材 ${index + 1}`}
                        aria-label={materialInputs.length <= 1 ? '清空素材' : `删除素材 ${index + 1}`}
                        className="p-1.5 rounded-xl text-slate-300 hover:text-rose-500 hover:bg-rose-50 transition-all"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <textarea
                      value={item}
                      onChange={(e) => updateMaterial(index, e.target.value)}
                      rows={3}
                      placeholder={
                        index === 0
                          ? '粘贴原始故事或梗概：生成时会以它为主线情节来改编，AI 只补细节、场景衔接和缺失的铺垫。'
                          : `粘贴第 ${index + 1} 篇的原始故事或梗概……`
                      }
                      className="w-full p-5 bg-white rounded-3xl border border-slate-100 outline-none text-[13px] font-medium leading-relaxed resize-none focus:border-indigo-200 transition-all"
                    />
                  </div>
                )
              })}
            </div>

            {hasAnyMaterial && (
              <div className="p-4 rounded-3xl bg-indigo-50/70 border border-indigo-100 text-left">
                <p className="text-[9px] font-black uppercase tracking-widest text-indigo-500">
                  素材优先模式{materialFirst ? ' · 已启用' : ' · 部分篇目启用'}
                </p>
                <p className="mt-1.5 text-[10px] font-bold text-indigo-700/80 leading-relaxed">
                  填了素材的篇目，情节、人物关系、关键事件和结局都以底本为准，AI 只补细节、场景衔接和缺失的铺垫。
                  这些篇目固定写 {MATERIAL_FIRST_LENGTH} 字；标签与写法只改文风、人称和腔调，不会随机补全，也不会把故事带离底本。
                </p>
              </div>
            )}

            <p className="text-[9px] font-bold text-slate-300 leading-relaxed text-left px-1">
              多篇素材按顺序用于批量生成：素材 1 → 第 1 篇，素材 2 → 第 2 篇……；没有素材的篇目按上面的构思自由创作。
              {batchCount < materialInputs.length && (
                <span className="block text-amber-500 mt-1">
                  当前只生成 {batchCount} 篇，第 {batchCount + 1} 篇起的素材暂不参与本次批量。
                </span>
              )}
            </p>
          </div>

          {/* 篇幅 */}
          <div className="space-y-2.5">
            <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 text-left block">篇幅</label>
            <div className="grid grid-cols-3 gap-2">
              {LENGTH_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => onComboChange({ ...selection, length: p.value })}
                  disabled={materialFirst}
                  title={materialFirst ? '素材优先：固定 2500 字，避免把底本后半段压成总结' : undefined}
                  className={`py-3 rounded-2xl text-[10px] font-black border transition-all ${
                    effectiveLength === p.value
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-400 border-slate-100 hover:border-slate-300'
                  } ${materialFirst && effectiveLength !== p.value ? 'opacity-40' : ''} disabled:cursor-not-allowed`}
                >
                  {p.label}
                  {materialFirst && p.value === MATERIAL_FIRST_LENGTH && (
                    <span className="ml-1 text-[8px] tracking-normal">· 素材优先</span>
                  )}
                </button>
              ))}
            </div>
            <p className="text-[9px] text-slate-300 leading-relaxed text-left px-1">
              {materialFirst
                ? `${MATERIAL_FIRST_LENGTH} 字是素材优先的固定篇幅：底本后半段（转折、收束）才不会因为篇幅不够被压成一句总结。`
                : hasAnyMaterial
                  ? `有素材的篇目固定 ${MATERIAL_FIRST_LENGTH} 字；没有素材的篇目按这里选的篇幅自由创作。`
                  : '1500 字大约要 20–40 秒。模型偶尔会偷工写短，用底部「接着写下去」补足就行。'}
            </p>
          </div>

          {/* Seed · 同 Seed 同骨架 / 换一版换表皮 */}
          <div className="space-y-3 pt-4 border-t border-slate-100">
            <div className="flex items-center justify-between gap-3">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 text-left block">
                Seed · 复现
                <span className="ml-2 font-bold tracking-normal normal-case text-slate-300">
                  同 Seed = 同一副骨架
                </span>
              </label>
              <span className="text-[10px] font-black text-slate-400">v{variantIndex}</span>
            </div>
            <div className="flex gap-2">
              <input
                value={seedValue}
                onChange={(e) => onComboChange({ ...selection, seed: e.target.value, variantIndex: 0 })}
                placeholder="留空 = 每次生成新 Seed"
                className="flex-1 px-4 py-3 bg-slate-50 rounded-2xl border border-slate-100 outline-none text-[12px] font-bold focus:border-indigo-200 transition-all"
              />
              <button
                type="button"
                onClick={handleNewSeed}
                disabled={busy !== 'idle'}
                title="发一个新 Seed：下一篇文章换一副骨架"
                className="px-4 rounded-2xl bg-slate-900 text-white text-[10px] font-black uppercase flex items-center gap-2 disabled:opacity-50"
              >
                <Dices size={13} /> 新 Seed
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {preview?.skeleton && (!seedValue || !preview.seed || seedValue === preview.seed) && (
                <button
                  type="button"
                  onClick={handleVariant}
                  disabled={busy !== 'idle'}
                  title="骨架逐字不动，只换人名、地点、时间、物件，正文整篇重写"
                  className="px-4 py-2.5 rounded-2xl bg-indigo-50 border border-indigo-100 text-[10px] font-black uppercase tracking-widest text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 transition-all flex items-center gap-2"
                >
                  {busy === 'generate' && progress?.phase !== 'plan' ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RotateCcw size={12} />
                  )}
                  同 Seed 换一版（v{(preview.variantIndex ?? variantIndex) + 1}）
                </button>
              )}
              {preview?.skeleton && seedValue && preview.seed && seedValue !== preview.seed && (
                <span className="px-3 py-2 rounded-2xl bg-amber-50 border border-amber-100 text-[9px] font-black text-amber-600">
                  Seed 已改：先生成一篇，再同 Seed 换一版
                </span>
              )}
              {preview?.shareCode && (
                <span className="px-3 py-2 rounded-2xl bg-slate-50 border border-slate-100 text-[9px] font-black text-slate-400">
                  分享码 {preview.shareCode}
                </span>
              )}
              {preview?.fingerprint && (
                <span className="px-3 py-2 rounded-2xl bg-slate-50 border border-slate-100 text-[9px] font-black text-slate-300">
                  表皮 {preview.fingerprint}
                </span>
              )}
            </div>
            <p className="text-[9px] text-slate-300 leading-relaxed text-left px-1">
              同一 Seed 会复用同一副骨架；「换一版」只换人物/地点/时间/物件和正文。逐字复现请靠插入编辑器后保存文章的原文。
              {sourceArticleId ? ' 本次会把当前文章 id 记进 story_recipe_variants。' : ''}
            </p>
          </div>


          <div className="space-y-3 pt-4 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 text-left block">
                常用配方
              </label>
              <button
                type="button"
                onClick={() => setShowPresetInput((v) => !v)}
                className="flex items-center gap-1.5 text-[9px] font-black uppercase text-indigo-500 hover:text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-full transition-all"
              >
                <Save size={11} /> 保存当前组合
              </button>
            </div>

            {showPresetInput && (
              <div className="flex gap-2">
                <input
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder="起个名字，例如「刑侦味」"
                  className="flex-1 px-4 py-3 bg-slate-50 rounded-2xl border border-slate-100 outline-none text-[12px] font-bold focus:border-indigo-200 transition-all"
                />
                <button
                  type="button"
                  onClick={savePreset}
                  disabled={savingPreset}
                  className="px-5 rounded-2xl bg-slate-900 text-white text-[10px] font-black uppercase flex items-center gap-2 disabled:opacity-50"
                >
                  {savingPreset ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} 存
                </button>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {loadingPresets && <span className="text-[10px] text-slate-300 italic">正在读取预设…</span>}
              {!loadingPresets && presets.length === 0 && (
                <span className="text-[10px] text-slate-300 italic">
                  还没有预设。选好标签后点「保存当前组合」，下次一键套用。
                </span>
              )}
              {presets.map((p) => (
                <span
                  key={p.id}
                  className="inline-flex items-center gap-1.5 pl-3.5 pr-2 py-2 rounded-2xl bg-indigo-50 border border-indigo-100"
                >
                  <button type="button" onClick={() => applyPreset(p)} className="text-[11px] font-bold text-indigo-700">
                    {p.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => deletePreset(p)}
                    title="删除这个预设"
                    className="text-indigo-300 hover:text-rose-500 transition-colors"
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              ))}
            </div>
          </div>

          {/* 生成结果预览 */}
          {preview && (
            <div className="space-y-4 p-6 rounded-[32px] bg-slate-50 border border-slate-100">
              <div className="flex items-center justify-between gap-3">
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 text-left block">
                  预览
                </label>
                <span className="text-[10px] font-black text-slate-400">
                  {preview.chars} 字
                  {preview.skill && <span className="ml-2 text-indigo-500">· 写法 {preview.skill.code}</span>}
                  {applied && <span className="ml-2 text-emerald-600">· 已插入编辑器</span>}
                </span>
              </div>
              <h3 className="text-lg font-black text-slate-900 leading-snug text-left">{preview.title}</h3>
              {preview.excerpt && (
                <p className="text-[11px] text-slate-400 leading-relaxed italic text-left">{preview.excerpt}</p>
              )}

              {/* P4 分段：展开某一段可以只重写它，前后段逐字保留 */}
              {storySections.length > 0 && (
                <div className="space-y-2 pt-3 border-t border-slate-200/80">
                  <div className="flex items-center justify-between gap-3">
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 text-left block">
                      分段 · 可单独重写
                    </label>
                    <span className="text-[9px] font-black text-slate-300">
                      {storySections.length} 段 · 骨架 {preview.skeleton?.skeletonHash?.slice(0, 6) || '—'}
                    </span>
                  </div>
                  {staleFrom !== null && (
                    <p className="flex items-start gap-2 text-[10px] font-bold text-amber-600 text-left">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      第 {staleFrom + 1} 段起还是按旧稿写的，可能和刚改的那段对不上；要顺一遍就逐段重写。
                    </p>
                  )}
                  {storySections.map((s, i) => {
                    const expanded = openSection === i
                    const target = preview.skeleton?.beats[i]?.targetChars
                    return (
                      <div key={`${s.beatId}-${i}`} className="rounded-2xl bg-white border border-slate-100 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setOpenSection(expanded ? null : i)}
                          className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50/70 transition-colors"
                        >
                          <span className="text-[11px] font-black text-slate-700">
                            第 {i + 1} 段 · {s.function || '未命名功能'}
                          </span>
                          <span className="flex items-center gap-2 text-[9px] font-black text-slate-400 shrink-0">
                            <span>{s.chars} 字{target ? ` / 目标 ${target}` : ''}</span>
                            <span className={s.stateDelta === 'breaking' ? 'text-rose-500' : s.stateDelta === 'additive' ? 'text-indigo-500' : 'text-slate-300'}>
                              {s.stateDelta === 'breaking' ? '改变方向' : s.stateDelta === 'additive' ? '追加信息' : '保持'}
                            </span>
                            {s.isFinal && <span className={s.ended ? 'text-emerald-600' : 'text-amber-500'}>{s.ended ? '已收尾' : '未收尾'}</span>}
                            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                          </span>
                        </button>
                        {expanded && (
                          <div className="px-4 pb-4 space-y-3 border-t border-slate-100">
                            <div
                              className="pt-3 max-h-60 overflow-y-auto pr-1 text-[12px] leading-relaxed text-slate-600 text-left space-y-2"
                              dangerouslySetInnerHTML={{ __html: s.html }}
                            />
                            {s.warnings.map((w, wi) => (
                              <p key={wi} className="flex items-start gap-2 text-[9px] font-bold text-amber-600 text-left">
                                <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {w}
                              </p>
                            ))}
                            <textarea
                              value={sectionNotes[i] || ''}
                              onChange={(e) => setSectionNotes((prev) => ({ ...prev, [i]: e.target.value }))}
                              rows={2}
                              maxLength={800}
                              placeholder="这段想怎么改？（可留空：只让它重写得更具体）"
                              className="w-full p-3 bg-slate-50 rounded-2xl border border-slate-100 outline-none text-[11px] font-medium leading-relaxed resize-none focus:border-indigo-200 focus:bg-white transition-all"
                            />
                            <div className="flex items-center justify-between gap-3">
                              <button
                                type="button"
                                onClick={() => handleSectionRewrite(i)}
                                disabled={busy !== 'idle'}
                                className="px-4 py-2.5 rounded-2xl bg-slate-900 text-white text-[9px] font-black uppercase tracking-widest flex items-center gap-2 hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                              >
                                {sectionBusy === i ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                                {sectionBusy === i ? '正在重写这段…' : '重写这段'}
                              </button>
                              <span className="text-[9px] font-bold text-slate-300">
                                只改这一段，前后段逐字保留
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              <div
                className="max-h-80 overflow-y-auto pr-2 text-left text-[13px] leading-relaxed text-slate-600 space-y-3"
                dangerouslySetInnerHTML={{ __html: preview.html }}
              />
              {preview.warnings.map((w, i) => (
                <p key={i} className="flex items-start gap-2 text-[10px] font-bold text-amber-600 text-left">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {w}
                </p>
              ))}
              {preview.truncated && (
                <p className="flex items-start gap-2 text-[10px] font-bold text-indigo-500 text-left">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  这一版写到模型的输出上限就断了 —— 点下面的「接着写下去」会自动一轮轮补完，不用自己反复点。
                </p>
              )}
              {/* ---- P3 第二遍：AI 自评（只读不改稿） ---- */}
              <div className="pt-4 border-t border-slate-200/80 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={handleReview}
                    disabled={busy !== 'idle'}
                    title="让 AI 当审稿人：6 个维度打分，并列出该改的地方（只读，不动稿子）"
                    className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-white border border-slate-200 text-[10px] font-black uppercase tracking-widest text-slate-600 hover:border-indigo-200 hover:text-indigo-600 disabled:opacity-50 transition-all"
                  >
                    {busy === 'review' ? <Loader2 size={13} className="animate-spin" /> : <ClipboardCheck size={13} />}
                    {busy === 'review' ? '正在自评…' : review ? '重新自评' : 'AI 自评'}
                  </button>
                  {review && (
                    <span className={`px-3 py-1.5 rounded-full border text-[11px] font-black ${scoreTone(review.total)}`}>
                      均分 {review.total}
                    </span>
                  )}
                </div>

                {review && (
                  <div className="space-y-3 p-4 rounded-3xl bg-white border border-slate-100">
                    <p className="text-[11px] font-bold text-slate-500 leading-relaxed text-left">{review.verdict}</p>
                    <p className="text-[9px] font-bold text-slate-300 text-left">
                      {reviewSkill ? `按写法 ${reviewSkill.code}（${reviewSkill.name}）的标准评的` : '未选写法，按通用标准评的'}
                      {review.model ? ` · ${review.model}` : ''}
                    </p>

                    <div className="grid grid-cols-2 gap-2">
                      {review.scores.map((s) => (
                        <div key={s.key} className={`rounded-2xl border px-3 py-2 text-left ${scoreTone(s.score)}`}>
                          <div className="flex items-baseline justify-between">
                            <span className="text-[10px] font-black">{s.label}</span>
                            <span className="text-[11px] font-black">{s.score}</span>
                          </div>
                          <div className="h-1 mt-1.5 rounded-full bg-white/70 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-current"
                              style={{ width: `${Math.min(100, Math.max(0, s.score * 10))}%` }}
                            />
                          </div>
                          {s.comment && <p className="mt-1 text-[9px] font-bold opacity-70 leading-snug">{s.comment}</p>}
                        </div>
                      ))}
                    </div>

                    {reviewWarnings.map((w, i) => (
                      <p key={i} className="flex items-start gap-2 text-[10px] font-bold text-amber-600 text-left">
                        <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {w}
                      </p>
                    ))}

                    {review.issues.length === 0 ? (
                      <p className="text-[10px] font-bold text-emerald-600 text-left">
                        这一版没挑出问题 —— 可以直接插入编辑器了。你还有想法的话，写在下面的框里，AI 会照着改。
                      </p>
                    ) : (
                      <>
                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 text-left block">
                          待改 {review.issues.length} 条（默认只勾必改和低分维度）
                        </label>
                        {review.issues.map((it) => (
                          <label
                            key={it.id}
                            className={`flex gap-3 p-3 rounded-2xl border cursor-pointer transition-colors ${
                              picked.includes(it.id) ? 'bg-indigo-50/60 border-indigo-100' : 'bg-slate-50 border-slate-100'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={picked.includes(it.id)}
                              onChange={() => togglePicked(it.id)}
                              className="mt-0.5 w-3.5 h-3.5 accent-indigo-600 shrink-0"
                            />
                            <span className="flex-1 space-y-1 text-left">
                              <span className="flex items-center gap-2">
                                <span className={`px-2 py-0.5 rounded-full text-[9px] font-black ${severityTone(it.severity)}`}>
                                  {SEVERITY_LABEL[it.severity]}
                                </span>
                                <span className="text-[9px] font-black uppercase tracking-wider text-slate-400">
                                  {REVIEW_DIMENSIONS.find((d) => d.key === it.dimension)?.label || it.dimension}
                                </span>
                              </span>
                              {it.evidence && (
                                <em className="block text-[11px] italic text-slate-400 leading-relaxed">「{it.evidence}」</em>
                              )}
                              {it.problem && (
                                <span className="block text-[11px] font-bold text-slate-700 leading-relaxed">{it.problem}</span>
                              )}
                              {it.fix && (
                                <span className="block text-[10px] font-bold text-indigo-600 leading-relaxed">改法：{it.fix}</span>
                              )}
                            </span>
                          </label>
                        ))}
                      </>
                    )}
                  </div>
                )}

                {/* ---- 你的评价与想法：和 AI 的报告合起来，才叫「我和 AI 一起评的」 ---- */}
                <div className="pt-3 border-t border-slate-200/80 space-y-2.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 text-left block">
                    你的评价与想法
                    <span className="ml-2 font-bold tracking-normal normal-case text-slate-300">
                      可留空 —— 写了就按你说的改
                    </span>
                  </label>
                  {/* 上限跟 /api/ai/story/{rewrite,review} 里的 slice(0, 800) 对齐 */}
                  <textarea
                    value={reviewNotes}
                    onChange={(e) => setReviewNotes(e.target.value)}
                    rows={3}
                    maxLength={800}
                    placeholder="例如：结尾收得太满，想停在一个画面上；第三段那个比喻太老套；主角的口吻再冷一点。"
                    className="w-full p-5 bg-white rounded-3xl border border-slate-200 outline-none text-[13px] font-medium leading-relaxed resize-none focus:border-indigo-200 transition-all"
                  />
                  <p className="text-[9px] font-bold text-slate-300 leading-relaxed text-left">
                    {reviewNotes.trim()
                      ? `已写 ${reviewNotes.trim().length} 字：会和 AI 的清单一起交给改稿那一遍，你点的位置优先改。`
                      : '写在这里的话会和 AI 的清单一起交给改稿那一遍；只有你的意见、不跑自评也能改。'}
                    {review ? ' 点「重新自评」，AI 还会在报告里正面回你的判断。' : ''}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleRewrite}
                  disabled={busy !== 'idle' || (!picked.length && !reviewNotes.trim())}
                  title="只改勾选的条目和你写的意见，其余逐字保留；你要它改情节 / 开篇 / 结局时，它会真的改结构"
                  className="w-full h-12 rounded-2xl bg-indigo-600 text-white text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                >
                  {busy === 'rewrite' ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                  {busy === 'rewrite' ? '正在重写…' : rewriteLabel}
                </button>
                <p className="text-[9px] font-bold text-slate-300 text-left">
                  重写只改点名的地方，没点到的句子逐字保留；你要求改情节 / 开篇 / 结局时，它会真的改结构（篇幅也会跟着变）。
                  改完要重新「插入编辑器」。
                </p>
              </div>

            </div>
          )}

          {batchResults.length > 0 && (
            <div className="space-y-2 p-5 rounded-3xl bg-indigo-50/60 border border-indigo-100">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-black uppercase tracking-widest text-indigo-400 text-left block">
                  批量结果
                </label>
                <span className="text-[9px] font-black text-indigo-400">
                  成功 {batchOkCount} 篇
                  {batchErrorCount ? ` · 中断 ${batchErrorCount} 篇` : ''}
                  {batchSkipped ? ` · 未生成 ${batchSkipped} 篇` : ''}
                </span>
              </div>
              {batchResults.map((item) => (
                <div
                  key={`${item.index}-${item.title || 'error'}`}
                  className="flex items-start gap-3 rounded-2xl bg-white border border-indigo-100/70 px-3.5 py-2.5"
                >
                  <span
                    className={`mt-0.5 w-5 h-5 rounded-lg text-[9px] font-black flex items-center justify-center shrink-0 ${
                      item.error ? 'bg-rose-50 text-rose-500' : 'bg-emerald-50 text-emerald-600'
                    }`}
                  >
                    {item.index}
                  </span>
                  <div className="flex-1 min-w-0 text-left">
                    <p className="text-[11px] font-black text-slate-700 truncate">
                      {item.title || `第 ${item.index} 篇（未写完）`}
                    </p>
                    {item.error ? (
                      <p className="text-[9px] font-bold text-rose-500 leading-relaxed mt-0.5">{item.error}</p>
                    ) : (
                      <p className="text-[9px] font-bold text-slate-400 mt-0.5">
                        已存为草稿
                        {item.warnings.length > 0 && (
                          <span className="ml-2 text-amber-600" title={item.warnings.join('\n')}>
                            {item.warnings.length} 条提醒
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                  {!item.error && item.draftId && (
                    <Link
                      href={`/admin/trends/edit?id=${encodeURIComponent(item.draftId)}`}
                      onClick={onClose}
                      className="shrink-0 text-[9px] font-black text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1.5 rounded-lg transition-all"
                    >
                      打开
                    </Link>
                  )}
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="p-5 rounded-3xl bg-rose-50 border border-rose-100 text-[11px] font-bold text-rose-600 leading-relaxed text-left">
              {error}
            </div>
          )}
        </div>

        {/* 底部动作条 */}
        <footer className="border-t border-slate-100 px-8 py-6 space-y-3 shrink-0 bg-white">
          {(chosenSummary || activeSkill || materialFirst) && (
            <p className="text-[10px] font-bold text-slate-400 text-left">
              {activeSkill && (
                <span className="text-indigo-500 mr-2">
                  写法 {activeSkill.code}（{activeSkill.name}） ·
                </span>
              )}
              {chosenSummary && `已选：${chosenSummary} · `}
              {effectiveLength} 字
              {materialFirst && <span className="text-indigo-500"> · 素材优先</span>}
            </p>
          )}
          {/* 批量：一次写 1–5 篇，直接落库成草稿。手机上藏起来，避免底部动作条挤爆。 */}
          <div className="hidden sm:flex items-center gap-2 pb-1">
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 shrink-0">
              批量创作
            </span>
            <div className="flex items-center gap-1 rounded-2xl bg-slate-50 border border-slate-100 p-1">
              {Array.from({ length: MAX_BATCH_STORIES }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setBatchCount(n)}
                  disabled={busy !== 'idle'}
                  title={n === 1 ? '只写一篇，直接存草稿' : `一次写 ${n} 篇，每篇自动换 Seed 并避开前几篇的人名/地点`}
                  className={`w-8 h-7 rounded-xl text-[10px] font-black transition-all ${
                    batchCount === n
                      ? 'bg-indigo-600 text-white shadow'
                      : 'text-slate-400 hover:text-slate-700 hover:bg-white'
                  } disabled:opacity-50`}
                >
                  {n}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={handleBatchGenerate}
              disabled={busy !== 'idle'}
              className="flex-1 h-9 rounded-2xl bg-indigo-50 border border-indigo-100 text-indigo-700 font-black text-[10px] uppercase tracking-widest hover:bg-indigo-100 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
            >
              {busy === 'batch' ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> 批量创作中… {elapsed}s
                </>
              ) : (
                <>
                  <Layers size={13} /> {batchCount === 1 ? '生成并存成草稿' : `生成 ${batchCount} 篇草稿`}
                </>
              )}
            </button>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={busy !== 'idle'}
              className="flex-1 h-14 rounded-2xl bg-slate-900 text-white font-black text-[11px] uppercase tracking-widest shadow-xl flex items-center justify-center gap-3 hover:scale-[1.02] disabled:opacity-60 transition-all"
            >
              {busy === 'generate' ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {progress?.phase === 'write'
                    ? `正在写第 ${progress.current}/${progress.total} 段…`
                    : progress?.phase === 'finalize'
                      ? '正在收尾…'
                      : '正在规划骨架…'}{' '}
                  {elapsed}s
                </>
              ) : (
                <>
                  <Sparkles size={16} /> 生成中文短篇
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={!preview || busy !== 'idle'}
              className="h-14 px-6 rounded-2xl border border-slate-200 text-slate-600 font-black text-[10px] uppercase tracking-widest flex items-center justify-center gap-2 hover:border-slate-900 hover:text-slate-900 disabled:opacity-40 transition-all"
            >
              <PenLine size={15} /> {applied ? '再插一次' : '插入编辑器'}
            </button>
          </div>
          {!preview?.skeleton && (
            <button
              type="button"
              onClick={handleContinue}
              disabled={busy !== 'idle'}
              className="w-full h-11 rounded-2xl border border-dashed border-slate-200 text-slate-400 font-black text-[10px] uppercase tracking-widest hover:border-slate-400 hover:text-slate-600 disabled:opacity-40 transition-all flex items-center justify-center gap-2"
            >
              {busy === 'continue' ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  自动续写中… 第 {continueRound || 1}/{MAX_AUTO_CONTINUE_ROUNDS} 轮 · 已补 {continueGain} 字 · {elapsed}s
                </>
              ) : (
                <>接着写下去（写不够会自动一轮轮补到目标字数）</>
              )}
            </button>
          )}
        </footer>
      </aside>
    </>
  )
}

