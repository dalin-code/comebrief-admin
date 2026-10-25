/**
 * P4 骨架层（Skeleton）：先定「发生什么」，再让表皮层决定「谁、在哪、什么时候」。
 *
 * 两段式的意义：
 *   · Skeleton 只允许写功能、节拍、冲突、反转机制、结局类型，**禁止具体人名地名**；
 *   · Surface 用 seed 确定性填人名/地点/时间/物件；
 *   · Writer 按节拍逐段写，每段都有硬边界，不能提前写后面的真相。
 *
 * 同 Seed 复现的是「骨架 + 决策路径」，不是逐字原文。逐字原文由 source_article_id
 * 克隆文章解决，不靠模型记忆。
 */
import { deriveSeeds, hashString, seededPick, seededRandom } from './storySelection'
import { findIdentityLeaks, surfaceFromSeed, type StorySurface, type SurfaceIdentity } from './storyIdentity'
import type { DimensionKey, StoryTag } from './storyPrompt'

export type StoryStateDelta = 'none' | 'additive' | 'breaking'

export type StoryBeat = {
  id: string
  /** 这一段在故事里干什么（建立日常 / 触发 / 试探 / 代价升级 / 揭示 / 结局） */
  function: string
  /** 主角这一段的主动目标 */
  goal: string
  /** 挡在目标前面的具体阻力 */
  obstacle: string
  /** 这一段结束时发生的不可逆变化 */
  turn: string
  /** 本段才允许揭晓的信息；没有就留空 */
  reveal: string
  /** 对后续情节的影响：none 不改 / additive 追加 / breaking 推翻 */
  stateDelta: StoryStateDelta
  targetChars: number
  softMaxChars: number
  hardMaxChars: number
  /** 本段禁止提前写出的后续揭示 */
  forbiddenReveals: string[]
  /** 越界时怎么收 */
  cutRule: string
}

export type StorySkeleton = {
  version: 2
  seed: string
  skeletonSeed: string
  titleAngle: string
  premise: string
  conflictType: string
  twistMechanism: string
  endingType: string
  relationshipRoles: string[]
  beats: StoryBeat[]
  endingImage: string
  endingSignal: string
  targetChars: number
  skeletonHash: string
}

export type StoryPlan = {
  skeleton: StorySkeleton
  surface: StorySurface
  seeds: ReturnType<typeof deriveSeeds>
  fingerprint: string
}

const STATE_DELTAS: StoryStateDelta[] = ['none', 'additive', 'breaking']
const asText = (value: unknown, max = 240) => String(value ?? '').trim().slice(0, max)

export const normalizeStateDelta = (value: unknown, fallback: StoryStateDelta): StoryStateDelta => {
  const s = String(value ?? '').trim().toLowerCase() as StoryStateDelta
  return STATE_DELTAS.includes(s) ? s : fallback
}

/** 骨架指纹只包含「故事逻辑」，不含人名/地点/时间/物件，也不含正文 */
export function skeletonHash(input: Omit<StorySkeleton, 'skeletonHash'> | StorySkeleton) {
  const payload = {
    version: 2,
    titleAngle: input.titleAngle,
    premise: input.premise,
    conflictType: input.conflictType,
    twistMechanism: input.twistMechanism,
    endingType: input.endingType,
    relationshipRoles: input.relationshipRoles,
    endingImage: input.endingImage,
    endingSignal: input.endingSignal,
    targetChars: input.targetChars,
    beats: input.beats.map((b) => ({
      id: b.id,
      function: b.function,
      goal: b.goal,
      obstacle: b.obstacle,
      turn: b.turn,
      reveal: b.reveal,
      stateDelta: b.stateDelta,
    })),
  }
  return hashString(JSON.stringify(payload)).toString(36)
}

const distribute = (total: number, count: number) => {
  const base = Math.floor(total / count)
  let left = total - base * count
  return Array.from({ length: count }, () => {
    const n = base + (left > 0 ? 1 : 0)
    if (left > 0) left -= 1
    return n
  })
}

