'use client'

import React, { useCallback, useState } from 'react'
import { ChevronDown, Loader2, RefreshCw, Stethoscope, Zap } from 'lucide-react'
import { getFreshAccessToken } from '@/lib/clientAuth'

/**
 * 🩺 AI 自检卡片（挂在编辑页右侧栏最上面，默认收起）。
 *
 * 为什么要有它：AI 一挂，站长手上只有一句红字提示 ——
 *   「是主模型没额度？还是兜底没配上？还是 AI_MODEL_FALLBACK 写成了别的供应商、压根没用上？」
 * 这些答案全在服务端的环境变量里，前端看不见。这张卡片就是把 /api/ai/status 读出来的东西摊开：
 * 每个任务实际用哪个模型、兜底链配了没有、哪把 Key 缺了、谁在冷却。
 *
 * 两个按钮对应两种代价：
 *   「只查配置」= 一个 token 都不花，秒回
 *   「真调一次」= 真的去问一遍每个模型（很省，但确实花额度），给出「现在到底能不能写」
 *
 * 默认收起 —— 平时它只是一行窄条，不抢编辑区的注意力；出问题时点一下就行。
 */

type RoutingRow = {
  task: string
  spec: string
  ok: boolean
  provider: string
  protocol?: string
  model: string
  cooldown: string
  error: string
}

type ProbeRow = {
  spec: string
  ok: boolean
  ms: number
  model?: string
  provider?: string
  status?: number
  kind?: string
  retryAfterMs?: number
  error?: string
}

type MtRow = {
  spec: string
  ok: boolean
  label: string
  baseUrl: string
  cooling: string
  error: string
}

type MtProbeRow = {
  spec: string
  ok: boolean
  ms: number
  provider?: string
  label?: string
  sample?: string
  status?: number
  kind?: string
  error?: string
}

/** 翻译兜底链（方案 3）：LLM 全挂时才用到的传统 MT 引擎 */
type MtInfo = {
  enabled: boolean
  chain: string[]
  rows: MtRow[]
  keys: Record<string, boolean>
  summary: { level: 'ok' | 'warn' | 'error' | 'info'; text: string }
}

type StatusData = {
  env: Record<string, string>
  keys: Record<string, boolean>
  routing: RoutingRow[]
  fallback: Array<{ spec: string; ok: boolean; label: string; model: string; cooldown: string; error: string }>
  cooldowns: Array<{ spec: string; leftMs: number; reason: string }>
  memo: { entries: number; inflight: number }
  mt: MtInfo
  probed: boolean
  probe: ProbeRow[]
  mtProbe: MtProbeRow[]
  summary: { level: 'ok' | 'warn' | 'error'; text: string }
}

const TASK_LABEL: Record<string, string> = {
  story: '写正文',
  revise: '自评/重写',
  translate: '中译英',
  util: '摘要等杂活',
}

const LEVEL_STYLE: Record<string, string> = {
  ok: 'bg-emerald-50 text-emerald-600 border-emerald-100',
  warn: 'bg-amber-50 text-amber-600 border-amber-100',
  error: 'bg-rose-50 text-rose-600 border-rose-100',
  /** 「没配」这种不算错的状态（比如翻译兜底链空着） */
  info: 'bg-slate-50 text-slate-500 border-slate-100',
}

