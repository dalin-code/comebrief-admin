'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, ChevronDown, ChevronUp, Info, Layers,
  Loader2, Merge, Scissors, Trash2, UploadCloud, X,
} from 'lucide-react'
import {
  MAX_TEXT_BYTES,
  decodeTextFile,
  mergeParts,
  splitChapters,
  splitEvenly,
  splitPartAt,
  toChapters,
} from '@/lib/storyImport'
import type { ChapterDraft, SplitPart, SplitResult } from '@/lib/storyImport'

/**
 * 「导入」弹窗：把一整篇稿子切成多章写进**当前这部作品**。
 *
 * 与旧的 JSON 批量弹窗的区别（同一个按钮、两个 tab）：
 *   · 智能分章 = 一篇长文 → 当前作品的 N 章（本组件）
 *   · JSON 批量 = 一份 JSON → 多部独立作品（原逻辑，原样放在第二个 tab，由父级以 jsonSlot 传入）
 *
 * 三个刻意的设计：
 *   1. 切章用 lib/storyImport 的纯函数，UI 只负责「看得见的微调」（改标题 / 合并 / 再拆）；
 *      因此预览区永远可以手改，绝不强行相信正则。
 *   2. 写库在父级（onApply）：父级才知道 editId、postStatus 与「缺列重试」那套逻辑；
 *      这里只负责把 parts 变成 chapter 对象。
 *   3. 导入一律落草稿、已发布作品只更新章节不改状态 —— 见父级 applyImportedChapters。
 */

export type ImportApplyMode = 'replace' | 'append'

type Props = {
  open: boolean
  onClose: () => void
  /** 当前已有章节数，用于「将覆盖 N 章」的提示 */
  existingCount: number
  /** 确认导入：父级写库 + toast；返回 true 表示已落库，弹窗自己关闭 */
  onApply: (chapters: ChapterDraft[], mode: ImportApplyMode) => Promise<boolean>
  /** 旧的「JSON 批量建多部作品」整块，原样塞进第二个 tab */
  jsonSlot?: React.ReactNode
}

const EMPTY: SplitResult = { parts: [], rules: [], warnings: [], notes: [] }

const ghostButton =
  'text-[9px] font-black tracking-widest px-3 py-2 rounded-xl text-slate-500 hover:bg-slate-100 flex items-center gap-1.5 transition-all'

const iconButton = 'p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-all'

const RULE_LABEL: Record<string, string> = {
  markdown: 'Markdown #/##',
  cn: '第X章',
  en: 'Chapter X',
  special: '序章/楔子/番外',
  even: '按长度等分',
  none: '未识别',
}

