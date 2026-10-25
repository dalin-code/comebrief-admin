/**
 * 故事「选择层」：把站长手动勾的标签补齐成一篇真正要写的组合。
 *
 * 这里只做三件事，全部是纯函数，客户端 / 服务端都能用：
 *   1. normalizeCombo —— 清洗前端存下来的 JSON（旧数据、脏数据、超上限都收得住）；
 *   2. resolveComboTags —— 站长没选的维度，从标签库里**每次重新随机**补齐。
 *      历史只放在 `lastResolved` 里展示，绝不回填成「已选中」；
 *   3. Seed 派生 —— 同一个 Seed 固定同一副骨架，变体只换表皮与正文。
 *
 * 注意：这里不读数据库、不调用模型，方便脚本直接测试。
 */
import {
  DIMENSIONS,
  type DimensionKey,
  type StoryCombo,
  type StorySkill,
  type StoryTag,
} from './storyPrompt'

export type ComboTagMap = Partial<Record<DimensionKey, StoryTag[]>>

export type DerivedSeeds = {
  /** 用户看到 / 分享的那一个 Seed */
  seed: string
  /** 骨架种子：同一 Seed 永远映射到同一副骨架 */
  skeletonSeed: string
  /** 表皮种子：同骨架换一版时，人名、地点、时间、物件都要换 */
  surfaceSeed: string
  /** 正文种子：同一段文字尽量稳定，但允许模型有自己的措辞 */
  proseSeed: string
  variantIndex: number
}

export type ResolveComboResult = {
  /** 真正发给模型的组合：没选的维度已经补上了具体标签名 */
  combo: StoryCombo
  /** 按维度整理好的标签行（含 summary / example），提示词直接用 */
  tagsByDimension: ComboTagMap
  /** 每个维度实际用到的标签名（展示「本次实际用了什么」） */
  pickedNames: Partial<Record<DimensionKey, string[]>>
  /** 站长没选、本次由系统随机补的维度 */
  randomFilled: DimensionKey[]
  /** 选中的标签在库里找不到等提醒 */
  warnings: string[]
}

const LENGTHS = new Set([800, 1500, 2500])
const MAX_VARIANT = 9999

export const clampVariantIndex = (value: unknown) => {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n, MAX_VARIANT)
}

/** 浏览器 / Node 都能用的随机串；只用于「新开一篇」的 Seed 初值 */
export function makeSeed() {
  const c = (globalThis as any).crypto
  if (c?.getRandomValues) {
    const buf = new Uint32Array(2)
    c.getRandomValues(buf)
    return `${buf[0].toString(36)}${buf[1].toString(36)}`.slice(0, 12)
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 16)
}

/** 空 Seed 就发一个新 Seed；同一 Seed 前后空格不影响复现 */
export function normalizeSeed(input: unknown) {
  const s = String(input ?? '').trim().replace(/\s+/g, '-').slice(0, 80)
  return s || makeSeed()
}

/** 一次批量最多生成几篇草稿（再多会让站长等太久，也更容易写出同质化的一组） */
export const MAX_BATCH_STORIES = 5

/** 单篇参考素材的字数上限（与 API 的 4000 字截断保持一致） */
export const MAX_MATERIAL_CHARS = 4000

/**
 * 有参考素材时固定写多长。
 *
 * 素材是情节主干，不是一句氛围参考：1500 字经常只够把底本的开头和转折写完，
 * 结局只能一句带过；800 字更会把人物关系压没。所以素材模式统一按长篇写，
 * 让模型有空间把「起因 → 试探 → 代价 → 揭示 → 结局」走完整。
 */
export const MATERIAL_FIRST_LENGTH = 2500

/** 这一次是不是「素材优先」：只要填了素材，情节就必须以素材为准 */
export function isMaterialFirst(materials: unknown) {
  return String(materials ?? '').trim().length > 0
}

/**
 * 多篇参考素材按顺序对应批量篇目：`list[0]` → 第 1 篇，`list[1]` → 第 2 篇。
 *
 * 保留空字符串占位：站长删掉第 2 篇素材时，第 3 篇不能悄悄顶上来改成第 2 篇。
 * 不是数组（旧版只有一篇 `materials`）时返回空数组，交给调用方兼容。
 */
export function normalizeMaterialList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input
    .slice(0, MAX_BATCH_STORIES)
    .map((item) => String(item ?? '').trim().slice(0, MAX_MATERIAL_CHARS))
}

/**
 * 批量生成的第 index 篇用哪个 Seed。
 *
 * 第 0 篇就是站长填的那个 Seed；后面的优先用「数字 + 1」——这样站长下次把
 * 同一个数字填回来，仍然能逐篇复现整批。纯数字只处理到 int32 边界，超出或
 * 不是数字就用 `-b2` 这样的后缀，保证不撞车也不丢可读性。
 */
