/**
 * 广告坑位的**唯一清单**（后台管理页、写接口、公开读接口共用这一份）。
 *
 * 为什么要有这个文件：坑位 id 之前散落在三个地方 —— 后台页面的 `AD_MATRIX`、
 * 前台 `AdRenderer` 的 `slotConstraints`、以及数据库里随手插入的 `position`。
 * 三处各写各的，于是出现了「后台能配 `GLOBAL_FOOTER_STICKY`，前台从来没挂过」
 * 和「前台在渲染 `QUIZ_INLINE`，后台矩阵里没有这个坑」这种对不上账的情况。
 * 现在只认这 4 个，前后端改完必须同步（`ComeBrief/supabase/51_ads_slots.sql`
 * 负责把老 id 迁过来）。
 *
 * 注意：这个文件会被客户端组件 import，不要引入任何 server-only 依赖。
 */

export type AdSlotId = 'HOME_MID' | 'DETAIL_BOTTOM' | 'QUIZ_FOOTER' | 'SIDEBAR_PROMO'

export interface AdSlotDef {
  id: AdSlotId
  /** 后台卡片标题 */
  name: string
  /** 出现在哪些页面（给运营看的一句话） */
  page: string
  /** 具体位置：写清楚在哪个模块之间，避免下次又挂错 */
  where: string
  /** 桌面建议尺寸 */
  desktop: string
  /** 移动建议尺寸 */
  mobile: string
}

export const AD_SLOTS: AdSlotDef[] = [
  {
    id: 'HOME_MID',
    name: '首页 - 中段横幅',
    page: 'Home',
    where: 'Fresh stories 下方、Mirror quizzes / Serials 之间（同页最多 1 条）',
    desktop: '728×90 / 970×90',
    mobile: '320×50 / 320×100',
  },
  {
    id: 'DETAIL_BOTTOM',
    name: '详情页 - 正文结束位',
    page: 'Brief / Story',
    where: 'Brief 卡片展开后、Story 正文结束后、「Next / More」导航之前',
    desktop: '728×90 或 300×250',
    mobile: '300×250 / 320×100',
  },
  {
    id: 'QUIZ_FOOTER',
    name: '答题页 - 页尾横幅',
    page: 'Quiz',
    where: '答题页 Previous/Next 之下；结果页 Next mirror 之后（不插选项中间）',
    desktop: '728×90',
    mobile: '320×50',
  },
  {
    id: 'SIDEBAR_PROMO',
    name: '侧边栏 / 列表末尾补充位',
    page: 'Home / Brief list',
    where: '详情页侧栏、列表页末尾的补充位（移动端按需显示）',
    desktop: '300×250 / 300×600',
    mobile: '300×250',
  },
]

export const AD_SLOT_IDS: AdSlotId[] = AD_SLOTS.map((s) => s.id)

export function isAdSlotId(value: unknown): value is AdSlotId {
  return typeof value === 'string' && (AD_SLOT_IDS as string[]).includes(value)
}

export function getAdSlot(id: string): AdSlotDef | null {
  return AD_SLOTS.find((s) => s.id === id) || null
}

/**
 * 老坑位 id → 新坑位 id。数据库迁移和接口都认这张表，
 * 这样「前台还没发版、库里已经改完」的窗口期里旧请求也不会 400。
 */
export const LEGACY_AD_SLOT_MAP: Record<string, AdSlotId> = {
  HOME_HEADER: 'HOME_MID',
  DETAIL_CONTENT_MID: 'DETAIL_BOTTOM',
  QUIZ_INLINE: 'QUIZ_FOOTER',
  SIDEBAR_TOP: 'SIDEBAR_PROMO',
}

/** 把任意传入的坑位 id 归一到 4 个主力坑位；不认识就返回 null。 */
export function coerceAdSlot(value: unknown): AdSlotId | null {
  const v = String(value ?? '').trim()
  if (!v) return null
  if (isAdSlotId(v)) return v
  return LEGACY_AD_SLOT_MAP[v] || null
}