const cutRuleFor = (isFinal: boolean) =>
  isFinal
    ? '写完「结局画面」的最后一下动作就停；不要总结、不要升华、不要补一段解释意义。'
    : '写完本段最后一个动作 / 信息就停；不要预告下一段，不要提前解释真相。'

const defaultRoles = ['主角', '对手', '关键关系人']

type RawSkeleton = Partial<Omit<StorySkeleton, 'version' | 'beats' | 'skeletonHash'>> & {
  beats?: Array<Partial<StoryBeat>>
}

/** 把模型 / 本地兜底的原始骨架收成统一结构，并算好每段硬边界 */
function finishSkeleton(
  raw: RawSkeleton,
  opts: { seed: string; length: number; idea?: string; materials?: string }
): StorySkeleton {
  const targetChars = [800, 1500, 2500].includes(Number(opts.length)) ? Number(opts.length) : 1500
  const rawBeats = (Array.isArray(raw.beats) ? raw.beats : []).slice(0, 6)
  const beatsRaw = rawBeats.length >= 4 ? rawBeats : makeFallbackBeats(opts.seed)
  const count = beatsRaw.length
  const targets = distribute(targetChars, count)

  const beats: StoryBeat[] = beatsRaw.map((b, i) => {
    const isFinal = i === count - 1
    const laterReveals = beatsRaw
      .slice(i + 1)
      .map((x) => asText(x.reveal, 120))
      .filter(Boolean)
    return {
      id: asText(b.id, 12) || `B${i + 1}`,
      function: asText(b.function, 80) || (isFinal ? '结局落地' : `推进第 ${i + 1} 步`),
      goal: asText(b.goal, 160) || '主角想解决眼前这件具体的事',
      obstacle: asText(b.obstacle, 160) || '有人 / 某件东西不让它顺利解决',
      turn: asText(b.turn, 200) || '事情没有按主角预期发展',
      reveal: asText(b.reveal, 180),
      stateDelta: normalizeStateDelta(b.stateDelta, isFinal ? 'breaking' : i === 0 ? 'none' : 'additive'),
      targetChars: targets[i],
      softMaxChars: Math.round(targets[i] * 1.15),
      hardMaxChars: Math.round(targets[i] * 1.35),
      forbiddenReveals: laterReveals.length
        ? laterReveals.slice(0, 4)
        : isFinal
          ? []
          : ['真相与结局'],
      cutRule: cutRuleFor(isFinal),
    }
  })

  // 最后一段必须是 breaking：否则读者会觉得故事没落地
  beats[beats.length - 1].stateDelta = 'breaking'

  let roles = (Array.isArray(raw.relationshipRoles) ? raw.relationshipRoles : defaultRoles)
    .map((x) => asText(x, 40))
    .filter(Boolean)
    .slice(0, 4)
  if (!roles.length) roles = [...defaultRoles]

  const skeleton: StorySkeleton = {
    version: 2,
    seed: opts.seed,
    skeletonSeed: deriveSeeds(opts.seed, 0, opts.materials).skeletonSeed,
    titleAngle: asText(raw.titleAngle, 120) || '标题落在一个具体物件或动作上',
    premise: asText(raw.premise, 500) || asText(opts.idea, 500) || '一个普通人被一件小事逼到必须做出选择',
    conflictType: asText(raw.conflictType, 160) || '一件旧事被迫重新处理',
    twistMechanism: asText(raw.twistMechanism, 180) || '主角以为自己在追查别人，最后发现证据指向自己',
    endingType: asText(raw.endingType, 120) || '留白式收束',
    relationshipRoles: roles,
    beats,
    endingImage: asText(raw.endingImage, 200) || '一个没有被关上的门，和门外逐渐远去的脚步声',
    endingSignal: asText(raw.endingSignal, 120) || '最后一个动作完成，故事停在一个画面上',
    targetChars,
    skeletonHash: '',
  }
  skeleton.skeletonHash = skeletonHash(skeleton)
  return skeleton
}