export default function AiHealthCard() {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [probing, setProbing] = useState(false)
  const [data, setData] = useState<StatusData | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async (probe: boolean) => {
    if (probe) setProbing(true)
    else setLoading(true)
    setError('')
    try {
      const token = await getFreshAccessToken()
      if (!token) throw new Error('登录状态失效，请刷新页面')
      const resp = await fetch(`/api/ai/status${probe ? '?probe=1' : ''}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const json: any = await resp.json().catch(() => ({}))
      if (!resp.ok || !json?.ok) throw new Error(json?.error || `读取失败（${resp.status}）`)
      setData(json.data as StatusData)
    } catch (e: any) {
      setError(e?.message || '读取失败')
    } finally {
      setLoading(false)
      setProbing(false)
    }
  }, [])

  const toggle = () => {
    const next = !open
    setOpen(next)
    // 展开时顺手拉一次配置（不花额度）—— 展开就是为了看东西
    if (next && !data && !loading) void load(false)
  }

  return (
    <section className="bg-white rounded-[40px] border border-slate-100 shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        className="w-full px-8 py-6 flex items-center justify-between gap-3 hover:bg-slate-50/60 transition-colors"
      >
        <span className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400 italic flex items-center gap-2">
          <Stethoscope size={14} /> AI 自检 (Health)
        </span>
        <span className="flex items-center gap-2">
          {data && (
            <span
              className={`w-2 h-2 rounded-full ${
                data.summary.level === 'ok'
                  ? 'bg-emerald-400'
                  : data.summary.level === 'warn'
                    ? 'bg-amber-400'
                    : 'bg-rose-500'
              }`}
            />
          )}
          <ChevronDown size={16} className={`text-slate-300 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {open ? (
        <div className="px-8 pb-8 space-y-5 animate-in slide-in-from-top-2 duration-200 text-left">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => load(false)}
              disabled={loading || probing}
              className="flex-1 h-10 rounded-2xl bg-slate-900 text-white font-black text-[9px] uppercase tracking-widest disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 只查配置
            </button>
            <button
              type="button"
              onClick={() => load(true)}
              disabled={loading || probing}
              title="真的去问一遍每个模型（会消耗一点点额度）"
              className="flex-1 h-10 rounded-2xl border border-slate-200 text-slate-600 font-black text-[9px] uppercase tracking-widest disabled:opacity-40 flex items-center justify-center gap-2 hover:bg-slate-50"
            >
              {probing ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />} 真调一次
            </button>
          </div>

          {error ? <p className="text-[10px] font-bold text-rose-500 leading-relaxed">{error}</p> : null}

          {data ? <StatusBody data={data} /> : null}
        </div>
      ) : null}
    </section>
  )
}

/** 展开后的正文 —— 拆成子组件只是为了让上面那段 JSX 不至于长到看不清 */
function StatusBody({ data }: { data: StatusData }) {
  return (
    <>
      <p className={`text-[10px] font-bold leading-relaxed p-4 rounded-2xl border ${LEVEL_STYLE[data.summary.level]}`}>
        {data.summary.text}
      </p>

      <div className="space-y-2">
        <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">任务 → 模型</p>
        {data.routing.map((row) => (
          <div key={row.task} className="flex items-start justify-between gap-3 text-[10px] leading-relaxed">
            <span className="font-black text-slate-500 shrink-0">{TASK_LABEL[row.task] || row.task}</span>
            <span className="text-right min-w-0">
              {row.ok ? (
                <>
                  <span className="font-bold text-slate-800 break-all">{row.spec}</span>
                  <span className="text-slate-400"> · {row.provider}</span>
                  {row.cooldown ? <span className="block text-amber-500 font-bold">冷却中：{row.cooldown}</span> : null}
                </>
              ) : (
                <span className="text-rose-500 font-bold break-words">{row.error}</span>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">兜底链 (AI_MODEL_FALLBACK)</p>
        {data.fallback.length === 0 ? (
          <p className="text-[10px] font-bold text-amber-500 leading-relaxed">
            没配。主模型一挂就没退路 —— 建议配一个「不同供应商」的模型，也可以逗号分隔配一串。
          </p>
        ) : (
          data.fallback.map((f) => (
            <div key={f.spec} className="text-[10px] leading-relaxed">
              {f.ok ? (
                <>
                  <span className="font-bold text-slate-800 break-all">{f.spec}</span>
                  <span className="text-slate-400"> · {f.label}</span>
                  {f.cooldown ? <span className="block text-amber-500 font-bold">冷却中：{f.cooldown}</span> : null}
                </>
              ) : (
                <span className="text-rose-500 font-bold break-words">{f.error}</span>
              )}
            </div>
          ))
        )}
      </div>

      {/*
        翻译兜底 · 传统 MT（方案 3）。
        为什么单独一块：它跟上面的「模型」不是一回事 —— 只有 LLM 整条链全挂时才会被用到，
        所以缺 Key 不算配置错误（level=info），配好了就是一根救命绳。
      */}
      {data.mt ? (
        <div className="space-y-2">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">
            翻译兜底 · 传统 MT (AI_TRANSLATE_MT_FALLBACK)
          </p>
          <p className={`text-[10px] font-bold leading-relaxed p-3 rounded-2xl border ${LEVEL_STYLE[data.mt.summary.level] || LEVEL_STYLE.info}`}>
            {data.mt.summary.text}
          </p>
          {data.mt.rows.map((row) => (
            <div key={row.spec} className="text-[10px] leading-relaxed">
              {row.ok ? (
                <>
                  <span className="font-bold text-slate-800 break-all">{row.spec}</span>
                  <span className="text-slate-400"> · {row.label}</span>
                  {row.cooling ? <span className="block text-amber-500 font-bold">冷却中：{row.cooling}</span> : null}
                </>
              ) : (
                <span className="text-rose-500 font-bold break-words">{row.error}</span>
              )}
            </div>
          ))}
          {data.mt.rows.length > 0 ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] font-bold">
              {Object.entries(data.mt.keys).map(([k, has]) => (
                <span key={k} className={has ? 'text-emerald-600' : 'text-slate-300'}>
                  {has ? '✓' : '✗'} {k.replace(/_API_KEY|_URL|_REGION/, '')}
                </span>
              ))}
            </div>
          ) : null}
          {data.mtProbe?.length ? (
            <div className="space-y-1">
              {data.mtProbe.map((p) => (
                <div key={`mt-${p.spec}`} className="text-[10px] leading-relaxed">
                  <span className="font-bold text-slate-800 break-all">{p.spec}</span>
                  <span className={p.ok ? 'text-emerald-600 font-black' : 'text-rose-500 font-black'}>
                    {p.ok
                      ? ` 可用（${p.ms}ms）${p.sample ? ` → ${p.sample}` : ''}`
                      : ` 不可用${p.status ? ` ${p.status}` : ''}${p.kind ? ` · ${p.kind}` : ''}`}
                  </span>
                  {!p.ok && p.error ? <span className="block text-slate-400 break-words">{p.error}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {data.probe.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">真调结果</p>
          {data.probe.map((p) => (
            <div key={p.spec} className="text-[10px] leading-relaxed">
              <span className="font-bold text-slate-800 break-all">{p.spec}</span>
              <span className={p.ok ? 'text-emerald-600 font-black' : 'text-rose-500 font-black'}>
                {p.ok
                  ? ` 可用（${p.ms}ms）`
                  : ` 不可用${p.status ? ` ${p.status}` : ''}${p.kind ? ` · ${p.kind}` : ''}`}
              </span>
              {!p.ok && p.error ? <span className="block text-slate-400 break-words">{p.error}</span> : null}
              {!p.ok && p.retryAfterMs ? (
                <span className="block text-amber-500 font-bold">对面建议 {Math.ceil(p.retryAfterMs / 1000)} 秒后再试</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="space-y-1">
        <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">环境变量</p>
        {Object.entries(data.env).map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-3 text-[9px] leading-relaxed">
            <span className="font-black text-slate-400 shrink-0">{k}</span>
            <span className={`text-right break-all ${v ? 'text-slate-700 font-bold' : 'text-slate-300'}`}>
              {v || '（空）'}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] font-bold">
        {Object.entries(data.keys).map(([k, has]) => (
          <span key={k} className={has ? 'text-emerald-600' : 'text-slate-300'}>
            {has ? '✓' : '✗'} {k.replace('_API_KEY', '')}
          </span>
        ))}
      </div>
      <p className="text-[9px] text-slate-400 font-bold leading-relaxed">
        上面那行是「哪把 Key 配了」；缺哪个供应商的 Key，就用不了哪个供应商的模型。
        {'　'}「翻译兜底」那一块是 LLM 全挂时才启用的机翻救命绳（方案 3），平时不参与生成，
        缺 Key 不算问题；想配就看 docs/translation-layered-architecture.md。
        {data.memo.entries > 0 ? `　记忆里存了 ${data.memo.entries} 条摘要（5 分钟内重复点不会重复花额度）。` : ''}
      </p>
    </>
  )
}
