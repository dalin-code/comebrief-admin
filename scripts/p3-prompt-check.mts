#!/usr/bin/env node
/**
 * P3 提示词自检（不花额度：全是纯函数，一次模型都不调）。
 *
 * 这一轮修的是同一个病根的两个出口 —— 「参考素材」以前只是氛围素材，不是情节主干：
 *   · 生成：素材那段的旧措辞是「可参考的素材（用来获取细节和真实感，不要照抄句子）」，
 *     再撞上「对抗同质化」和「往期标题必须明显不同」两段，模型自然回去写自己那一套
 *     ——「不管给什么参考，写的故事基本上都是一个」就是这么来的；
 *   · 改稿：前端压根不传 idea / materials，站长写「主要情节参考我给的材料」时，
 *     模型手里根本没有那份材料，只能猜着改，改完还是原来那一套。
 *
 * 这个脚本把两条路都钉住：以后谁再改这几处措辞、或者前端又漏传字段，
 * 这里会先红 —— 不用等花额度跑一篇才发现素材被当成空气。
 *
 * 用法：node --import ./scripts/_ts-resolve.mts scripts/p3-prompt-check.mts
 */
import { buildContinueUserPrompt, buildStoryUserPrompt, type StoryTag } from '../lib/storyPrompt.ts'
import { buildRewriteSystemPrompt, buildRewriteUserPrompt, detectPlotLevelRequest } from '../lib/storyRewrite.ts'
import { MATERIAL_FIRST_LENGTH } from '../lib/storySelection.ts'
import { buildSkeletonUserPrompt } from '../lib/storyPlan.ts'

