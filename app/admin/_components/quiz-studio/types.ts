'use client'

import type { QuizRow } from '@/lib/quizStudio'

/** 列表、详情抽屉、检查屏共用的动作集合；由外层页面统一提供实现。 */
export type QuizStudioActions = {
  onEdit: (row: QuizRow) => void
  onPreview: (row: QuizRow) => void
  onTogglePublish: (row: QuizRow) => void
  onToggleFeatured: (row: QuizRow) => void
  onDuplicate: (row: QuizRow) => void
  onDelete: (row: QuizRow) => void
  onOpenMatrix: (row: QuizRow) => void
  onOpenDetail: (row: QuizRow) => void
}

export type StudioScreen =
  | 'list'
  | 'matrix'
  | 'checks'
  | 'taxonomy'
  | 'review'
  | 'front'