const FALLBACK_FUNCTIONS = ['建立日常与缺口', '触发事件', '第一次试探与受阻', '代价升级', '真相逼近', '结局落地']
const FALLBACK_CONFLICTS = [
  '一件本该结束的旧事重新找上门',
  '一个必须今天交出去的东西不见了',
  '一句不该说出口的话被人听见',
  '一个多年不见的人突然出现',
]
const FALLBACK_TWISTS = [
  '主角以为在帮别人，其实在替自己收尾',
  '证据从头到尾都在主角手里，只是他不敢看',
  '对手并不是威胁，真正的问题在主角的隐瞒',
  '反转不改变事实，只改变主角对事实的解释',
]
const FALLBACK_ENDINGS = ['留白式收束', '代价式收束', '反讽式收束', '安静的闭环']
const FALLBACK_IMAGES = ['桌上一杯已经凉透的水', '门缝里漏出的一条光', '站台上开走的末班车', '被放回原处却没有关严的抽屉']

function makeFallbackBeats(seed: string): Array<Partial<StoryBeat>> {
  const rng = seededRandom(deriveSeeds(seed, 0).skeletonSeed)
  const conflict = seededPick(FALLBACK_CONFLICTS, rng) || FALLBACK_CONFLICTS[0]
  const twist = seededPick(FALLBACK_TWISTS, rng) || FALLBACK_TWISTS[0]
  return FALLBACK_FUNCTIONS.map((fn, i) => {
    const isFinal = i === FALLBACK_FUNCTIONS.length - 1
    return {
      id: `B${i + 1}`,
      function: fn,
      goal:
        i === 0
          ? '把今天过完，不让别人看出异样'
          : isFinal
            ? '把这件事处理完，回到日常'
            : '把眼前这个具体问题解决掉',
      obstacle: conflict,
      turn:
        i === 0
          ? '一个不该出现的细节打破了日常'
          : isFinal
            ? `${twist}，主角做出最后的选择`
            : '每解决一步，代价就多一层',
      reveal: i >= 3 ? twist : '',
      stateDelta: isFinal ? 'breaking' : i === 0 ? 'none' : 'additive',
    }
  })
}

/** 模型 JSON 解析失败 / 返回空时，本地也要给出一副能写的骨架 */
export function fallbackSkeleton(opts: { seed: string; length: number; idea?: string; materials?: string }) {
  const rng = seededRandom(deriveSeeds(opts.seed, 0, opts.materials).skeletonSeed)
  return finishSkeleton(
    {
      premise: opts.idea || '一个普通人被一件小事逼到必须做出选择',
      conflictType: seededPick(FALLBACK_CONFLICTS, rng) || FALLBACK_CONFLICTS[0],
      twistMechanism: seededPick(FALLBACK_TWISTS, rng) || FALLBACK_TWISTS[0],
      endingType: seededPick(FALLBACK_ENDINGS, rng) || FALLBACK_ENDINGS[0],
      endingImage: seededPick(FALLBACK_IMAGES, rng) || FALLBACK_IMAGES[0],
      relationshipRoles: defaultRoles,
    },
    opts
  )
}

/** 从 DB / 前端传回来的骨架统一收口；不合格就用本地兜底，不让流水线断掉 */
export function normalizeSkeleton(
  input: unknown,
  opts: { seed: string; length: number; idea?: string; materials?: string }
): StorySkeleton {
  const raw = input && typeof input === 'object' ? (input as RawSkeleton) : null
  if (raw && Array.isArray(raw.beats) && raw.beats.length >= 4) return finishSkeleton(raw, opts)
  return fallbackSkeleton(opts)
}

const extractJson = (text: string) => {
  const s = String(text || '')
    .replace(/^\s*```[a-zA-Z]*[ \t]*\r?\n/, '')
    .replace(/\r?\n?```\s*$/, '')
    .trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(s.slice(start, end + 1))
  } catch {
    return null
  }
}