let failed = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` —— ${extra}` : ''}`)
  if (!cond) failed += 1
}

const tag = (dimension: StoryTag['dimension'], name: string, summary: string): StoryTag => ({
  id: name,
  dimension,
  name,
  summary,
  example: '',
  usage_note: '',
  sort_order: 1,
  is_active: true,
})

const tagsByDimension = {
  genre: [tag('genre', '都市悬疑', '发生在城市里的悬念故事')],
  pov: [tag('pov', '第一人称', '用「我」来讲，读者只知道我知道的事')],
}

/** 站长的「泡影」那类素材：一整篇梗概，不是一句氛围细节 */
const MATERIAL =
  '我叫贺牧。权穆失踪后的第七天，我在他租住的公寓里找到一只铁盒，里面全是同一个女孩的照片，每张背后都写着同一个日期。'
const IDEA = '背景放欧美，人物名字换成英文音译。'
const ADAPT_HEADER = '【改编底本（这是这一篇的情节主干，必须照它写）】'

/* 1. 生成那遍：有素材 = 有情节主干 */
const generated = buildStoryUserPrompt({
  combo: {},
  tagsByDimension,
  idea: IDEA,
  materials: MATERIAL,
  length: MATERIAL_FIRST_LENGTH,
})
check('1a 素材被标成「改编底本」', generated.includes(ADAPT_HEADER))
check('1b 素材原文整段进了提示词', generated.includes(MATERIAL))
check(
  '1c 有「冲突时的优先级」收口，标签/写法被压到表层',
  generated.includes(
    '【冲突时的优先级】站长的构思 > 改编底本的情节主干 > 标签 / 写法（只影响表层）'
  )
)
check('1d 构思那节写明优先于改编底本', generated.includes('【本篇构思（站长的总体要求，优先于改编底本）】'))
check('1e 写明只补细节、不许另起一个故事', generated.includes('不许另起一个故事'))
check('1f 仍要求换句不换事（不要整段照抄）', generated.includes('不要整段照抄'))
check(
  '1h 素材优先：标签被明确降级为表层',
  generated.includes('【本次的标签设定（只影响文风 / 人称 / 节奏等表层，不得改变下面的改编底本）】')
)
check(
  '1i 素材优先：篇幅固定 2500 并要求写完整',
  generated.includes(`【篇幅】${MATERIAL_FIRST_LENGTH} 字左右`)
    && generated.includes('素材优先：必须写满，把底本的因果与结局完整走完')
)

const materialAt = generated.indexOf(ADAPT_HEADER)
const priorityAt = generated.indexOf('【冲突时的优先级】')
const lengthAt = generated.indexOf('【篇幅】')
check(
  '1g 顺序：改编底本 → 冲突优先级 → 篇幅（越靠后模型越当回事）',
  materialAt > 0 && priorityAt > materialAt && lengthAt > priorityAt,
  `${materialAt},${priorityAt},${lengthAt}`
)

/* 2. 没填素材时，一切照旧（P0 盲测要的「前后逐字节一致」不受影响） */
const bare = buildStoryUserPrompt({ combo: {}, tagsByDimension, idea: IDEA, materials: '', length: 1500 })
check('2a 没素材就没有改编底本那一段', !bare.includes(ADAPT_HEADER))
check('2b 没素材就没有冲突优先级那一段', !bare.includes('【冲突时的优先级】'))

// 构思和素材都空着时，兜底文案必须还是旧那句（自由创作），不能被素材分支串味
const bareNoIdea = buildStoryUserPrompt({ combo: {}, tagsByDimension, idea: '', materials: '', length: 1500 })
check('2c 构思与素材都空 → 仍是原来的自由创作兜底', bareNoIdea.includes('请围绕上面选定的题材自行设计一个具体、可信、有画面的故事'))

/* 3. 构思为空 + 有素材时，兜底文案也得跟着改（否则等于叫模型自己另编一个） */
const noIdea = buildStoryUserPrompt({
  combo: {},
  tagsByDimension,
  idea: '',
  materials: MATERIAL,
  length: MATERIAL_FIRST_LENGTH,
})
check('3a 有素材但没构思 → 兜底是「围绕下面的改编底本写」', noIdea.includes('围绕下面的改编底本写'))
check('3b 此时不该出现「自行设计一个」', !noIdea.includes('自行设计一个'))

/* 4. 「和往期不同」必须给素材让路 —— 这两条指令本来是会打架的 */
const withTitles = buildStoryUserPrompt({
  combo: {},
  tagsByDimension,
  idea: IDEA,
  materials: MATERIAL,
  length: MATERIAL_FIRST_LENGTH,
  avoidTitles: ['雨夜的电话', '旧照片'],
})
check('4a 有素材时，往期标题那节加了豁免说明', withTitles.includes('有改编底本时，这一条只在素材没写到的部分生效'))
check('4b 往期标题本身还在（只让路，不删除）', withTitles.includes('《雨夜的电话》') && withTitles.includes('《旧照片》'))

const titlesOnly = buildStoryUserPrompt({
  combo: {},
  tagsByDimension,
  idea: IDEA,
  materials: '',
  length: 1500,
  avoidTitles: ['雨夜的电话'],
})
check('4c 没素材时不加豁免说明', !titlesOnly.includes('有改编底本时，这一条只在素材没写到的部分生效'))
check('4d 没素材时往期标题照旧要求必须不同', titlesOnly.includes('请换一套开场方式'))

/* 5. 续写也要带素材，否则「接着写下去」会把故事拐回模型默认的那一套 */
const cont = buildContinueUserPrompt({
  tagsByDimension,
  idea: IDEA,
  materials: MATERIAL,
  tailText: '他把铁盒塞回床底。',
  remainingWords: 600,
})
check('5a 续写带上了改编底本', cont.includes('【改编底本（续写不许偏离它的情节）】') && cont.includes(MATERIAL))
const contNoMaterial = buildContinueUserPrompt({
  tagsByDimension,
  idea: IDEA,
  tailText: '他把铁盒塞回床底。',
  remainingWords: 600,
})
check('5b 不传素材时续写提示词与旧版一致', !contNoMaterial.includes('改编底本'))

/* 6. 改稿那遍：构思与素材真的进提示词，且站长的情节级要求能压过契约 */
const rewrite = buildRewriteUserPrompt({
  title: '铁盒',
  excerpt: '七天前他失踪了。',
  bodyText: '他把烟按灭在窗台上。'.repeat(20),
  issues: [],
  notes: '开篇场景不对，主要情节参考我给的材料',
  idea: IDEA,
  materials: MATERIAL,
})
check('6a 改稿提示词带上了本篇构思', rewrite.includes('【本篇构思】') && rewrite.includes(IDEA))
check('6b 改稿提示词带上了参考素材', rewrite.includes('【参考素材 / 改编底本（站长要求按它改时，以它的情节为准）】'))
check('6c 素材原文没被截断地塞进去了', rewrite.includes(MATERIAL))
check('6d 照办要求第 4 条说明它优先于契约第 1 条', rewrite.includes('这一条优先于改稿契约第 1 条'))
check('6e 情节级要求下的最后提醒跟着松口', rewrite.includes('这一遍站长提了情节级要求'))
check('6f 改稿契约里写了例外段（第 1、3、4 条可被解除）', buildRewriteSystemPrompt(null).includes('第 1、3、4 条不再适用'))

// 旧调用（p3-pipeline-smoke 就不传这两个字段）必须与原版一致：不多出任何一节
const rewriteLegacy = buildRewriteUserPrompt({
  title: '铁盒',
  bodyText: '他把烟按灭在窗台上。'.repeat(20),
  excerpt: '',
  issues: [],
  notes: '',
})
check('6g 不传构思/素材时，这两节完全不出现', !rewriteLegacy.includes('【本篇构思】') && !rewriteLegacy.includes('【参考素材'))
check(
  '6h 只改口气的 notes 不会触发情节级提醒',
  rewriteLegacy.includes('【最后提醒】没被点名的句子一律原样保留')
    && !buildRewriteUserPrompt({
      title: '铁盒',
      bodyText: '他把烟按灭在窗台上。'.repeat(20),
      issues: [],
      notes: '第三段那个比喻太老套',
    }).includes('这一遍站长提了情节级要求')
)

/* 7. detectPlotLevelRequest：宁宽勿窄，但「调口气」不能误判成「改情节」 */
const plotCases: Array<[string, boolean]> = [
  ['开篇场景不对，主要情节参考我给的参考素材', true],
  ['把结局改成她没杀他', true],
  ['整体重写一遍', true],
  ['结尾再冷一点', false],
  ['主角的口吻再冷一点', false],
  ['第三段那个比喻太老套', false],
  ['', false],
]
for (const [notes, want] of plotCases) {
  const got = detectPlotLevelRequest(notes)
  check(`7 ${want ? '情节级' : '句子级'} ←「${notes}」`, got === want, got === want ? '' : `期望 ${want}，实得 ${got}`)
}

/* 8. 骨架那遍：底本先拆节拍，标签/构思只决定怎么讲；篇幅固定 2500 */
const skeleton = buildSkeletonUserPrompt({
  tagsByDimension,
  idea: IDEA,
  materials: MATERIAL,
  length: MATERIAL_FIRST_LENGTH,
  seed: 'story-2026',
})
const materialAt2 = skeleton.indexOf('【改编底本（这是这一篇的情节主干，必须照它拆节拍）】')
const tagsAt2 = skeleton.indexOf('【本次的标签设定（只影响文风 / 人称 / 节奏等表层，不得改变上面的改编底本）】')
check('8a 骨架提示词以改编底本开头', materialAt2 === 0, `materialAt=${materialAt2}`)
check('8b 标签节排在底本之后（底本优先拆节拍）', materialAt2 >= 0 && tagsAt2 > materialAt2)
check('8c 骨架提示词要求按底本的事件/因果/结局拆节拍', skeleton.includes('把它的核心冲突、人物关系、关键事件、因果、反转与结局方向拆成 4–6 个节拍'))
check(
  '8d 骨架的篇幅也是素材优先 2500（写满、把结局走完）',
  skeleton.includes(`【篇幅】目标 ${MATERIAL_FIRST_LENGTH} 字（素材优先：写满，把底本的因果与结局完整走完）`)
)

const skeletonBare = buildSkeletonUserPrompt({
  tagsByDimension,
  idea: IDEA,
  materials: '',
  length: 1500,
  seed: 'story-2026',
})
check('8e 没素材时骨架提示词仍是旧的标签 → 构思顺序', !skeletonBare.includes('改编底本')
  && skeletonBare.indexOf('【本次的标签设定】') < skeletonBare.indexOf('【站长的构思】'))
check('8f 没素材时骨架篇幅不带「素材优先」', skeletonBare.includes('【篇幅】目标 1500 字，按 4–6 段分配'))

console.log(failed ? `\n✗ ${failed} 项不通过` : '\n✓ 全部通过')
process.exit(failed ? 1 : 0)