export function deriveBatchSeed(seedInput: unknown, indexInput: unknown) {
  const base = normalizeSeed(seedInput)
  const index = Math.min(MAX_BATCH_STORIES - 1, Math.max(0, Math.trunc(Number(indexInput) || 0)))
  if (index === 0) return base
  if (/^\d{1,10}$/.test(base)) {
    const n = Number(base)
    if (Number.isSafeInteger(n) && n + index <= 2_147_483_646) return String(n + index)
  }
  return `${base}-b${index + 1}`
}

/** FNV-1a 32 位。稳定、无依赖，用来派生各层 Seed / 指纹。 */
export function hashString(input: string) {
  let h = 0x811c9dc5
  const s = String(input || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 供应商的 seed 参数通常是正整数；0 也换成 1，避免个别家把 0 当成「未设置」 */
export function seedToInt(input: string) {
  return (hashString(input) % 2_147_483_646) + 1
}

/** mulberry32：给定字符串就能得到可复现的 0–1 随机流 */
export function seededRandom(seed: string) {
  let a = hashString(seed) || 1
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seededPick<T>(list: T[], rng: () => number): T | undefined {
  if (!list.length) return undefined
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))]
}

export function seededShuffle<T>(list: T[], rng: () => number): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * 同一 Seed + 同一 variantIndex → 同一组派生 Seed。
 * 骨架层完全不看 variantIndex；表皮 / 正文层看，所以「换一版」会换人换景。
 *
 * 有参考素材时，素材正文也参与派生：站长换了素材却沿用同一个 Seed 时，
 * 不能再从 story_recipes 里捞出上一份素材的骨架（那正是「换素材还是同一个故事」）。
 * 同一份素材 + 同一个 Seed 仍然逐篇复现。
 */
export function deriveSeeds(
  seedInput: unknown,
  variantIndexInput: unknown,
  materialsInput?: unknown
): DerivedSeeds {
  const seed = normalizeSeed(seedInput)
  const variantIndex = clampVariantIndex(variantIndexInput)
  const material = String(materialsInput ?? '').trim()
  const scope = material ? `${seed}|material|${hashString(material).toString(36)}` : seed
  const sk = hashString(`${scope}|skeleton`).toString(36)
  const sf = hashString(`${scope}|surface|${variantIndex}`).toString(36)
  const pr = hashString(`${scope}|prose|${variantIndex}`).toString(36)
  return {
    seed,
    variantIndex,
    skeletonSeed: `${seed}-${material ? 'm' : 'sk'}-${sk}`,
    surfaceSeed: `${seed}-${material ? 'ms' : 'sf'}-${variantIndex}-${sf}`,
    proseSeed: `${seed}-${material ? 'mp' : 'pr'}-${variantIndex}-${pr}`,
  }
}

