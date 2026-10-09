'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  X, Loader2, Sparkles, Dices, Save, Trash2, AlertTriangle, CheckCircle2, PenLine, RotateCcw,
  ClipboardCheck, Wand2,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
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

export type GeneratedStory = {
  title: string
  excerpt: string
  html: string
  chars: number
  warnings: string[]
  /** 服务端回执：这一版是哪套写法写的（留个痕，方便对比几版稿子） */
  skill?: { code: string; name: string } | null
}

type Preset = { id: string; name: string; combo: StoryCombo; updated_at?: string }

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
  showToast: (msg: string, type: 'success' | 'error') => void
}

const EMPTY_COMBO: StoryCombo = { length: 1500 }

/**
 * 服务端「这次没成」的状态码 —— 不是「你不该这么做」，所以值得自动重发一次。
 * 501/500/424 之类是代码或数据的问题，重发多少次结果都一样，别浪费站长时间。
 */
const TRANSIENT_STATUS = new Set([502, 503])
/** 重发前的等待：给对面一点喘息，也避免拿同一个坏连接再撞一次 */
const TRANSIENT_RETRY_WAIT_MS = 800

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
  const [materials, setMaterials] = useState('')
  const [preview, setPreview] = useState<GeneratedStory | null>(null)
  const [applied, setApplied] = useState(false)
  const [busy, setBusy] = useState<'idle' | 'generate' | 'continue' | 'review' | 'rewrite'>('idle')
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

  const selection = combo || EMPTY_COMBO
  const length = Number(selection.length) || 1500
  const skillCode = selection.skill || ''
  const activeSkill = skills.find((s) => s.code === skillCode) || null

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
    }
    load()
    return () => {
      alive = false
    }
  }, [open])

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

  const resetAll = () => {
    onComboChange({ length })
    setPreview(null)
    setApplied(false)
    setError('')
  }

  /**
   * 取一张尽量新鲜的 access_token；拿不到就返回空串。
   *
   * 为什么不直接 getSession().session.access_token：
   *   ① 生成 / 续写一次要跑 30–60 秒，出门时还有效的票，跑到后台可能已经过期了
   *      —— 留 60 秒余量，快过期就先换一张。
   *   ② token 刷新失败（网络抖动）时 getSession() 仍会返回那张旧票，发出去必然被后台判 401。
   */
  const getFreshToken = async (forceRefresh: boolean): Promise<string> => {
    const { data } = await supabase.auth.getSession()
    const session = data?.session
    if (session && !forceRefresh) {
      const expiresAt = session.expires_at ? session.expires_at * 1000 : Number.POSITIVE_INFINITY
      if (expiresAt - Date.now() > 60_000) return session.access_token
    }
    if (forceRefresh || session) {
      const { data: refreshed } = await supabase.auth.refreshSession()
      if (refreshed?.session?.access_token) return refreshed.session.access_token
    }
    return session?.access_token || ''
  }

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

  const handleGenerate = async () => {
    const picked = DIMENSIONS.filter((d) => (selection[d.key] || []).length).length
    if (!picked && !idea.trim()) {
      showToast('至少选一个标签，或者写一句构思', 'error')
      return
    }
    setBusy('generate')
    setError('')
    setPreview(null)
    setApplied(false)
    setReview(null)
    setReviewSkill(null)
    setPicked([])
    setReviewNotes('')
    try {
      const data = await apiPost('/api/ai/story', { combo: selection, idea, materials, length, skill: skillCode })
      const story: GeneratedStory = {
        title: String(data?.title || ''),
        excerpt: String(data?.excerpt || ''),
        // 服务端已经洗过一遍，这里再洗一遍 —— 预览要用 dangerouslySetInnerHTML，宁可多洗一次
        html: toStoryHtml(String(data?.html || '')),
        chars: Number(data?.chars || 0),
        warnings: Array.isArray(data?.warnings) ? data.warnings.map(String) : [],
        skill: data?.skill ?? null,
      }
      setPreview(story)
      onComboChange({ ...selection, idea, materials, length, skill: skillCode })
      showToast(`写好了：${story.chars} 字`, 'success')
    } catch (e: any) {
      setError(e?.message || '生成失败')
    } finally {
      setBusy('idle')
    }
  }

  const handleContinue = async () => {
    const current = getCurrentZhText()
    if (current.length < 50) {
      showToast('正文里还没有中文内容，先插入或手写一段', 'error')
      return
    }
    setBusy('continue')
    setError('')
    try {
      const data = await apiPost('/api/ai/story', {
        combo: selection,
        idea,
        materials,
        length,
        skill: skillCode,
        continueFrom: current,
      })
      onAppend(toStoryHtml(String(data?.html || '')))
      onComboChange({ ...selection, idea, materials, length, skill: skillCode })
      showToast(`已续写 ${data?.chars || ''} 字`, 'success')
    } catch (e: any) {
      setError(e?.message || '续写失败')
    } finally {
      setBusy('idle')
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
        length,
        notes: reviewNotes.trim(),
        skill: skillCode,
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
    try {
      const data = await apiPost('/api/ai/story/rewrite', {
        title: preview.title,
        excerpt: preview.excerpt,
        html: preview.html,
        issues,
        notes,
        skill: skillCode,
      })
      setPreview({
        title: String(data?.title || preview.title),
        excerpt: String(data?.excerpt || ''),
        html: toStoryHtml(String(data?.html || '')),
        chars: Number(data?.chars || 0),
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
      showToast(`已按${basis}重写：${data?.before ?? '?'} → ${data?.after ?? '?'} 字`, 'success')
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
    onComboChange({ ...selection, idea, materials, length, skill: skillCode })
    onApply(preview)
    setApplied(true)
  }

  const applyPreset = (p: Preset) => {
    const next: StoryCombo = { ...(p.combo || {}), length: Number(p.combo?.length) || 1500 }
    onComboChange({ ...selection, ...next })
    setIdea(String(p.combo?.idea || ''))
    setMaterials(String(p.combo?.materials || ''))
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
        .insert([{ name, combo: { ...selection, idea, materials, length } }])
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

  const tipWidth = 240

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
              title="随机抽一整套设定"
              className="w-10 h-10 flex items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600 hover:bg-indigo-100 transition-all"
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
          {/* 写法（story_skills）—— 换的是叙述姿态而不是题材，是治 AI 味最有效的一栏 */}
          {skills.length > 0 && (
            <div className="space-y-2.5 pb-7 border-b border-slate-100">
              <div className="flex items-center justify-between px-1">
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 text-left">
                  <span className="text-slate-300 mr-1.5">笔法</span>
                  写法
                  <span className="ml-2 font-bold tracking-normal normal-case text-slate-300">
                    不选 = 用后台的默认写法
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

          {/* 参考素材 */}
          <div className="space-y-2.5">
            <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 text-left block">
              参考素材
              <span className="ml-2 font-bold tracking-normal normal-case text-slate-300">可留空</span>
            </label>
            <textarea
              value={materials}
              onChange={(e) => setMaterials(e.target.value)}
              rows={3}
              placeholder="从新闻或真实经历里抄一点细节进来（职业、地点、一句对话），故事会立刻真实很多。"
              className="w-full p-5 bg-slate-50 rounded-3xl border border-slate-100 outline-none text-[13px] font-medium leading-relaxed resize-none focus:border-indigo-200 focus:bg-white transition-all"
            />
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
                  className={`py-3 rounded-2xl text-[10px] font-black border transition-all ${
                    length === p.value
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-400 border-slate-100 hover:border-slate-300'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="text-[9px] text-slate-300 leading-relaxed text-left px-1">
              1500 字大约要 20–40 秒。模型偶尔会偷工写短，用底部「接着写下去」补足就行。
            </p>
          </div>

          {/* 常用配方 —— 存下来，下次一键套用 */}
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
              <div
                className="max-h-80 overflow-y-auto pr-2 text-left text-[13px] leading-relaxed text-slate-600 space-y-3"
                dangerouslySetInnerHTML={{ __html: preview.html }}
              />
              {preview.warnings.map((w, i) => (
                <p key={i} className="flex items-start gap-2 text-[10px] font-bold text-amber-600 text-left">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {w}
                </p>
              ))}
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
                  title="只改勾选的条目和你写的意见，其余逐字保留"
                  className="w-full h-12 rounded-2xl bg-indigo-600 text-white text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                >
                  {busy === 'rewrite' ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                  {busy === 'rewrite' ? '正在重写…' : rewriteLabel}
                </button>
                <p className="text-[9px] font-bold text-slate-300 text-left">
                  重写只改点名的地方，没点到的句子逐字保留；改完要重新「插入编辑器」。
                </p>
              </div>

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
          {(chosenSummary || activeSkill) && (
            <p className="text-[10px] font-bold text-slate-400 text-left">
              {activeSkill && (
                <span className="text-indigo-500 mr-2">
                  写法 {activeSkill.code}（{activeSkill.name}） ·
                </span>
              )}
              {chosenSummary && `已选：${chosenSummary} · `}
              {length} 字
            </p>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={busy !== 'idle'}
              className="flex-1 h-14 rounded-2xl bg-slate-900 text-white font-black text-[11px] uppercase tracking-widest shadow-xl flex items-center justify-center gap-3 hover:scale-[1.02] disabled:opacity-60 transition-all"
            >
              {busy === 'generate' ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> 正在写… {elapsed}s
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
          <button
            type="button"
            onClick={handleContinue}
            disabled={busy !== 'idle'}
            className="w-full h-11 rounded-2xl border border-dashed border-slate-200 text-slate-400 font-black text-[10px] uppercase tracking-widest hover:border-slate-400 hover:text-slate-600 disabled:opacity-40 transition-all flex items-center justify-center gap-2"
          >
            {busy === 'continue' ? (
              <>
                <Loader2 size={14} className="animate-spin" /> 续写中… {elapsed}s
              </>
            ) : (
              <>接着写下去（补足字数 / 把没收好的尾收掉）</>
            )}
          </button>
        </footer>
      </aside>
    </>
  )
}

