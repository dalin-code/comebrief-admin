#!/usr/bin/env node
/**
 * P5 批量创作自检（纯函数，不花模型额度）。
 *
 * 钉住四件事：
 *   1. 同一个基数 Seed 派生出的 5 个 Seed 稳定、可复现，且彼此不同；
 *   2. 表皮层在给定 forbiddenIdentities 后，不会再撞人名 / 城市 / 地点 / 时间 / 物件；
 *   3. 同批 5 篇连续生成时，靠「前几篇的身份」就能把后一篇推开；
 *   4. 多篇参考素材按位置对应批量篇目，空位不会被后面的素材顶掉。
 *
 * 用法：node --import ./scripts/_ts-resolve.mts scripts/p5-batch-check.mts
 */
import {
  MAX_BATCH_STORIES,
  deriveBatchSeed,
  normalizeCombo,
  normalizeMaterialList,
} from '../lib/storySelection.ts'
import {
  normalizeSurfaceIdentities,
  surfaceConflicts,
  surfaceFromSeed,
  surfaceIdentity,
  type StorySurface,
  type SurfaceIdentity,
} from '../lib/storyIdentity.ts'

let failed = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` —— ${extra}` : ''}`)
  if (!cond) failed += 1
}

/* 1. 批量 Seed 派生 */
const seeds = Array.from({ length: MAX_BATCH_STORIES }, (_, i) => deriveBatchSeed('1001', i))
check('1a 第 0 篇沿用用户填的 Seed', seeds[0] === '1001', seeds.join(','))
check('1b 数字 Seed 逐篇 +1', seeds.join(',') === '1001,1002,1003,1004,1005', seeds.join(','))
check('1c 同一基数重复派生结果一致', JSON.stringify(seeds) === JSON.stringify(
  Array.from({ length: MAX_BATCH_STORIES }, (_, i) => deriveBatchSeed('1001', i))
))
check('1d 非数字 Seed 用 -b2/-b3 后缀', deriveBatchSeed('night-rain', 1) === 'night-rain-b2')
check('1e 越界 index 被夹到最后一篇', deriveBatchSeed('1001', 99) === '1005')

/* 2. 表皮确定性 */
const seed = 'batch-identity-seed'
const v0 = surfaceFromSeed({ seed, variantIndex: 0 })
const v0Again = surfaceFromSeed({ seed, variantIndex: 0 })
check('2a 同 Seed + 同 variant 的表皮完全一致', JSON.stringify(v0) === JSON.stringify(v0Again))

/* 3. surfaceIdentity / surfaceConflicts 抓得住撞车 */
const identity = surfaceIdentity(v0)
check('3a 身份里带主角名 / 城市 / 地点 / 时间 / 物件', Boolean(
  identity.protagonistName && identity.city && identity.place && identity.time && identity.objects.length
))
const conflict: StorySurface = { ...v0 }
check('3b 同一张表皮和自己的身份会判为冲突', surfaceConflicts(conflict, [identity]))
check('3c 换一个完全不同的身份后不冲突', !surfaceConflicts(
  {
    ...v0,
    protagonistName: '完全不存在的名字',
    antagonistName: '完全不存在的对手',
    confidantName: '完全不存在的关系人',
    city: '不存在市',
    place: '不存在地点',
    time: '不存在时间',
    objects: ['不存在物件'],
  },
  [identity]
))

/* 4. forbiddenIdentities 真的会把身份推开 */
const v1 = surfaceFromSeed({ seed: 'batch-identity-other', variantIndex: 0, forbiddenIdentities: [identity] })
check('4a 带 forbidden 生成的新表皮不与旧身份冲突', !surfaceConflicts(v1, [identity]))
check('4b 主角名被换掉', v1.protagonistName !== v0.protagonistName, `${v0.protagonistName} → ${v1.protagonistName}`)
check('4c 城市被换掉', v1.city !== v0.city, `${v0.city} → ${v1.city}`)
check('4d 地点被换掉', v1.place !== v0.place, `${v0.place} → ${v1.place}`)
check('4e 时间被换掉', v1.time !== v0.time, `${v0.time} → ${v1.time}`)
check(
  '4f 关键物件不重叠',
  !v1.objects.some((x) => v0.objects.includes(x)),
  `${v0.objects.join('/')} vs ${v1.objects.join('/')}`
)

/* 5. 连续 5 篇：每篇都把前几篇的身份作为 forbidden 传进去，应该全部避开 */
const batch: StorySurface[] = []
const accumulated: SurfaceIdentity[] = []
let firstConflictAt = -1
for (let i = 0; i < seeds.length; i += 1) {
  const next = surfaceFromSeed({
    seed: seeds[i],
    variantIndex: 0,
    forbiddenIdentities: accumulated,
  })
  if (surfaceConflicts(next, accumulated)) firstConflictAt = i
  batch.push(next)
  accumulated.push(surfaceIdentity(next))
}
check('5a 5 篇之间没有任何身份冲突', firstConflictAt === -1, firstConflictAt >= 0 ? `第 ${firstConflictAt + 1} 篇撞了` : '')
check(
  '5b 主角名 5 篇全不重复',
  new Set(batch.map((s) => s.protagonistName)).size === batch.length,
  batch.map((s) => s.protagonistName).join(' / ')
)
check(
  '5c 城市 5 篇全不重复',
  new Set(batch.map((s) => s.city)).size === batch.length,
  batch.map((s) => s.city).join(' / ')
)

/* 6. 脏 forbidden 数据被清洗，不会把生成搞崩 */
const dirty = normalizeSurfaceIdentities([
  null,
  { city: '  波特兰  ' },
  { protagonistName: '', city: '', place: '', time: '', objects: [] },
  'not-an-object',
])
check('6a 脏数据只留下真正有身份字段的那条', dirty.length === 1 && dirty[0].city === '波特兰')
const many = normalizeSurfaceIdentities(
  Array.from({ length: 30 }, (_, i) => ({ protagonistName: `名字${i}`, city: `城市${i}` }))
)
check('6b forbidden 身份最多保留 12 条', many.length === 12)

/* 7. 多篇素材：顺序对应批量篇目，空位不能把后面的素材往前挤 */
const materials = normalizeMaterialList(['  第一篇  ', '', '  第三篇  '])
check('7a 素材按位置保留空位', materials.length === 3 && materials[1] === '', JSON.stringify(materials))
check('7b 素材首尾空白被清掉', materials[0] === '第一篇' && materials[2] === '第三篇', JSON.stringify(materials))
check(
  '7c 最多保留 5 篇素材',
  normalizeMaterialList(Array.from({ length: 9 }, (_, i) => `素材${i}`)).length === MAX_BATCH_STORIES
)
check('7d 旧数据不是数组时返回空数组', normalizeMaterialList('单篇素材').length === 0)
const comboWithMaterials = normalizeCombo({
  length: 1500,
  materials: '旧字段',
  materialsList: ['第一篇', '', '第三篇'],
})
check(
  '7e normalizeCombo 保留素材列表与旧字段',
  comboWithMaterials.materials === '旧字段' &&
    JSON.stringify(comboWithMaterials.materialsList) === JSON.stringify(['第一篇', '', '第三篇'])
)
const comboFromList = normalizeCombo({ length: 1500, materialsList: ['第一篇', '第二篇'] })
check('7f 只有列表时第一篇回填到 materials', comboFromList.materials === '第一篇')

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
