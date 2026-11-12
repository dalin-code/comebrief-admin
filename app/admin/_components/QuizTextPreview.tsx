'use client'

/**
 * 文本模式的预览：把刚解析出来的卷按结果页的样子摆一遍。
 *
 * 为什么值得单独一块（而不是只给个「8 题 · 可导入」的徽章）：
 * 文本路径最容易错的地方不是语法，而是**语义**——两个结果占了同一个象限、
 * 选项能量档全是 1、某个结果的名字长到海报上换行。这些在源码里看不出来，
 * 摆成四个角、列成一张表，一眼就能看出来。
 *
 * 没有 `kit`（还在红框里）时整块不渲染 —— 红框已经有逐行的错误列表了。
 */

import { CheckCircle2, AlertTriangle } from 'lucide-react'
import type { QuizTextEntry } from '@/lib/quizText'
import { summarizeCompiled } from '@/lib/quizCompile'

const QUADRANT_ORDER = ['TL', 'TR', 'BL', 'BR'] as const

const QUADRANT_STYLE: Record<string, string> = {
  TL: 'bg-amber-50 border-amber-200',
  TR: 'bg-rose-50 border-rose-200',
  BL: 'bg-indigo-50 border-indigo-200',
  BR: 'bg-emerald-50 border-emerald-200',
}

const QUADRANT_TITLE: Record<string, string> = {
  TL: '左上 · 静',
  TR: '右上 · 闹',
  BL: '左下 · 独',
  BR: '右下 · 冲',
}

const chip = 'text-[9px] font-black tracking-widest px-2 py-0.5 rounded-full'

export default function QuizTextPreview({ entry }: { entry: QuizTextEntry }) {
  const kit = entry.kit
  if (!kit) return null

  const summary = entry.compiled ? summarizeCompiled(entry.compiled) : null
  const byQuadrant = new Map(kit.archetypes.map((archetype) => [archetype.quadrant ?? '', archetype]))

  return (
    <div className="border-t border-slate-100 bg-slate-50/60 px-5 py-4 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-[11px] font-black text-slate-800 truncate">{kit.title || '（无标题）'}</p>
          {kit.hook && <p className="text-[10px] font-bold text-slate-400 leading-relaxed">{kit.hook}</p>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {kit.topicLabel && <span className={`${chip} bg-slate-900 text-white`}>{kit.topicLabel}</span>}
          {kit.tags.map((tag) => (
            <span key={tag} className={`${chip} bg-white border border-slate-200 text-slate-500`}>
              {tag}
            </span>
          ))}
          {summary && (
            <span
              className={`${chip} flex items-center gap-1 ${
                summary.health === 100 ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
              }`}
            >
              {summary.health === 100 ? <CheckCircle2 size={10} /> : <AlertTriangle size={10} />}
              健康 {summary.health}
            </span>
          )}
          {summary && (
            <span className={`${chip} bg-white border border-slate-200 text-slate-500`}>
              平局 {summary.tiePct.toFixed(1)}%
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {QUADRANT_ORDER.map((quadrant) => {
          const archetype = byQuadrant.get(quadrant)
          if (!archetype) {
            return (
              <div
                key={quadrant}
                className="rounded-2xl border border-dashed border-rose-300 bg-rose-50/50 px-3 py-2 text-[10px] font-black text-rose-500"
              >
                {quadrant} 空着
              </div>
            )
          }
          return (
            <div key={quadrant} className={`rounded-2xl border px-3 py-2 ${QUADRANT_STYLE[quadrant]}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[9px] font-black tracking-widest text-slate-400">
                  {quadrant} · {QUADRANT_TITLE[quadrant]}
                </span>
                <span className="text-[9px] font-black tracking-widest text-slate-400">
                  {archetype.pose ?? '缺 pose'}
                </span>
              </div>
              <p className="text-[11px] font-black text-slate-800 leading-tight mt-1">{archetype.name}</p>
              <p className="text-[9px] font-bold text-slate-500 leading-relaxed mt-1 line-clamp-2">
                {archetype.headline || archetype.short || '—'}
              </p>
              <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                {(archetype.pills ?? []).map((pill) => (
                  <span
                    key={pill}
                    className="text-[8px] font-black tracking-widest bg-white/70 text-slate-600 px-1.5 py-0.5 rounded-full"
                  >
                    {pill}
                  </span>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {kit.axes && (
        <div className="flex items-center justify-between gap-3 text-[9px] font-black tracking-widest text-slate-400">
          <span>
            X · {kit.axes.x.neg} ←→ {kit.axes.x.pos}
          </span>
          <span>
            Y · {kit.axes.y.neg} ←→ {kit.axes.y.pos}
          </span>
        </div>
      )}

      <div className="space-y-1.5">
        {kit.questions.map((question, index) => (
          <div key={index} className="bg-white rounded-xl border border-slate-200 px-3 py-2">
            <div className="flex items-baseline gap-2">
              <span className="text-[9px] font-black tracking-widest text-slate-400 shrink-0">Q{index + 1}</span>
              {question.scene && (
                <span className="text-[9px] font-black tracking-widest text-indigo-400 shrink-0">{question.scene}</span>
              )}
              <span className="text-[10px] font-bold text-slate-700 leading-snug">{question.title || '（缺题干）'}</span>
            </div>
            <div className="grid grid-cols-2 gap-1 mt-1">
              {question.options.map((option, optionIndex) => {
                const owner = kit.archetypes.find((archetype) => archetype.id === option.primary)
                return (
                  <div key={optionIndex} className="flex items-baseline gap-1 min-w-0">
                    <span className="text-[9px] font-black text-slate-300 shrink-0">
                      {String.fromCharCode(65 + optionIndex)}
                    </span>
                    <span className="text-[9px] font-bold text-slate-500 truncate">{option.text}</span>
                    <span className="text-[8px] font-black text-slate-300 shrink-0">
                      i{option.intensity ?? '?'}
                      {option.bold ? ' · b' : ''}
                    </span>
                    <span className="text-[8px] font-black text-indigo-300 shrink-0">
                      {owner?.short || owner?.id || '?'}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
