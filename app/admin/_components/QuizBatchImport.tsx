'use client'

/**
 * 测验「批量草稿导入」弹窗。
 *
 * 以前是一个 textarea + JSON.parse + insert，任何错误都只弹一句
 * Invalid JSON Format（连数据库报错也这么说），所以「明明粘贴的是对的」也无从下手。
 *
 * 现在的行为：
 *   · 一个框 = 一篇；一个框里放 [ {...}, {...} ] 也能一次导多篇（「整段粘贴拆分」直接拆成多个框）；
 *   · 每个框实时自检（语法 → 结构 → 分数区间），错在哪一行哪一列、哪个字段都写出来；
 *   · 有任何一个框不过，提交按钮就禁用，不会出现「导入成功但编辑页白屏」；
 *   · 一键修复只处理「围栏 / 中文双引号 / 尾逗号 / 注释 / 全角空格」，并且可以撤销；
 *   · 导入一律落到草稿（status=draft、active=false），排期/发布仍在编辑页走原来那套。
 *
 * 校验逻辑全在 lib/quizPack.ts（纯函数，scripts/p13-quiz-pack-check.mts 里断言）。
 */

import { useMemo, useState } from 'react'
import {
  X, Plus, Trash2, Loader2, AlertCircle, AlertTriangle, Wand2,
  Eraser, FileJson, ClipboardPaste, ChevronDown, ChevronUp, BookOpen, Save, Undo2,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import {
  QUIZ_PACK_CHECKLIST,
  QUIZ_PACK_DOC_PATH,
  QUIZ_PACK_TEMPLATES,
  formatPackText,
  inspectPackText,
  type QuizPackInspection,
} from '@/lib/quizPack'

type Card = { key: string; text: string }

const makeCard = (text = ''): Card => ({ key: Math.random().toString(36).slice(2, 9), text })

/**
 * 缺列就剔掉该列重试 —— 和编辑页 handlePublish 同一套策略，
 * 阶段 0 的 SQL 没跑全时 status / tags 这些列可能还不存在。
 */
async function insertDraftRows(rows: any[]): Promise<{ message: string } | null> {
  let current = rows
  for (let i = 0; i < 5; i++) {
    const { error } = await supabase.from('quizzes').insert(current)
    if (!error) return null

    const msg = String(error.message || '')
    const m1 = msg.match(/Could not find the '([^']+)' column/i)
    const m2 = msg.match(/column\s+quizzes\.([a-zA-Z0-9_]+)\s+does\s+not\s+exist/i)
    const missing = (m1?.[1] || m2?.[1] || '').trim()
    if (!missing || !current.some((row) => Object.prototype.hasOwnProperty.call(row, missing))) {
      return { message: msg || 'insert failed' }
    }
    current = current.map((row) => {
      const next = { ...row }
      delete next[missing]
      return next
    })
  }
  return { message: 'insert failed' }
}

const summaryText = (inspection: QuizPackInspection): string => {
  const entries = inspection.entries
  if (entries.length > 1) return `${entries.length} 篇可导入`
  const summary = entries[0]?.summary
  if (!summary) return '可导入'
  const score = summary.minScore !== null && summary.maxScore !== null ? ` · ${summary.minScore}–${summary.maxScore} 分` : ''
  return `${summary.questionCount} 题 / ${summary.resultCount} 结果${score}`
}

function badgeOf(text: string, inspection: QuizPackInspection): { label: string; className: string } {
  if (!text.trim()) {
    return { label: '等待粘贴', className: 'bg-slate-100 text-slate-400 border-slate-200' }
  }
  if (!inspection.ok) {
    return { label: inspection.error?.line ? `JSON 语法错误 · 第 ${inspection.error.line} 行` : 'JSON 语法错误', className: 'bg-rose-50 text-rose-600 border-rose-200' }
  }
  const blockers = inspection.entries.flatMap((e) => e.issues.filter((i) => i.level === 'blocker'))
  if (blockers.length) {
    return { label: `${blockers.length} 项要修`, className: 'bg-rose-50 text-rose-600 border-rose-200' }
  }
  const warns = inspection.entries.flatMap((e) => e.issues.filter((i) => i.level === 'warning'))
  if (warns.length) {
    return { label: `可导入 · ${warns.length} 条提醒`, className: 'bg-amber-50 text-amber-600 border-amber-200' }
  }
  return { label: summaryText(inspection), className: 'bg-emerald-50 text-emerald-600 border-emerald-200' }
}

