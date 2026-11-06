'use client'

/**
 * Quiz Studio 的写库小工具。
 *
 * 后台的历史包袱是「阶段 0 的 SQL 不一定跑过」：`status` / `scheduled_at` /
 * `is_featured` / `scoring_mode` 这些列可能不存在。现有保存流程在遇到
 * `Could not find the 'x' column` 时会剔除该字段重试，这里把同一套策略抽出来，
 * 让列表里的发布 / 下线 / 复制 / 矩阵保存都不会因为一个可选列而整体失败。
 *
 * 失败一律返回 `{ error }`，不 throw —— 调用方负责 toast 给用户看。
 */

import { supabase } from './supabase'
import { missingColumnFrom, type QuizRow } from './quizStudio'

type Result = { error?: string }

async function retryWithoutMissingColumns(
  run: (payload: Record<string, any>) => PromiseLike<{ error?: any; data?: any; count?: any }>,
  payload: Record<string, any>
): Promise<{ error?: string; data?: any }> {
  let current = { ...payload }
  let lastError: any = null

  for (let i = 0; i < 10; i += 1) {
    const result = await run(current)
    if (!result?.error) return { data: result?.data }

    lastError = result.error
    const missing = missingColumnFrom(result.error?.message)
    if (missing && Object.prototype.hasOwnProperty.call(current, missing)) {
      const next = { ...current }
      delete next[missing]
      current = next
      continue
    }
    break
  }

  return { error: String(lastError?.message || lastError || '保存失败') }
}

/** 更新一行；缺列会自动剔除该字段重试。 */
export async function updateQuizRow(
  id: string,
  patch: Record<string, any>
): Promise<{ row?: QuizRow; error?: string }> {
  if (!id) return { error: '缺少测验 id' }

  const result = await retryWithoutMissingColumns(
    (payload) => supabase.from('quizzes').update(payload).eq('id', id).select('*').maybeSingle(),
    patch
  )
  if (result.error) return { error: result.error }
  return { row: (result.data || undefined) as QuizRow | undefined }
}

/** 插入一行；缺列会自动剔除该字段重试。 */
export async function insertQuizRow(
  payload: Record<string, any>
): Promise<{ row?: QuizRow; error?: string }> {
  // 刻意不在 insert 后面挂 `.select()`：部分 RLS 配置允许 insert 但不允许回读，
  // 那会让「已经插入成功」被误报成失败，用户重试就多出一条重复数据。
  // 调用方统一在成功后重新拉一次列表。
  const result = await retryWithoutMissingColumns(
    (current) => supabase.from('quizzes').insert([current]),
    payload
  )
  if (result.error) return { error: result.error }
  return { row: (result.data || undefined) as QuizRow | undefined }
}

/** 删除一行。 */
export async function deleteQuizRow(id: string): Promise<Result> {
  if (!id) return { error: '缺少测验 id' }
  const { error } = await supabase.from('quizzes').delete().eq('id', id)
  return error ? { error: error.message } : {}
}
