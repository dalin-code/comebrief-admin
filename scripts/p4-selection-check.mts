#!/usr/bin/env node
/**
 * P4 选择层自检（纯函数，不花模型额度）。
 *
 * 钉住三件事：
 *   1. 未选维度每次都随机补全，且不会把 lastResolved 当成选中；
 *   2. 同 Seed 的 skeletonSeed 稳定，surfaceSeed / proseSeed 随 variant 变化；
 *   3. 未选写法时从 A–F 随机抽，不再永远落到默认 A。
 *
 * 用法：node --import ./scripts/_ts-resolve.mts scripts/p4-selection-check.mts
 */
import {
  MATERIAL_FIRST_LENGTH,
  deriveSeeds,
  isMaterialFirst,
  normalizeCombo,
  resolveComboTags,
  pickRandomSkill,
} from '../lib/storySelection.ts'
import { DIMENSIONS, type StorySkill, type StoryTag } from '../lib/storyPrompt.ts'

let failed = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` —— ${extra}` : ''}`)
  if (!cond) failed += 1
}

const tag = (dimension: StoryTag['dimension'], name: string): StoryTag => ({
  id: `${dimension}-${name}`,
  dimension,
  name,
  summary: `${name} 的注解`,
  example: '',
  usage_note: '',
  sort_order: 1,
  is_active: true,
})

const tagsByDimension = {
  genre: [tag('genre', '都市悬疑'), tag('genre', '家庭现实')],
  era: [tag('era', '当代'), tag('era', '九十年代')],
  pov: [tag('pov', '第一人称'), tag('pov', '第三人称')],
  style: [tag('style', '白描'), tag('style', '冷幽默')],
  structure: [tag('structure', '线性'), tag('structure', '倒叙')],
  ending: [tag('ending', '反转'), tag('ending', '留白')],
  pace: [tag('pace', '快'), tag('pace', '慢')],
}

/* 1. 一个都没选 → 7 个维度全部补齐 */
const empty = resolveComboTags({ combo: { length: 1500 }, tagsByDimension, rng: () => 0.1 })
check('1a 未选标签时每个维度都有标签', DIMENSIONS.every((d) => (empty.pickedNames[d.key] || []).length > 0))
check('1b 随机补全的维度全被记录', empty.randomFilled.length === DIMENSIONS.length)
check('1c 提示词里拿到的是具体标签，不是空对象', Object.keys(empty.tagsByDimension).length === DIMENSIONS.length)

/* 1d. 素材优先：不随机补标签，但手动选的标签仍保留（只影响表层） */
const materialMode = resolveComboTags({
  combo: { genre: ['都市悬疑'], length: MATERIAL_FIRST_LENGTH },
  tagsByDimension,
  rng: () => 0.1,
  randomFill: false,
})
check('1d 素材优先时不随机补任何维度', materialMode.randomFilled.length === 0)
check(
  '1e 素材优先时只保留手动选的标签',
  Object.keys(materialMode.pickedNames).length === 1 && materialMode.pickedNames.genre?.join('') === '都市悬疑'
)
check(
  '1f 素材优先时不再提示「已随机补全」',
  !materialMode.warnings.some((w) => w.includes('随机补全'))
)

/* 1g. 素材优先判定 / 固定篇幅 */
check('1g 有素材 = 素材优先', isMaterialFirst('一段原始故事'))
check('1h 空白素材不算素材优先', !isMaterialFirst('   ') && !isMaterialFirst('') && !isMaterialFirst(null))
check('1i 素材优先固定 2500 字', MATERIAL_FIRST_LENGTH === 2500)

/* 2. 选中的维度必须原样保留，且不会再被随机补第二个 */
const manual = resolveComboTags({
  combo: { genre: ['都市悬疑'], pov: ['第一人称'], length: 800 },
  tagsByDimension,
  rng: () => 0.99,
})
check('2a 手动选的题材保留', manual.pickedNames.genre?.join('') === '都市悬疑')
check('2b 手动选的视角保留', manual.pickedNames.pov?.join('') === '第一人称')
check('2c 手动选的维度不会被随机补第二个', manual.pickedNames.genre?.length === 1)
check('2d 只有未选维度进入 randomFilled', !manual.randomFilled.includes('genre') && !manual.randomFilled.includes('pov'))

/* 3. lastResolved 只展示，不参与下一次选择 */
const withHistory = resolveComboTags({
  combo: { length: 1500, lastResolved: { combo: { genre: ['家庭现实'] } } },
  tagsByDimension,
  rng: () => 0.1,
})
check('3a lastResolved 不会变成已选标签', !withHistory.pickedNames.genre?.includes('家庭现实') || withHistory.randomFilled.includes('genre'))
check('3b lastResolved 仍被保留（供面板展示）', normalizeCombo({ lastResolved: { combo: {} } }).lastResolved !== undefined)

/* 4. 不同随机流 → 未选维度会换（不是每次同一个） */
const a = resolveComboTags({ combo: {}, tagsByDimension, rng: () => 0.01 })
const b = resolveComboTags({ combo: {}, tagsByDimension, rng: () => 0.99 })
check(
  '4a 不同随机流至少有一个维度不同',
  DIMENSIONS.some((d) => (a.pickedNames[d.key] || []).join('') !== (b.pickedNames[d.key] || []).join(''))
)

/* 5. Seed 派生：骨架不看 variant，表皮 / 正文看 variant */
const s0 = deriveSeeds('story-2026', 0)
const s0Again = deriveSeeds('story-2026', 0)
const s1 = deriveSeeds('story-2026', 1)
check('5a 同 Seed + 同 variant → 完全一致', JSON.stringify(s0) === JSON.stringify(s0Again))
check('5b 同 Seed 换 variant → skeletonSeed 不变', s0.skeletonSeed === s1.skeletonSeed)
check('5c 同 Seed 换 variant → surfaceSeed 变化', s0.surfaceSeed !== s1.surfaceSeed)
check('5d 同 Seed 换 variant → proseSeed 变化', s0.proseSeed !== s1.proseSeed)

/* 5e. 素材参与 Seed 派生：同 Seed 换素材不能复用上一份骨架 */
const MATERIAL_A = '我叫贺牧。权穆失踪后的第七天，我在他租住的公寓里找到一只铁盒。'
const MATERIAL_B = '母亲把老屋卖了。我回去收拾东西时，在墙缝里摸到一沓没寄出的信。'
const m0 = deriveSeeds('story-2026', 0, MATERIAL_A)
const m0Again = deriveSeeds('story-2026', 0, MATERIAL_A)
const m1 = deriveSeeds('story-2026', 1, MATERIAL_A)
const mB = deriveSeeds('story-2026', 0, MATERIAL_B)
const mBlank = deriveSeeds('story-2026', 0, '   ')
check('5e 同 Seed + 同素材 → 派生 Seed 完全一致', JSON.stringify(m0) === JSON.stringify(m0Again))
check('5f 同 Seed + 同素材换 variant → skeletonSeed 不变', m0.skeletonSeed === m1.skeletonSeed)
check(
  '5g 同 Seed 换素材 → skeletonSeed 变化（不能捞回上一份骨架）',
  m0.skeletonSeed !== mB.skeletonSeed && m0.surfaceSeed !== mB.surfaceSeed
)
check(
  '5h 有素材与没素材的骨架 Seed 不同（素材另开一套复现空间）',
  m0.skeletonSeed !== s0.skeletonSeed
)
check('5i 空白素材 = 没素材', mBlank.skeletonSeed === s0.skeletonSeed)

/* 6. 写法：未选时随机，不再默认 A */
const skills: StorySkill[] = ['A', 'B', 'C', 'D', 'E', 'F'].map((code) => ({
  code,
  name: `写法 ${code}`,
  summary: '',
  posture: '',
  exemplar: '',
  rules: '',
  avoid: '',
  is_active: true,
  is_default: code === 'A',
}))
const pickedB = pickRandomSkill(skills, () => 0.3)
const pickedE = pickRandomSkill(skills, () => 0.8)
check('6a 未选写法能抽到非默认写法', pickedB?.code !== 'A' || pickedE?.code !== 'A', `${pickedB?.code},${pickedE?.code}`)
check('6b 空写法库返回 null', pickRandomSkill([]) === null)

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
