'use client'

/**
 * 文本模式的一张卡片。
 *
 * 和 JSON 卡片（PackCard）刻意做成同一个骨架：徽章在左上、动作在右上、红框在下面 ——
 * 换模式不该换肌肉记忆。差别只在三处：
 *   1. 徽章说的是「4 结果 / 8 题 / 健康 100」，不是「可导入」；
 *   2. 报错带**行号**（文本是给人改的，JSON 是给机器读的）；
 *   3. 下面多一块 `QuizTextPreview`，把结果页的四个角摆出来。
 */

import { useRef, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Eraser,
  Eye,
  FileText,
  Loader2,
  Sparkles,
  Trash2,
  Undo2,
  Wand2,
} from 'lucide-react'
import {
  QUIZ_TEXT_TEMPLATE,
  kitToText,
  summarizeQuizText,
  type QuizTextEntry,
  type QuizTextInspection,
  type QuizTextStats,
} from '@/lib/quizText'
import QuizTextPreview from './QuizTextPreview'

/**
 * 「AI 整理」的结果，**不是**「新文本」。
 *
 * 分成 ok / 失败两支的理由：失败那一支要带着一句人话（`message`）回到卡片里，
 * 让作者在**原稿旁边**看到「模型这次没写完，原稿没动」—— 而不是靠一个角落里的
 * toast 闪过就没了。成功那一支也不直接写回，先变成「待采用」，由卡片摆出
 * `结果 2 → 4 · 题 0 → 8` 让作者点头。
 */
export type QuizTidyResult =
  | { ok: true; text: string; after: QuizTextStats; partial: boolean }
  | { ok: false; message: string; retryable: boolean }

type Props = {
  index: number
  text: string
  inspection: QuizTextInspection
  canRemove: boolean
  onChange: (text: string) => void
  onRemove: () => void
  /** AI 整理：返回**待采用**的一版（含 before/after 数字），不直接写回 */
  onTidy: (text: string) => Promise<QuizTidyResult>
}

/** `2 → 4`；一样就只留一个数，省得满屏都是箭头。 */
const pair = (before: number, after: number) => (before === after ? String(before) : `${before} → ${after}`)

const deltaLabel = (before: QuizTextStats, after: QuizTextStats): string =>
  `结果 ${pair(before.results, after.results)} · 题 ${pair(before.questions, after.questions)} · 要修 ${pair(before.blockers, after.blockers)}`

const actionClass =
  'text-[9px] font-black tracking-widest px-2.5 py-1.5 rounded-lg text-slate-500 hover:bg-slate-100 flex items-center gap-1 transition-all disabled:opacity-30 disabled:hover:bg-transparent'

function badgeOf(text: string, inspection: QuizTextInspection): { label: string; className: string } {
  const entries = inspection.entries
  if (!text.trim() || !entries.length) {
    return { label: '等待粘贴', className: 'bg-slate-100 text-slate-400 border-slate-200' }
  }
  const blockers = entries.flatMap((entry) => entry.issues.filter((item) => item.level === 'blocker'))
  if (blockers.length) {
    return { label: `${blockers.length} 项要修`, className: 'bg-rose-50 text-rose-600 border-rose-200' }
  }
  const warnings = entries.flatMap((entry) => entry.issues.filter((item) => item.level === 'warning'))
  if (warnings.length) {
    return { label: `可导入 · ${warnings.length} 条提醒`, className: 'bg-amber-50 text-amber-600 border-amber-200' }
  }
  const entry = entries[0]
  const questions = entry.kit?.questions.length ?? 0
  const results = entry.kit?.archetypes.length ?? 0
  const health = entry.compiled?.audit ? ` · 健康 ${entry.compiled.audit.health}` : ''
  return {
    label: `${entries.length > 1 ? `${entries.length} 篇 · ` : ''}${results} 结果 · ${questions} 题${health}`,
    className: 'bg-emerald-50 text-emerald-600 border-emerald-200',
  }
}