export default function StoryTextImport({ open, onClose, existingCount, onApply, jsonSlot }: Props) {
  const [tab, setTab] = useState<'split' | 'json'>('split')
  const [raw, setRaw] = useState('')
  /** 文件名 + 实际使用的编码，读进来时提示一次（GBK 转码用户看不见过程，得说一声） */
  const [source, setSource] = useState('')
  const [fileError, setFileError] = useState('')
  const [parts, setParts] = useState<SplitPart[]>([])
  const [info, setInfo] = useState<SplitResult>(EMPTY)
  const [mode, setMode] = useState<ImportApplyMode>('replace')
  const [writing, setWriting] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  /**
   * 粘贴 / 选文件后自动分章，防抖 350ms：
   * 一边打字一边切会把预览区刷成幻灯片，而且用户还没粘完就切是白算。
   */
  useEffect(() => {
    if (!open) return
    if (!raw.trim()) {
      setParts([])
      setInfo(EMPTY)
      return
    }
    const timer = window.setTimeout(() => {
      const result = splitChapters(raw)
      setParts(result.parts)
      setInfo(result)
      setExpanded(null)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [raw, open])

  const totalChars = useMemo(() => parts.reduce((sum, p) => sum + p.chars, 0), [parts])
  const canApply = parts.length > 0 && !writing

  const reset = () => {
    setRaw('')
    setSource('')
    setFileError('')
    setParts([])
    setInfo(EMPTY)
    setExpanded(null)
    setMode('replace')
  }

  const close = () => {
    if (writing) return
    onClose()
  }

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // 清掉 value，否则同一个文件选第二次不会触发 change
    e.target.value = ''
    if (!file) return

    if (file.size > MAX_TEXT_BYTES) {
      setFileError(
        `文件 ${(file.size / 1024 / 1024).toFixed(2)} MB，超过 ${MAX_TEXT_BYTES / 1024 / 1024} MB 上限，请先拆分`
      )
      return
    }

    try {
      const decoded = decodeTextFile(await file.arrayBuffer())
      setFileError('')
      setSource(`${file.name} · ${decoded.encoding === 'gbk' ? 'GBK 已自动转码' : 'UTF-8'}`)
      setRaw(decoded.text)
    } catch (err: any) {
      setFileError(err?.message || '读取文件失败')
    }
  }

  const updateTitle = (index: number, title: string) =>
    setParts((prev) => prev.map((p, i) => (i === index ? { ...p, title } : p)))

  const removeAt = (index: number) => {
    setParts((prev) => prev.filter((_, i) => i !== index))
    setExpanded(null)
  }

  const mergeAt = (index: number) => {
    setParts((prev) => mergeParts(prev, index))
    setExpanded(null)
  }

  /** 一刀切两半（切点吸附到最近的换行）—— 粗调用的，细调还是直接改正文 */
  const splitAt = (index: number) => {
    setParts((prev) => {
      const part = prev[index]
      if (!part) return prev
      return splitPartAt(prev, index, Math.floor(part.body.length / 2))
    })
    setExpanded(null)
  }

  const evenSplit = () => {
    const next = splitEvenly(raw, 3000)
    if (next.length) {
      setParts(next)
      setInfo({ parts: next, rules: ['even'], warnings: [], notes: [`按约 3000 字等分成 ${next.length} 章`] })
    }
  }

  const handleApply = async () => {
    if (!canApply) return
    setWriting(true)
    try {
      const ok = await onApply(toChapters(parts), mode)
      if (ok) {
        reset()
        onClose()
      }
    } finally {
      setWriting(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
      <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        {/* 标题栏 */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50 shrink-0">
          <div className="flex items-center gap-3">
            <div className="bg-slate-900 text-white p-2 rounded-xl">
              <Layers size={16} />
            </div>
            <div>
              <h3 className="text-sm font-black tracking-widest text-slate-900">导入稿件</h3>
              <p className="text-[10px] font-bold text-slate-400 mt-0.5">
                整篇文本自动切章 · 导入后一律先落草稿，排期 / 发布仍在编辑页
              </p>
            </div>
          </div>
          <button type="button" onClick={close} className="text-slate-400 hover:text-slate-900 bg-white p-2 rounded-xl">
            <X size={20} />
          </button>
        </div>

        {/* Tab */}
        <div className="px-6 pt-3 bg-white border-b border-slate-100 shrink-0 flex gap-1">
          {([
            ['split', '智能分章'],
            ['json', 'JSON 批量'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`px-5 py-2.5 rounded-t-xl text-[10px] font-black tracking-widest transition-all ${
                tab === key ? 'bg-slate-900 text-white' : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'json' ? (
          <div className="p-6 bg-slate-100 overflow-y-auto flex-1">{jsonSlot}</div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto bg-slate-100">
              {/* 输入区 */}
              <div className="p-6 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      className="text-[9px] font-black tracking-widest px-3 py-2 rounded-xl bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 transition-all"
                    >
                      <UploadCloud size={12} /> 上传 .txt / .md
                    </button>
                    {source && <span className="text-[10px] font-bold text-slate-400">{source}</span>}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setRaw('')
                      setSource('')
                      setFileError('')
                    }}
                    disabled={!raw}
                    className={`${ghostButton} disabled:opacity-30`}
                  >
                    <Trash2 size={12} /> 清空
                  </button>
                </div>

                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt,.md,.markdown,text/plain,text/markdown"
                  className="hidden"
                  onChange={onPickFile}
                />

                {fileError && (
                  <div className="flex items-start gap-2 text-[10px] font-bold text-rose-600">
                    <AlertCircle size={13} className="mt-0.5 shrink-0" />
                    {fileError}
                  </div>
                )}

                <textarea
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                  spellCheck={false}
                  placeholder="把整篇稿子粘在这里…支持 Markdown 的 # / ##、第X章、Chapter X、序章 / 楔子 / 番外"
                  className="w-full h-40 bg-white border border-slate-200 rounded-2xl p-4 text-[11px] font-medium leading-relaxed outline-none resize-y focus:border-slate-400"
                />
                <p className="text-[10px] font-bold text-slate-400 leading-relaxed">
                  粘贴后自动切章。标题可逐条改，切错了就「合并到上一章」或「再拆一半」；Markdown 符号会在入库前剥掉
                  （前台正文是逐行渲染的，`#` 会原样显示给读者）。
                </p>
              </div>

              {/* 统计 + 提示 */}
              {parts.length > 0 && (
                <div className="px-6 pb-4 space-y-3">
                  <div className="flex items-center gap-3 flex-wrap bg-white rounded-2xl border border-slate-200 px-4 py-3">
                    <span className="text-[10px] font-black tracking-widest text-slate-900">
                      {parts.length} 章
                    </span>
                    <span className="w-px h-3 bg-slate-200" />
                    <span className="text-[10px] font-bold text-slate-500">合计 {totalChars} 字</span>
                    <span className="w-px h-3 bg-slate-200" />
                    <span className="text-[10px] font-bold text-slate-500">
                      平均 {Math.round(totalChars / parts.length)} 字/章
                    </span>
                    <span className="ml-auto flex items-center gap-1.5 flex-wrap">
                      {info.rules.map((rule) => (
                        <span
                          key={rule}
                          className="text-[9px] font-black tracking-widest px-2 py-1 rounded-lg bg-slate-100 text-slate-500"
                        >
                          {RULE_LABEL[rule] ?? rule}
                        </span>
                      ))}
                    </span>
                  </div>

                  {info.warnings.map((w) => (
                    <div key={w} className="flex items-start gap-2 text-[10px] font-bold text-amber-600">
                      <AlertCircle size={13} className="mt-0.5 shrink-0" />
                      <span className="leading-relaxed">{w}</span>
                    </div>
                  ))}

                  {info.notes.map((n) => (
                    <div key={n} className="flex items-start gap-2 text-[10px] font-bold text-slate-400">
                      <Info size={13} className="mt-0.5 shrink-0" />
                      <span className="leading-relaxed">{n}</span>
                    </div>
                  ))}

                  {info.rules.includes('none') && (
                    <button
                      type="button"
                      onClick={evenSplit}
                      className="text-[9px] font-black tracking-widest px-3 py-2 rounded-xl bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 transition-all"
                    >
                      <Scissors size={12} /> 没找到章节标记，按约 3000 字等分
                    </button>
                  )}
                </div>
              )}

              {/* 预览列表：标题可改，切错就合并 / 再拆 */}
              {parts.length === 0 ? (
                <div className="px-6 pb-10 text-center text-[10px] font-black tracking-widest text-slate-300">
                  {raw.trim() ? '正在切章…' : '还没有内容'}
                </div>
              ) : (
                <div className="px-6 pb-6 space-y-2">
                  {parts.map((part, i) => (
                    <div key={i} className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                      <div className="flex items-center gap-3 px-4 py-3">
                        <span className="w-6 h-6 rounded-lg bg-slate-900 text-white text-[9px] font-black flex items-center justify-center shrink-0">
                          {i + 1}
                        </span>
                        <input
                          value={part.title}
                          onChange={(e) => updateTitle(i, e.target.value)}
                          className="flex-1 min-w-0 bg-transparent text-[11px] font-black text-slate-900 outline-none border-b border-transparent focus:border-slate-300"
                        />
                        <span className="text-[9px] font-black text-slate-400 shrink-0">{part.chars} 字</span>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => mergeAt(i)}
                            disabled={i === 0}
                            title="把这一章并进上一章"
                            className={`${iconButton} disabled:opacity-20`}
                          >
                            <Merge size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => splitAt(i)}
                            disabled={part.chars < 400}
                            title="在这章中间再拆一刀（切点吸附到最近的换行）"
                            className={`${iconButton} disabled:opacity-20`}
                          >
                            <Scissors size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setExpanded(expanded === i ? null : i)}
                            title="展开 / 收起正文"
                            className={iconButton}
                          >
                            {expanded === i ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                          </button>
                          <button
                            type="button"
                            onClick={() => removeAt(i)}
                            title="删掉这一章"
                            className={`${iconButton} hover:bg-rose-50 hover:text-rose-500`}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>

                      {part.warnings.length > 0 && (
                        <p className="px-4 pb-2 text-[10px] font-bold text-amber-600">{part.warnings.join(' · ')}</p>
                      )}

                      {expanded === i ? (
                        <pre className="px-4 pb-4 text-[11px] leading-relaxed text-slate-600 whitespace-pre-wrap font-serif max-h-60 overflow-y-auto">
                          {part.body}
                        </pre>
                      ) : (
                        <p className="px-4 pb-3 text-[10px] text-slate-400 leading-relaxed line-clamp-2">
                          {part.body.slice(0, 120) || '（空章）'}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 底栏：写入模式 + 确认 */}
            <div className="px-6 py-4 border-t border-slate-100 bg-white flex items-center justify-between gap-4 shrink-0 flex-wrap">
              <div className="flex items-center gap-1.5 p-1.5 bg-slate-50 rounded-2xl border border-slate-100">
                {([
                  ['replace', existingCount > 0 ? `覆盖现有 ${existingCount} 章` : '写入本章节'],
                  ['append', `追加到末尾${existingCount > 0 ? `（保留现有 ${existingCount} 章）` : ''}`],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setMode(key)}
                    className={`px-4 py-2 rounded-xl text-[9px] font-black tracking-widest transition-all ${
                      mode === key ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-400 hover:text-slate-600'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={close}
                  className="px-5 py-2.5 rounded-xl text-[10px] font-black text-slate-500 hover:bg-slate-50 transition-all"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleApply}
                  disabled={!canApply}
                  className="bg-slate-900 text-white px-8 py-2.5 rounded-xl text-[10px] font-black tracking-widest shadow-xl flex items-center gap-2 disabled:opacity-40 transition-all"
                >
                  {writing ? <Loader2 size={14} className="animate-spin" /> : <Layers size={14} />}
                  {writing ? '写入中...' : `导入 ${parts.length} 章`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