const cleanStringList = (value: unknown, max: number) => {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value) {
    const s = String(raw ?? '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

/**
 * 清洗存进 `articles.story_combo` 的 JSON。
 * 旧版只有 `length / idea / materials` 也能原样读；新版的 seed / variantIndex /
 * lastResolved 会保留，但 lastResolved 永远只是展示字段，不参与选择。
 */
export function normalizeCombo(input: unknown): StoryCombo {
  const raw = input && typeof input === 'object' ? (input as any) : {}
  const out: StoryCombo = {}
  for (const d of DIMENSIONS) {
    const picked = cleanStringList(raw[d.key], d.max)
    if (picked.length) out[d.key] = picked
  }
  const rawLength = Number(raw.length)
  out.length = LENGTHS.has(rawLength) ? rawLength : 1500
  const idea = String(raw.idea ?? '').trim().slice(0, 800)
  const materials = String(raw.materials ?? '').trim().slice(0, MAX_MATERIAL_CHARS)
  const materialsList = normalizeMaterialList(raw.materialsList)
  const skill = String(raw.skill ?? '').trim().slice(0, 24)
  if (idea) out.idea = idea
  if (materials) out.materials = materials
  if (materialsList.some(Boolean)) {
    out.materialsList = materialsList
    // 旧代码只读 `materials`：第一篇有素材时保持这个字段可用。
    if (!materials && materialsList[0]) out.materials = materialsList[0]
  }
  if (skill) out.skill = skill
  const seed = String(raw.seed ?? '').trim().slice(0, 80)
  if (seed) out.seed = seed
  if (raw.variantIndex !== undefined && raw.variantIndex !== null) {
    out.variantIndex = clampVariantIndex(raw.variantIndex)
  }
  if (raw.lastResolved && typeof raw.lastResolved === 'object') {
    out.lastResolved = raw.lastResolved
  }
  return out
}

/** 不带随机、只把用户选中的合法标签整理出来；给「历史展示」/测试用 */
export function normalizePickedNames(input: unknown): Partial<Record<DimensionKey, string[]>> {
  const combo = normalizeCombo(input)
  const out: Partial<Record<DimensionKey, string[]>> = {}
  for (const d of DIMENSIONS) {
    const picked = combo[d.key]
    if (picked?.length) out[d.key] = picked.slice(0, d.max)
  }
  return out
}

/**
 * 未选维度每次都重新抽，不读上一篇的 `lastResolved`。
 * `rng` 可注入，测试里就能固定随机结果。
 */
export function resolveComboTags(input: {
  combo: unknown
  tagsByDimension: ComboTagMap
  rng?: () => number
  /**
   * 未选维度要不要随机补全。
   * 有参考素材时传 false：此时情节由素材决定，随机标签只会把人物关系 / 事件 / 结局
   * 往另一条路上拽。手动选中的标签仍然保留（它们只影响文风、人称等表层）。
   */
  randomFill?: boolean
}): ResolveComboResult {
  const normalized = normalizeCombo(input.combo)
  const rng = input.rng || Math.random
  const randomFill = input.randomFill !== false
  const pickedNames: Partial<Record<DimensionKey, string[]>> = {}
  const tagsByDimension: ComboTagMap = {}
  const randomFilled: DimensionKey[] = []
  const warnings: string[] = []

  for (const d of DIMENSIONS) {
    const pool = (input.tagsByDimension[d.key] || []).filter((t) => t && t.is_active !== false)
    const wanted = normalized[d.key] || []
    const valid = wanted
      .map((name) => pool.find((t) => t.name === name))
      .filter(Boolean) as StoryTag[]

    const missing = wanted.filter((name) => !valid.some((t) => t.name === name))
    if (missing.length) warnings.push(`标签库里找不到「${missing.join('、')}」，已跳过`)

    let picked = valid.slice(0, d.max)
    if (!picked.length && pool.length && randomFill) {
      // 1 个还是 2 个也随机：站长没选，就别替他固定成「每次都只抽一个」
      const count = d.max > 1 && rng() < 0.35 ? d.max : 1
      picked = seededShuffle(pool, rng).slice(0, count)
      randomFilled.push(d.key)
    }

    if (picked.length) {
      pickedNames[d.key] = picked.map((t) => t.name)
      tagsByDimension[d.key] = picked
    }
  }

  const combo: StoryCombo = { length: normalized.length || 1500 }
  if (normalized.idea) combo.idea = normalized.idea
  if (normalized.materials) combo.materials = normalized.materials
  if (normalized.materialsList?.length) combo.materialsList = normalized.materialsList
  if (normalized.skill) combo.skill = normalized.skill
  if (normalized.seed) combo.seed = normalized.seed
  if (normalized.variantIndex !== undefined) combo.variantIndex = normalized.variantIndex
  for (const d of DIMENSIONS) {
    if (pickedNames[d.key]?.length) combo[d.key] = pickedNames[d.key]
  }

  if (randomFilled.length) {
    const names = randomFilled
      .map((key) => `${DIMENSIONS.find((d) => d.key === key)?.label || key} ${pickedNames[key]?.join('＋')}`)
      .filter(Boolean)
    if (names.length) warnings.push(`这次没选的维度已随机补全：${names.join(' · ')}`)
  }

  return { combo, tagsByDimension, pickedNames, randomFilled, warnings }
}

/** 给「常用配方 / 去重」用的稳定键：只含真正影响写法的字段 */
export function comboKey(input: unknown) {
  const combo = normalizeCombo(input)
  const dims = DIMENSIONS.map((d) => `${d.key}:${(combo[d.key] || []).slice().sort().join('+')}`).join('|')
  return `${dims}|len:${combo.length || 1500}|skill:${combo.skill || ''}`
}

/** 未选写法时从 A–F 里随机抽一个；不再默认 A */
export function pickRandomSkill(skills: StorySkill[], rng: () => number = Math.random): StorySkill | null {
  const usable = (skills || []).filter((s) => s && s.code && s.is_active !== false)
  if (!usable.length) return null
  return seededPick(usable, rng) || null
}

/** 把「实际用了什么」压成一行，给 lastResolved / toast 用 */
export function describeResolved(input: {
  pickedNames: Partial<Record<DimensionKey, string[]>>
  skill?: { code: string; name?: string } | null
  seed?: string
}) {
  const dims = DIMENSIONS.filter((d) => (input.pickedNames[d.key] || []).length)
    .map((d) => `${d.label} ${(input.pickedNames[d.key] || []).join('＋')}`)
    .join(' · ')
  const skill = input.skill?.code ? `写法 ${input.skill.code}` : ''
  const seed = input.seed ? `Seed ${input.seed}` : ''
  return [dims, skill, seed].filter(Boolean).join(' · ')
}