export default function QuizTextCard({
  index,
  text,
  inspection,
  canRemove,
  onChange,
  onRemove,
  onTidy,
}: Props) {
  const [undo, setUndo] = useState<string | null>(null)
  const [tidying, setTidying] = useState(false)
  /** 整理好但**还没采用**的一版：只用来对比，不进 textarea */
  const [pending, setPending] = useState<{ text: string; after: QuizTextStats; partial: boolean } | null>(null)
  const [comparing, setComparing] = useState(false)
  const [tidyError, setTidyError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const badge = badgeOf(text, inspection)
  const entries = inspection.entries
  const single = entries.length === 1 ? entries[0] : null
  /** 「现在这一版」的数字，用来和模型那一版做 2 → 4 的对比 */
  const current = summarizeQuizText(inspection)

  const all = entries.flatMap((entry) => entry.issues.map((issue) => ({ entry, issue })))
  const shown = [
    ...all.filter((item) => item.issue.level === 'blocker'),
    ...all.filter((item) => item.issue.level === 'warning'),
  ].slice(0, 8)

  /**
   * 任何**手动**改动都要作废「待采用」的那一版：它是对旧文本的改写，
   * 留着就能用一份已经对不上的稿子覆盖新内容。
   */
  const edit = (next: string) => {
    setPending(null)
    setComparing(false)
    setTidyError(null)
    onChange(next)
  }

  const applyPending = () => {
    if (!pending) return
    setUndo(text)
    setComparing(false)
    onChange(pending.text)
    setPending(null)
  }

  /** 点「第 N 行」跳到那一行：光标落在行首、整行选中、滚到视野中间。 */
  const jumpToLine = (line: number) => {
    const node = textareaRef.current
    if (!node) return
    const lines = text.split('\n')
    const target = Math.min(Math.max(line, 1), Math.max(lines.length, 1))
    let start = 0
    for (let i = 0; i < target - 1; i += 1) start += (lines[i] ?? '').length + 1
    node.focus()
    node.setSelectionRange(start, start + (lines[target - 1] ?? '').length)
    // 行高读 computed style：写死 17.9px 的话，改一次字号就整屏偏一行。
    const lineHeight = Number.parseFloat(window.getComputedStyle(node).lineHeight) || 18
    node.scrollTop = Math.max(0, (target - 1) * lineHeight - node.clientHeight / 2)
  }

  const insertTemplate = () => {
    if (text.trim() && !window.confirm('这个框里已经有内容，替换成模板？')) return
    setUndo(text)
    edit(QUIZ_TEXT_TEMPLATE)
  }

  const normalize = () => {
    if (!single?.kit) return
    setUndo(text)
    edit(kitToText(single.kit))
  }

  /**
   * 整理**只产出「待采用」**，一个字都不写回。
   *
   * 改之前是 `const next = await onTidy(text); if (next) onChange(next)`：
   * 模型返回半截稿也会直接覆盖框里的原文，作者按下按钮的那一刻八道题就只剩四道，
   * 而撤销栈里只有一份全量快照 —— 再点一次「AI 整理」，原文就真的没了。
   */
  const tidy = async () => {
    if (!text.trim() || tidying) return
    setTidying(true)
    setTidyError(null)
    try {
      const result = await onTidy(text)
      // 用 `in` 收窄，不用 `result.ok` 判断：这个仓库 strict 是关的，
      // 布尔字面量判别在这里不收窄，`result.message` 会被判成不存在。
      if ('message' in result) {
        setTidyError(result.message)
      } else {
        setPending({ text: result.text, after: result.after, partial: result.partial })
        setComparing(false)
      }
    } finally {
      setTidying(false)
    }
  }

  return (
    <div className="bg-white rounded-[28px] border border-slate-200 overflow-hidden shadow-sm">
      <div className="px-5 py-3 flex items-center justify-between gap-3 border-b border-slate-100">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-6 h-6 rounded-lg bg-slate-900 text-white text-[10px] font-black flex items-center justify-center shrink-0">
            {index + 1}
          </span>
          <span className={`text-[9px] font-black tracking-widest px-3 py-1 rounded-full border truncate ${badge.className}`}>
            {badge.label}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button type="button" onClick={insertTemplate} className={actionClass} title="插入一份能直接用的模板">
            <FileText size={12} /> 模板
          </button>
          <button
            type="button"
            onClick={tidy}
            disabled={!text.trim() || tidying}
            className={actionClass}
            title="让 AI 按模板补齐 / 改成英文，结果写回这个框（可撤销）"
          >
            {tidying ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} AI 整理
          </button>
          <button
            type="button"
            onClick={normalize}
            disabled={!single?.kit}
            className={actionClass}
            title="按解析结果重排一遍（去掉多余空格、补上 id= 之类的隐式字段）"
          >
            <Wand2 size={12} /> 规范化
          </button>
          <button
            type="button"
            onClick={() => {
              setUndo(text)
              edit('')
            }}
            disabled={!text.trim()}
            className={actionClass}
          >
            <Eraser size={12} /> 清空
          </button>
          <button type="button" onClick={onRemove} disabled={!canRemove} className={`${actionClass} hover:bg-rose-50 hover:text-rose-500`}>
            <Trash2 size={12} /> 删除
          </button>
        </div>
      </div>

      <textarea
        ref={textareaRef}
        value={text}
        onChange={(event) => edit(event.target.value)}
        spellCheck={false}
        placeholder={
          '把 AI 给的稿子粘到这里（一个框一篇；也可以用底部的「整段粘贴拆分」一次拆多篇）\n\nTITLE: 你的测验标题\nHOOK: 一句让人想点的话\nTOPIC: pop-culture\n\n== RESULT 1 | TL | pose=wave ==\nNAME: The Quiet Watcher\n…\n\n== Q1 | 场景 ==\n题干\nA. 选项  (i1)\nD. 选项  (i3) (b)\n\n点右上角「模板」要一份完整的。'
        }
        className="w-full h-72 px-5 py-4 font-mono text-[11px] leading-relaxed outline-none resize-y bg-white placeholder:text-slate-300"
      />

      {tidyError && (
        <div className="px-5 py-3 bg-rose-50/70 border-t border-rose-100 flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5 shrink-0 text-rose-500" />
          <p className="text-[10px] font-bold text-rose-600 leading-relaxed flex-1">
            {tidyError}
            <span className="text-rose-400"> 框里的稿子一个字都没动。</span>
          </p>
          <button type="button" onClick={tidy} disabled={tidying} className={actionClass}>
            <Sparkles size={12} /> 再试一次
          </button>
        </div>
      )}

      {pending && (
        <div className="px-5 py-3 bg-sky-50/70 border-t border-sky-100 space-y-2">
          <div className="flex items-start gap-2">
            <Sparkles size={12} className="mt-0.5 shrink-0 text-sky-500" />
            <p className="text-[10px] font-bold text-sky-700 leading-relaxed flex-1">
              AI 整理好了这一版：{deltaLabel(current, pending.after)}
              {pending.partial && <span className="text-amber-600"> · 只整理了一部分，篇数比原来少</span>}
              。还没写进框里 —— 先看，再决定。
            </p>
          </div>

          {comparing && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div>
                <p className="pb-1 text-[9px] font-black tracking-widest text-slate-400">现在这一版</p>
                <pre className="h-56 overflow-auto rounded-xl border border-slate-200 bg-white p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
                  {text || '（空）'}
                </pre>
              </div>
              <div>
                <p className="pb-1 text-[9px] font-black tracking-widest text-sky-500">AI 的版本</p>
                <pre className="h-56 overflow-auto rounded-xl border border-sky-200 bg-white p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
                  {pending.text}
                </pre>
              </div>
            </div>
          )}

          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setComparing((value) => !value)} className={actionClass}>
              <Eye size={12} /> {comparing ? '收起对比' : '左右对照'}
            </button>
            <button
              type="button"
              onClick={applyPending}
              className="text-[9px] font-black tracking-widest px-2.5 py-1.5 rounded-lg bg-sky-600 text-white hover:bg-sky-700 flex items-center gap-1 transition-all"
            >
              <Check size={12} /> 采用这一版
            </button>
            <button
              type="button"
              onClick={() => {
                setPending(null)
                setComparing(false)
              }}
              className={actionClass}
            >
              放弃
            </button>
          </div>
        </div>
      )}

      {(shown.length > 0 || undo !== null) && (
        <div className="px-5 py-3 bg-rose-50/40 border-t border-rose-100 space-y-2">
          {shown.map(({ entry, issue: item }, position) => (
            <div key={`${entry.from}-${item.code}-${position}`} className="flex items-start gap-2">
              {item.level === 'blocker' ? (
                <AlertCircle size={12} className="mt-0.5 shrink-0 text-rose-500" />
              ) : (
                <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-500" />
              )}
              <p
                className={`leading-relaxed font-bold text-[10px] ${
                  item.level === 'blocker' ? 'text-rose-600' : 'text-amber-600'
                }`}
              >
                {entries.length > 1 ? `第 ${entries.indexOf(entry) + 1} 篇 · ` : ''}
                {item.line ? (
                  <button
                    type="button"
                    onClick={() => jumpToLine(item.line as number)}
                    className="font-mono text-[9px] text-slate-400 underline decoration-dotted hover:text-slate-600"
                    title="跳到这一行"
                  >
                    第 {item.line} 行
                  </button>
                ) : null}{' '}
                {item.label}
                {item.detail && <span className="text-slate-400"> —— {item.detail}</span>}
              </p>
            </div>
          ))}
          {undo !== null && (
            <button
              type="button"
              onClick={() => {
                if (undo === null) return
                edit(undo)
                setUndo(null)
              }}
              className={actionClass}
            >
              <Undo2 size={12} /> 撤销这一次改写
            </button>
          )}
        </div>
      )}

      {entries.map((entry, position) => (
        <div key={`${entry.from}-${position}`}>
          {entries.length > 1 && (
            <p className="px-5 pt-3 text-[9px] font-black tracking-widest text-slate-400">
              第 {position + 1} 篇 · {entry.title || '（无标题）'}
            </p>
          )}
          <QuizTextPreview entry={entry} />
        </div>
      ))}
    </div>
  )
}