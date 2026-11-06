'use client'

import React, { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, ExternalLink, Layers, Tag } from 'lucide-react'
import { effectiveStatus } from '@/lib/scheduled'
import {
  publicTopicUrl,
  quizCategories,
  quizTopicList,
  quizTopicSlug,
  type QuizRow,
} from '@/lib/quizStudio'
import { cn, Label, Panel, StudioHead } from './ui'

function tagList(rows: QuizRow[]): Array<{ label: string; count: number }> {
  const map = new Map<string, number>()
  for (let i = 0; i < rows.length; i += 1) {
    const raw = rows[i].tags
    const tags = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
    for (let j = 0; j < tags.length; j += 1) {
      const label = String(tags[j] ?? '').trim()
      if (!label) continue
      const key = label.toLowerCase()
      map.set(key, (map.get(key) || 0) + 1)
    }
  }
  return Array.from(map.entries())
    .map(([key, count]) => ({ label: key, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

export default function QuizStudioTaxonomy({
  rows,
  onOpenTopic,
}: {
  rows: QuizRow[]
  onOpenTopic: (topic: string) => void
}) {
  const topics = useMemo(() => quizTopicList(rows), [rows])
  const [active, setActive] = useState(topics[0]?.label || '')
  const selected = topics.find((item) => item.label === active) || topics[0] || null

  const stats = useMemo(() => {
    const map = new Map<string, { total: number; published: number; draft: number }>()
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]
      const categories = quizCategories({
        categories: row.categories ?? (row.raw_data as any)?.categories,
      })
      const status = effectiveStatus(row)
      for (let j = 0; j < categories.length; j += 1) {
        const label = categories[j]
        const item = map.get(label.toLowerCase()) || { total: 0, published: 0, draft: 0 }
        item.total += 1
        if (status === 'published') item.published += 1
        if (status === 'draft') item.draft += 1
        map.set(label.toLowerCase(), item)
      }
    }
    return map
  }, [rows])

  const uncategorized = rows.filter((row) => {
    const categories = quizCategories({
      categories: row.categories ?? (row.raw_data as any)?.categories,
    })
    return categories.length === 0
  }).length

  // `quizTopicList` 本身会丢掉 slug 为空的分类，所以这里单独扫一遍原始分类，
  // 才能把「全中文、前台没有主题页」的情况如实提示出来。
  const unusable = useMemo(() => {
    const labels = new Set<string>()
    for (let i = 0; i < rows.length; i += 1) {
      const categories = quizCategories({
        categories: rows[i].categories ?? (rows[i].raw_data as any)?.categories,
      })
      for (let j = 0; j < categories.length; j += 1) {
        if (categories[j] && !quizTopicSlug(categories[j])) labels.add(categories[j])
      }
    }
    return Array.from(labels)
  }, [rows])
  const tags = useMemo(() => tagList(rows), [rows])
  const selectedStats = selected ? stats.get(selected.label.toLowerCase()) : null

  return (
    <div className="space-y-6">
      <StudioHead
        title={
          <>
            Taxonomy<span className="text-[#FF6B3D]">.</span>
          </>
        }
        sub="分类就是前台 topic：同一个 categories 字段，slug 化后决定 /quizzes/topic/[slug]"
        actions={
          <Link
            href="/admin/quizzes/create"
            className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 transition hover:text-slate-900"
          >
            <Tag size={13} /> 去编辑分类
          </Link>
        }
      />

      <Panel className="!bg-slate-50/70">
        <div className="flex flex-wrap items-center gap-3">
          <Label className="!text-slate-500">当前真实关系</Label>
          <span className="rounded-full bg-white px-3 py-1 text-[9px] font-black uppercase tracking-widest text-slate-500 ring-1 ring-slate-200">
            {topics.length} 个分类
          </span>
          <span className="rounded-full bg-white px-3 py-1 text-[9px] font-black uppercase tracking-widest text-slate-500 ring-1 ring-slate-200">
            {uncategorized} 条未分类
          </span>
          {unusable.length ? (
            <span className="rounded-full bg-amber-50 px-3 py-1 text-[9px] font-black uppercase tracking-widest text-amber-600">
              {unusable.length} 个分类 slug 化后为空
            </span>
          ) : null}
        </div>
        <p className="mt-3 max-w-3xl text-[11px] font-medium leading-relaxed text-slate-500">
          后台保存的是 <code className="font-mono">quizzes.categories</code>；ComeBrief 的
          <code className="ml-1 font-mono">/quizzes/topic/[slug]</code> 对每个分类做 slug 化后聚合。
          所以这里不需要「跑归并脚本」—— 改一条测验的分类，列表、主题页和 sitemap 会一起变。
          全中文分类没有可用 slug，只会出现在列表筛选里，不会生成主题页。
        </p>
      </Panel>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel padded={false} className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
            <Label>Topics · 按真实测验数排序</Label>
            <Label>Count</Label>
          </div>
          <div className="divide-y divide-slate-50">
            {topics.map((topic) => {
              const item = stats.get(topic.label.toLowerCase()) || {
                total: topic.count,
                published: 0,
                draft: 0,
              }
              const isActive = selected?.slug === topic.slug
              return (
                <button
                  key={topic.slug || topic.label}
                  type="button"
                  onClick={() => setActive(topic.label)}
                  className={cn(
                    'flex w-full items-center gap-4 px-6 py-4 text-left transition',
                    isActive ? 'bg-slate-50' : 'hover:bg-slate-50/60'
                  )}
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-slate-900" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-black text-slate-800">{topic.label}</p>
                    <p className="mt-0.5 font-mono text-[9px] font-bold text-slate-400">
                      /quizzes/topic/{topic.slug || '—'}
                    </p>
                  </div>
                  <span className="hidden text-[11px] font-bold tabular-nums text-slate-400 sm:block">
                    {item.published} 已发布 / {item.draft} 草稿
                  </span>
                  <span className="w-10 text-right text-[13px] font-black tabular-nums text-slate-800">
                    {topic.count}
                  </span>
                  <ArrowRight size={13} className="text-slate-300" />
                </button>
              )
            })}
            {topics.length === 0 ? (
              <div className="px-6 py-16 text-center text-xs font-semibold text-slate-300">
                还没有任何分类
              </div>
            ) : null}
          </div>
        </Panel>

        <div className="space-y-4">
          {selected ? (
            <Panel className="space-y-4">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-900 text-white">
                  <Layers size={15} />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-black text-slate-900">{selected.label}</p>
                  <p className="font-mono text-[9px] font-bold text-slate-400">{selected.slug}</p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: '全部', value: selectedStats?.total ?? selected.count },
                  { label: '已发布', value: selectedStats?.published ?? 0 },
                  { label: '草稿', value: selectedStats?.draft ?? 0 },
                ].map((item) => (
                  <div key={item.label} className="rounded-xl bg-slate-50 px-2 py-2 text-center">
                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                      {item.label}
                    </p>
                    <p className="mt-1 text-lg font-black tabular-nums text-slate-800">{item.value}</p>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => onOpenTopic(selected.label)}
                  className="flex items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-white transition hover:bg-slate-800"
                >
                  在列表中筛选这个分类 <ArrowRight size={12} />
                </button>
                {selected.slug ? (
                  <a
                    href={publicTopicUrl(selected.label)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-600 transition hover:text-slate-900"
                  >
                    打开前台主题页 <ExternalLink size={12} />
                  </a>
                ) : (
                  <p className="rounded-2xl bg-amber-50 px-3 py-2 text-[10px] font-medium leading-relaxed text-amber-600">
                    这个分类 slug 化后为空（可能是全中文），前台没有可用的主题页地址。
                  </p>
                )}
              </div>

              <p className="text-[10px] font-medium leading-relaxed text-slate-400">
                主题页只要 ≥ 1 条可见测验就能打开；0 条时是 404。sitemap 只列真的能打开的 topic。
              </p>
            </Panel>
          ) : null}

          <Panel className="space-y-3">
            <div className="flex items-center gap-2">
              <Tag size={13} className="text-slate-300" />
              <Label>Tags · 可多选</Label>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag.label}
                  className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-[10px] font-bold text-slate-500"
                >
                  {tag.label}
                  <span className="ml-1.5 tabular-nums text-slate-300">{tag.count}</span>
                </span>
              ))}
              {tags.length === 0 ? (
                <span className="text-[10px] font-bold text-slate-300">没有标签</span>
              ) : null}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}