/** 解析骨架 JSON；解析失败不抛错，交给本地兜底并带一句 warning */
export function parseSkeleton(
  raw: string,
  opts: { seed: string; length: number; idea?: string; materials?: string }
): { skeleton: StorySkeleton; warnings: string[] } {
  const parsed = extractJson(raw)
  if (!parsed) {
    return { skeleton: fallbackSkeleton(opts), warnings: ['骨架模型没有返回合法 JSON，已用本地兜底骨架'] }
  }
  const source = parsed.skeleton && typeof parsed.skeleton === 'object' ? parsed.skeleton : parsed
  const skeleton = normalizeSkeleton(source, opts)
  return { skeleton, warnings: validateSkeleton(skeleton) }
}

const skeletonText = (skeleton: StorySkeleton) =>
  [
    skeleton.titleAngle,
    skeleton.premise,
    skeleton.conflictType,
    skeleton.twistMechanism,
    skeleton.endingType,
    skeleton.endingImage,
    skeleton.endingSignal,
    ...skeleton.relationshipRoles,
    ...skeleton.beats.flatMap((b) => [b.function, b.goal, b.obstacle, b.turn, b.reveal]),
  ].join('\n')

/** 硬校验：骨架里出现具体人名/地名 = 「同 Seed 换人物」不成立 */
export function validateSkeleton(skeleton: StorySkeleton) {
  const warnings: string[] = []
  if (skeleton.beats.length < 4 || skeleton.beats.length > 6) {
    warnings.push(`骨架节拍数 ${skeleton.beats.length} 不在 4–6 之间`)
  }
  if (skeleton.beats[skeleton.beats.length - 1]?.stateDelta !== 'breaking') {
    warnings.push('骨架最后一段不是 breaking，结局可能立不住')
  }
  const leaks = findIdentityLeaks(skeletonText(skeleton))
  if (leaks.length) warnings.push(`骨架里出现了具体人名/地名：${leaks.join('、')}（会破坏同 Seed 换人物）`)
  // 英文专名（Noah / Portland 这类）也不该出现在骨架层
  const latinNames = skeletonText(skeleton).match(/\b[A-Z][a-z]{2,}\b/g) || []
  const allow = new Set(['JSON', 'Seed', 'breaking', 'additive', 'none'])
  const badLatin = Array.from(new Set(latinNames.filter((x) => !allow.has(x))))
  if (badLatin.length) warnings.push(`骨架里出现了英文专名：${badLatin.slice(0, 6).join('、')}`)
  return warnings
}

/** 骨架 + 表皮 = 可交给 Writer 的完整计划 */
export function mergePlan(skeleton: StorySkeleton, surface: StorySurface, seeds = deriveSeeds(skeleton.seed, 0)): StoryPlan {
  return { skeleton, surface, seeds, fingerprint: surface.fingerprint }
}

export function surfaceForSkeleton(
  skeleton: StorySkeleton,
  seed: string,
  variantIndex: number,
  forbiddenIdentities?: SurfaceIdentity[]
) {
  return surfaceFromSeed({ seed, variantIndex, skeleton, forbiddenIdentities })
}