function PackCard({
  index,
  card,
  inspection,
  canRemove,
  onChange,
  onRemove,
  onError,
}: {
  index: number
  card: Card
  inspection: QuizPackInspection
  canRemove: boolean
  onChange: (text: string) => void
  onRemove: () => void
  onError: (message: string) => void
}) {
  const [undo, setUndo] = useState<string | null>(null)
  const badge = badgeOf(card.text, inspection)
  const multi = inspection.entries.length > 1

  const all = inspection.entries.flatMap((entry) => entry.issues.map((issue) => ({ entryIndex: entry.index, issue })))
  const shown = [
    ...all.filter((x) => x.issue.level === 'blocker'),
    ...all.filter((x) => x.issue.level === 'warning'),
  ].slice(0, 6)

  const applyFix = () => {
    setUndo(card.text)
    onChange(inspection.fixedText)
  }

  const insertTemplate = () => {
    if (card.text.trim() && !window.confirm('这个框里已经有内容，替换成模板？')) return
    setUndo(card.text)
    onChange(QUIZ_PACK_TEMPLATES.score)
  }

  const format = () => {
    const result = formatPackText(card.text)
    if (!result.ok) {
      onError(result.error.message)
      return
    }
    setUndo(card.text)
    onChange(result.text)
  }

  const actionClass =
    'text-[9px] font-black uppercase tracking-widest px-2.5 py-1.5 rounded-lg text-slate-500 hover:bg-slate-100 flex items-center gap-1 transition-all'

  return (
    <div className="bg-white rounded-[28px] border border-slate-200 overflow-hidden shadow-sm">
      <div className="px-5 py-3 flex items-center justify-between gap-3 border-b border-slate-100">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-6 h-6 rounded-lg bg-slate-900 text-white text-[10px] font-black flex items-center justify-center shrink-0">
            {index + 1}
          </span>
          <span className={`text-[9px] font-black uppercase tracking-widest px-3 py-1 rounded-full border truncate ${badge.className}`}>
            {badge.label}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button type="button" onClick={insertTemplate} className={actionClass} title="插入一份能直接用的模板">
            <FileJson size={12} /> 模板
          </button>
          <button type="button" onClick={format} disabled={!card.text.trim()} className={`${actionClass} disabled:opacity-30`}>
            <Wand2 size={12} /> 格式化
          </button>
          <button
            type="button"
            onClick={() => {
              setUndo(card.text)
              onChange('')
            }}
            disabled={!card.text.trim()}
            className={`${actionClass} disabled:opacity-30`}
          >
            <Eraser size={12} /> 清空
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={!canRemove}
            className={`${actionClass} hover:bg-rose-50 hover:text-rose-500 disabled:opacity-30`}
          >
            <Trash2 size={12} /> 删除
          </button>
        </div>
      </div>

      <textarea
        value={card.text}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        placeholder="把 AI 给的 JSON 粘贴到这里（一个框一篇；也可以贴一整个 [ ... ] 数组）"
        className="w-full h-52 bg-slate-900 text-emerald-300 p-5 font-mono text-[11px] outline-none resize-y leading-relaxed placeholder:text-slate-600"
      />

      {(inspection.error || shown.length > 0 || inspection.fixes.length > 0) && (
        <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 space-y-2">
          {inspection.error && (
            <div className="flex items-start gap-2 text-[11px]">
              <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose-500" />
              <div className="space-y-1">
                <p className="text-rose-600 font-bold leading-relaxed">{inspection.error.message}</p>
                {inspection.error.hints.map((hint) => (
                  <p key={hint} className="text-[10px] text-rose-400 font-medium leading-relaxed">
                    · {hint}
                  </p>
                ))}
              </div>
            </div>
          )}

          {shown.map(({ entryIndex, issue }, i) => (
            <div key={`${entryIndex}-${issue.path}-${i}`} className="flex items-start gap-2 text-[11px]">
              {issue.level === 'blocker' ? (
                <AlertCircle size={13} className="mt-0.5 shrink-0 text-rose-500" />
              ) : (
                <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-500" />
              )}
              <p className={`leading-relaxed font-bold ${issue.level === 'blocker' ? 'text-rose-600' : 'text-amber-600'}`}>
                {multi ? `第 ${entryIndex + 1} 篇 · ` : ''}
                <span className="font-mono text-[10px] text-slate-400 font-medium">{issue.path}</span> {issue.message}
              </p>
            </div>
          ))}

          {inspection.fixes.length > 0 && (
            <div className="flex items-start justify-between gap-3 rounded-xl bg-amber-50 border border-amber-100 px-3 py-2">
              <p className="text-[10px] font-bold text-amber-700 leading-relaxed">
                {inspection.ok ? '已自动容错（可写回干净文本再手改）：' : '可以自动修复：'}
                {inspection.fixes.join('；')}
              </p>
              <div className="flex items-center gap-1 shrink-0">
                {undo !== null && (
                  <button
                    type="button"
                    onClick={() => {
                      onChange(undo)
                      setUndo(null)
                    }}
                    className={actionClass}
                  >
                    <Undo2 size={12} /> 撤销
                  </button>
                )}
                <button type="button" onClick={applyFix} className={actionClass}>
                  <Wand2 size={12} /> 自动修复
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type Props = {
  open: boolean
  onClose: () => void
  /** 导入成功：父级负责 toast + 跳转 */
  onImported: (count: number) => void
  onError: (message: string) => void
}

export default function QuizBatchImport({ open, onClose, onImported, onError }: Props) {
  const [cards, setCards] = useState<Card[]>([makeCard()])
  const [helpOpen, setHelpOpen] = useState(false)
  const [splitOpen, setSplitOpen] = useState(false)
  const [splitText, setSplitText] = useState('')
  const [splitError, setSplitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const inspections = useMemo(() => cards.map((card) => inspectPackText(card.text)), [cards])

  const readyEntries = inspections.flatMap((inspection) =>
    inspection.ok ? inspection.entries.filter((entry) => entry.ok) : []
  )
  const totalEntries = inspections.reduce((sum, inspection) => sum + inspection.entries.length, 0)
  const brokenCards = cards.filter((card, i) => {
    if (!card.text.trim()) return false
    const inspection = inspections[i]
    return !(inspection.ok && inspection.entries.length > 0 && inspection.entries.every((entry) => entry.ok))
  }).length

  const updateCard = (key: string, text: string) =>
    setCards((prev) => prev.map((card) => (card.key === key ? { ...card, text } : card)))

  const removeCard = (key: string) =>
    setCards((prev) => (prev.length <= 1 ? prev : prev.filter((card) => card.key !== key)))

  const handleSplit = () => {
    const inspection = inspectPackText(splitText)
    if (!inspection.ok) {
      setSplitError(inspection.error?.message ?? '解析失败')
      return
    }
    const next = inspection.entries.filter((entry) => entry.ok).map((entry) => makeCard(JSON.stringify(entry.quiz, null, 2)))
    if (!next.length) {
      setSplitError('这段里没有能拆出来的测验（都有必须先修的错）')
      return
    }
    setSplitError(null)
    setCards((prev) => [...prev.filter((card) => card.text.trim()), ...next])
    setSplitText('')
    setSplitOpen(false)
  }

  const handleSubmit = async () => {
    if (!readyEntries.length || brokenCards > 0 || saving) return

    const rows = readyEntries.map((entry) => ({
      title: entry.quiz.title,
      raw_data: entry.quiz,
      active: false,
      status: 'draft',
      categories: entry.quiz.categories,
      tags: entry.quiz.tags,
      cover_url: entry.quiz.cover_url,
    }))

    const titles = rows.map((row) => row.title)
    const duplicates = [...new Set(titles.filter((title, i) => titles.indexOf(title) !== i))]
    if (duplicates.length && !window.confirm(`有 ${duplicates.length} 个重复标题：${duplicates.join('、')}。仍然导入？`)) return

    setSaving(true)
    const failure = await insertDraftRows(rows)
    setSaving(false)

    if (failure) {
      onError(`导入失败：${failure.message}`)
      return
    }
    onImported(rows.length)
    setCards([makeCard()])
    setSplitText('')
    setSplitOpen(false)
  }

  if (!open) return null

  const canSubmit = !saving && readyEntries.length > 0 && brokenCards === 0
  const ghostButton =
    'text-[9px] font-black uppercase tracking-widest px-3 py-2 rounded-xl text-slate-500 hover:bg-slate-100 flex items-center gap-1.5 transition-all'

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
      <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50 shrink-0">
          <div className="flex items-center gap-3">
            <div className="bg-slate-900 text-white p-2 rounded-xl">
              <ClipboardPaste size={16} />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-slate-900">批量草稿导入</h3>
              <p className="text-[10px] font-bold text-slate-400 mt-0.5">一个框一篇 · 导入后一律是草稿，排期 / 发布仍在编辑页</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-900 bg-white p-2 rounded-xl">
            <X size={20} />
          </button>
        </div>

        {helpOpen && (
          <div className="px-6 py-4 bg-blue-50/60 border-b border-blue-100 space-y-2 shrink-0 max-h-60 overflow-y-auto">
            <p className="text-[10px] font-black uppercase tracking-widest text-blue-600">格式要求</p>
            <ul className="space-y-1">
              {QUIZ_PACK_CHECKLIST.map((item) => (
                <li key={item} className="text-[11px] font-bold text-slate-600 leading-relaxed flex gap-2">
                  <span className="text-blue-400">·</span>
                  {item}
                </li>
              ))}
            </ul>
            <p className="text-[10px] font-bold text-slate-400 leading-relaxed">
              完整字段说明在仓库里：<span className="font-mono">{QUIZ_PACK_DOC_PATH}</span> · 想要现成骨架就点框右上角「模板」
            </p>
          </div>
        )}

        {splitOpen && (
          <div className="px-6 py-4 bg-indigo-50/60 border-b border-indigo-100 space-y-2 shrink-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-indigo-500">
              整段粘贴：把一整个 [ ... ] 数组拆成多个框
            </p>
            <textarea
              value={splitText}
              onChange={(e) => {
                setSplitText(e.target.value)
                setSplitError(null)
              }}
              spellCheck={false}
              placeholder="把包含多篇的数组粘到这里，会按篇拆成多个框"
              className="w-full h-32 bg-white border border-indigo-100 rounded-2xl p-4 font-mono text-[11px] outline-none resize-y leading-relaxed"
            />
            {splitError && <p className="text-[10px] font-bold text-rose-500">{splitError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setSplitOpen(false)
                  setSplitError(null)
                }}
                className={ghostButton}
              >
                收起
              </button>
              <button
                type="button"
                onClick={handleSplit}
                disabled={!splitText.trim()}
                className="bg-indigo-600 text-white px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest disabled:opacity-40"
              >
                拆分到多个框
              </button>
            </div>
          </div>
        )}

        <div className="p-6 bg-slate-100 space-y-4 overflow-y-auto flex-1">
          {cards.map((card, i) => (
            <PackCard
              key={card.key}
              index={i}
              card={card}
              inspection={inspections[i]}
              canRemove={cards.length > 1}
              onChange={(text) => updateCard(card.key, text)}
              onRemove={() => removeCard(card.key)}
              onError={onError}
            />
          ))}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 bg-white flex items-center justify-between gap-4 shrink-0 flex-wrap">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setCards([...cards, makeCard()])} className={ghostButton}>
              <Plus size={12} /> 再加一个框
            </button>
            <button type="button" onClick={() => setSplitOpen((v) => !v)} className={ghostButton}>
              <ClipboardPaste size={12} /> 整段粘贴拆分
            </button>
            <button type="button" onClick={() => setHelpOpen((v) => !v)} className={ghostButton}>
              <BookOpen size={12} /> 格式说明 {helpOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-black text-slate-400">
              {brokenCards > 0 ? `${brokenCards} 个框要修 · ` : ''}
              {readyEntries.length}/{totalEntries} 篇就绪
            </span>
            <button type="button" onClick={onClose} className="px-5 py-3 text-[10px] font-black uppercase text-slate-500 rounded-xl">
              取消
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              title={brokenCards > 0 ? '有框没通过校验，先修掉或删掉它' : undefined}
              className="bg-blue-600 text-white px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-xl active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? '写入中…' : `保存到草稿箱 (${readyEntries.length}/${totalEntries})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}


