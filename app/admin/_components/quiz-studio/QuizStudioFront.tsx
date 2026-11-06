'use client'

import React, { useMemo, useState } from 'react'
import { Copy, ExternalLink, Monitor, RefreshCcw, Smartphone } from 'lucide-react'
import { frontBaseUrl, publicTopicUrl, quizTopicList, type QuizRow } from '@/lib/quizStudio'
import { cn, Label, Panel, Pill, StudioHead } from './ui'

export default function QuizStudioFront({ rows }: { rows: QuizRow[] }) {
  const base = frontBaseUrl()
  const topics = useMemo(() => quizTopicList(rows), [rows])
  const [path, setPath] = useState('/quizzes')
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const [reloadKey, setReloadKey] = useState(0)
  const [copied, setCopied] = useState(false)

  const url = `${base}${path}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="space-y-6">
      <StudioHead
        title={
          <>
            Front<span className="text-[#FF6B3D]">.</span>
          </>
        }
        sub="这不是第二套前台，而是直接嵌真实的 ComeBrief /quizzes 页面"
        actions={
          <>
            <div className="flex items-center gap-1 rounded-2xl border border-slate-200 bg-white p-1">
              <button
                type="button"
                onClick={() => setDevice('desktop')}
                className={cn(
                  'flex items-center gap-1.5 rounded-xl px-3 py-2 text-[9px] font-black uppercase tracking-widest transition',
                  device === 'desktop' ? 'bg-slate-900 text-white' : 'text-slate-400'
                )}
              >
                <Monitor size={12} /> 桌面
              </button>
              <button
                type="button"
                onClick={() => setDevice('mobile')}
                className={cn(
                  'flex items-center gap-1.5 rounded-xl px-3 py-2 text-[9px] font-black uppercase tracking-widest transition',
                  device === 'mobile' ? 'bg-slate-900 text-white' : 'text-slate-400'
                )}
              >
                <Smartphone size={12} /> 手机
              </button>
            </div>
            <button
              type="button"
              onClick={() => setReloadKey((value) => value + 1)}
              className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 transition hover:text-slate-900"
            >
              <RefreshCcw size={13} /> 刷新
            </button>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-[10px] font-black uppercase tracking-widest text-white"
            >
              新标签打开 <ExternalLink size={13} />
            </a>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Pill active={path === '/quizzes'} onClick={() => setPath('/quizzes')}>
          全部测验
        </Pill>
        {topics.slice(0, 8).map((topic) => {
          const topicPath = `/quizzes/topic/${topic.slug}`
          return (
            <Pill
              key={topic.slug}
              active={path === topicPath}
              onClick={() => setPath(topicPath)}
            >
              {topic.label}
              <span className="ml-2 tabular-nums opacity-40">{topic.count}</span>
            </Pill>
          )
        })}
        <button
          type="button"
          onClick={copy}
          className="ml-auto flex items-center gap-1.5 rounded-full px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-400 transition hover:text-slate-900"
        >
          <Copy size={12} /> {copied ? '已复制' : '复制地址'}
        </button>
      </div>

      <Panel padded={false} className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
          <p className="break-all font-mono text-[10px] font-bold text-slate-500">{url}</p>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[8px] font-black uppercase tracking-widest text-slate-400">
            {device === 'mobile' ? '390px' : 'fluid'}
          </span>
        </div>
        <div className="flex justify-center overflow-auto bg-slate-100 p-4">
          <iframe
            key={`${url}-${reloadKey}`}
            src={url}
            title="ComeBrief quizzes preview"
            className={cn(
              'h-[720px] rounded-2xl border border-slate-200 bg-white shadow-sm',
              device === 'mobile' ? 'w-[390px] max-w-full' : 'w-full'
            )}
          />
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Panel>
          <Label>为什么有这一屏</Label>
          <p className="mt-2 text-[11px] font-medium leading-relaxed text-slate-500">
            静态稿的第 6 屏是「前台列表设计稿」。真实后台不需要再造一份：这里嵌的就是
            ComeBrief 的 <code className="font-mono">/quizzes</code>，点卡片会真的进入详情页。
            没有假数据、没有第二套筛选逻辑。
          </p>
        </Panel>
        <Panel>
          <Label>地址从哪来</Label>
          <p className="mt-2 text-[11px] font-medium leading-relaxed text-slate-500">
            优先读 <code className="font-mono">NEXT_PUBLIC_SITE_URL</code>；本地默认端口 3000，
            线上没配时退回 <code className="font-mono">https://comebrief.com</code>。后台在 3001
            时不会误嵌自己。
          </p>
        </Panel>
        <Panel>
          <Label>打不开怎么办</Label>
          <p className="mt-2 text-[11px] font-medium leading-relaxed text-slate-500">
            如果 iframe 是空白，通常是前台设置了禁止被嵌入的响应头，或者前台服务没启动。
            点右上角「新标签打开」永远能看到真实页面。
          </p>
        </Panel>
      </div>

      <p className="px-2 text-[9px] font-bold uppercase leading-relaxed tracking-widest text-slate-300">
        主题地址：{publicTopicUrl('Persona')} · 只有 ≥ 1 条可见测验的主题才能打开。
      </p>
    </div>
  )
}