const SKELETON_SYSTEM = [
  '你是一位短篇小说的结构规划师，不写正文。',
  '你的任务是把站长的构思拆成 4–6 个节拍，只规划「发生什么、为什么发生、这一段改变了什么」。',
  '',
  '【绝对禁止】',
  '- 禁止出现任何具体人名、地名、机构名、品牌名、年代（例如「诺亚」「波特兰」「1999 年」）。',
  '- 用「主角 / 对手 / 关键关系人 / 某个地方 / 一件东西」指代。',
  '- 禁止写对白、禁止写正文、禁止写比喻。',
  '- 禁止在前期节拍里提前写出后期才该揭晓的真相。',
  '',
  '【每个节拍必须有】',
  '- function：这一段在故事里干什么（建立日常 / 触发 / 试探 / 代价升级 / 揭示 / 结局）',
  '- goal：主角这一段主动想完成的具体目标',
  '- obstacle：挡在目标前面的具体阻力（必须是一个动作、一个人或一件东西）',
  '- turn：这一段结束时发生的不可逆变化',
  '- reveal：本段才允许揭晓的信息；没有就留空',
  '- stateDelta：none（没改变）/ additive（追加信息）/ breaking（推翻前文或改变方向）',
  '',
  '【结局】',
  '- 最后一段必须是 breaking，并且落在一个可拍摄的画面（endingImage）上。',
  '- endingSignal 用一句话写「读者看到什么就知道故事结束了」，不要写道理。',
  '',
  '【输出】',
  '只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释。',
  '{"titleAngle":"标题角度","premise":"一句话故事","conflictType":"冲突类型","twistMechanism":"反转机制","endingType":"结局类型","relationshipRoles":["主角","对手","关键关系人"],"beats":[{"id":"B1","function":"","goal":"","obstacle":"","turn":"","reveal":"","stateDelta":"none"}],"endingImage":"","endingSignal":""}',
].join('\n')

export function buildSkeletonSystemPrompt() {
  return SKELETON_SYSTEM
}

const renderTags = (tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>>) => {
  const lines: string[] = []
  for (const [key, tags] of Object.entries(tagsByDimension) as Array<[DimensionKey, StoryTag[]]>) {
    if (!tags?.length) continue
    lines.push(`【${key}】${tags.map((t) => `${t.name}：${t.summary || ''}`).join('；')}`)
  }
  return lines.join('\n')
}

export function buildSkeletonUserPrompt(input: {
  tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>>
  idea: string
  materials: string
  length: number
  avoidTitles?: string[]
  seed: string
}) {
  const material = String(input.materials || '').trim().slice(0, 4000)
  const avoid = (input.avoidTitles || []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12)
  const ideaText = String(input.idea || '').trim()

  const parts: string[] = []
  if (material) {
    // 素材优先：底本是故事逻辑的唯一来源，标签/构思只决定怎么讲
    parts.push(
      '【改编底本（这是这一篇的情节主干，必须照它拆节拍）】',
      '先通读底本，把它的核心冲突、人物关系、关键事件、因果、反转与结局方向拆成 4–6 个节拍。',
      '标签和构思只决定叙述方式（文风 / 视角 / 节奏），不得替换底本的人物关系、事件、因果或结局。',
      '人物一律写成「主角 / 对手 / 关键关系人」，地点一律写「某个地方」，不许照抄底本里的人名地名。',
      material,
      '',
      '【本次的标签设定（只影响文风 / 人称 / 节奏等表层，不得改变上面的改编底本）】',
      renderTags(input.tagsByDimension) || '（没有额外标签：按底本自行决定叙述方式，情节照底本。）',
      '',
      '【站长的构思（优先于底本；为空则完全按底本）】',
      ideaText || '（没有额外构思，按底本的情节主干拆节拍）'
    )
  } else {
    parts.push(
      '【本次的标签设定】',
      renderTags(input.tagsByDimension) || '（没有指定，按故事需要自行取舍）',
      '',
      '【站长的构思】',
      ideaText || '（没有额外构思，按标签写一个具体的故事）'
    )
  }
  if (avoid.length) {
    parts.push(
      '',
      material
        ? '【往期标题（只要求底本没写到的部分和它们不同，不许为了求新改掉底本情节）】'
        : '【往期标题（这次的故事逻辑要和它们不同）】',
      avoid.map((x) => `《${x}》`).join('、')
    )
  }
  parts.push(
    '',
    material
      ? `【篇幅】目标 ${input.length} 字（素材优先：写满，把底本的因果与结局完整走完），按 4–6 段分配；每段只承担一个功能。`
      : `【篇幅】目标 ${input.length} 字，按 4–6 段分配；每段只承担一个功能。`,
    `【Seed】${input.seed}（只用于复现，不要写进故事）`,
    '',
    '再次强调：只输出 JSON 骨架，不写人名、地名、对白和正文。'
  )
  return parts.join('\n')
}



