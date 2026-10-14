/**
 * P3 第三遍：定向重写 —— 按评审清单改稿，而不是重新抽一次卡。
 *
 * 为什么强调「定向」：
 *   如果只是把原稿丢回去说「写得更好一点」，模型会重写全篇 —— 原来对的句子
 *   被换掉、节奏被拉平、写法被冲淡，三遍下来反而更差。
 *   所以这里的口径是：**清单没点到的句子，逐字保留**。
 *
 * 用的是第一遍同一套写作宪法（角色 + 写法 + 禁忌），所以改完不会串味。
 * 输出沿用三段式（<<<TITLE>>> / <<<EXCERPT>>> / <<<BODY>>>），
 * parseDelimitedStory 直接就能吃。
 *
 * 改稿依据有两份，合起来才叫「我和 AI 一起评的」：
 *   1. AI 自评那份清单（issues）；
 *   2. 站长自己写的评价与想法（notes）。
 *   站长的话是他的原话，可能不精确（「结尾再狠一点」），所以「定位到哪一句」交给模型；
 *   但「他点到的地方必须改到」是硬要求，两者冲突时也以他为准 —— 他是最终拍板的那个。
 */
import { buildStorySystemPrompt, type StorySkill } from './storyPrompt'
import { REVIEW_DIMENSIONS, SEVERITY_LABEL, type ReviewIssue } from './storyReview'

/** 把问题清单渲染成编号清单：模型照着改，前端也能拿去展示「这次让它改了哪几处」 */
export function describeIssues(issues: ReviewIssue[]) {
  if (!issues.length) return '（没有点名的问题）'
  return issues
    .map((issue, idx) => {
      const label = REVIEW_DIMENSIONS.find((d) => d.key === issue.dimension)?.label || issue.dimension
      return [
        `${idx + 1}. [${label} · ${SEVERITY_LABEL[issue.severity]}]`,
        issue.evidence ? `   原文：${issue.evidence}` : '',
        issue.problem ? `   问题：${issue.problem}` : '',
        issue.fix ? `   改法：${issue.fix}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')
}

const REWRITE_CONTRACT = [
  '【这一遍是改稿，不是重写】',
  '1. 默认口径：除下面点名的地方外，情节、人物、时间线、视角、结局、段落顺序 —— 一个字都不许改。',
  '2. 只改下面点名的地方（AI 清单里的，和站长自己写的意见）。两处都没点到的句子，请逐字保留（连同标点）。',
  '3. 不许为了让句子「好看」而加形容词、加氛围、加比喻；不许新增人物、场景或对话轮次；不许删段落。',
  '4. 改完的总长度与原稿相当（上下浮动别超过 15%）。',
  '5. 清单里某条你若判断改了会更差，就保持原样 —— 但不要因此去动别的句子。',
  '',
  '【例外：站长明确要求改情节时，第 1、3、4 条不再适用（以他的要求为准）】',
  '他若要求改情节 / 开篇场景 / 人物 / 结局 / 整体重来（而不是只改某几句），那就照他说的改：',
  '该动结构就动结构，该换场景就换场景，篇幅也可以跟着变大变小 —— 此时「逐字保留」只管他没有要求的那部分。',
  '',
  '【输出格式：与初稿一致的三段式，标记行原样保留】',
  '<<<TITLE>>>',
  '（标题；没有要改的就原样抄回来）',
  '<<<EXCERPT>>>',
  '（一句话摘要；原样抄回来即可）',
  '<<<BODY>>>',
  '（改好的正文；段落之间空一行，不要写任何解释、不要写「已修改」之类的说明）',
].join('\n')

/** 重写的 system = 第一遍写作宪法（角色 + 写法 + 禁忌）+ 改稿契约 */
export function buildRewriteSystemPrompt(skill?: StorySkill | null) {
  return [buildStorySystemPrompt(skill), '', REWRITE_CONTRACT].join('\n')
}

/**
 * 站长这一次是不是在提「情节级」要求（改结构 / 改开篇 / 换人物 / 改结局），
 * 而不是只改某几句的口气与用词。
 *
 * 为什么要判：契约第 1 条默认「情节一个字都不许改」，只有他明确要求时才解除
 * （见 REWRITE_CONTRACT 的例外段）。判错不会出事故，但两种误判都有代价：
 *   判成 true  → 放松了「不许增删 / 篇幅相当」两条限制，而这两条本来是为「只改几句」
 *                准备的护栏，对「我要你重写情节」只会帮倒忙；
 *   判成 false → 他明确说要改情节，模型却还在逐字保留，改完等于没改。
 * 所以关键词宁宽勿窄，只在明显是「调口气」时才压回 false（「结尾再冷一点」这种）。
 *
 * 纯函数、不依赖网络 —— scripts/p3-prompt-check.mts 直接断言。
 */
const PLOT_LEVEL_STRONG = [
  '情节',
  '剧情',
  '主线',
  '故事线',
  '改编',
  '重写',
  '重来',
  '重做',
  '另写',
  '另起',
  '推翻',
  '大改',
  '按素材',
  '参考素材',
  '参考我给',
  '按我给',
  '换一个故事',
  '换成别的',
  '换个故事',
  '场景不对',
  '开篇不对',
  '开场不对',
  '人物不对',
  '结局不对',
  '设定不对',
  '偏离',
  '跑题',
  '偏题',
  '换场景',
  '换主角',
  '换人物',
  '改结局',
  '换个结局',
  '改人物',
]

/** 这些词单独出现时两种可能都有（「人物不对」是情节级，「人物口吻再冷一点」不是），要再看口气 */
const PLOT_LEVEL_SOFT = ['开场', '开篇', '开头', '场景', '人物', '主角', '结局', '结尾', '对话', '故事', '构思']

/** 「再冷一点」「更狠一些」这类只是调句子口气的修饰；命中就别误判成情节级 */
const TONE_TWEAK = /(再|更|太|有点|有些|稍微|略)\s*[^。！？，,]{0,4}(一点|一些|点儿|些|点)/

export function detectPlotLevelRequest(notes: string): boolean {
  const s = String(notes || '').trim()
  if (!s) return false
  if (PLOT_LEVEL_STRONG.some((k) => s.includes(k))) return true
  if (!PLOT_LEVEL_SOFT.some((k) => s.includes(k))) return false
  return !TONE_TWEAK.test(s)
}

/**
 * 重写的 user：构思 + 参考素材 + 原稿 + 点名清单（AI 的）+ 站长自己写的意见。
 *
 * 为什么要把构思和素材塞进来：他写下「主要情节参考我给的材料」「开篇场景不对」时，
 * 模型手里却没有那份材料 —— 只能猜着改，改完当然还是原来那一套。
 * 这两节只在站长真的填了的时候出现，旧调用（p3 冒烟脚本）不传就与原来逐字节一致。
 */
export function buildRewriteUserPrompt(input: {
  title: string
  bodyText: string
  excerpt?: string
  /** 生成时站长写的那段构思 —— 他要求「按构思改」时的依据 */
  idea?: string
  /** 参考素材 / 改编底本 —— 他要求「按素材改编」时的依据 */
  materials?: string
  issues: ReviewIssue[]
  /** 站长自己写的评价与想法（可留空）—— 和 issues 合起来才是完整依据 */
  notes?: string
}) {
  const { title, bodyText, excerpt, issues, notes } = input
  const own = String(notes || '').trim()
  const idea = String(input.idea || '').trim().slice(0, 800)
  const material = String(input.materials || '').trim().slice(0, 4000)
  // 他要是提了情节级要求，最后那句「没被点名的一律原样保留」就得跟着松口，
  // 否则和上面第 4 条照办要求自相矛盾，模型会挑对自己省事的那条听。
  const plotLevel = detectPlotLevelRequest(own)

  const parts: string[] = []
  if (title.trim()) parts.push(`【原稿标题】${title.trim().slice(0, 60)}`)
  if (excerpt?.trim()) parts.push(`【原稿摘要】${excerpt.trim().slice(0, 200)}`)
  if (idea) parts.push('', '【本篇构思】', idea)
  if (material) {
    parts.push(
      '',
      '【参考素材 / 改编底本（站长要求按它改时，以它的情节为准）】',
      material
    )
  }
  parts.push(
    '',
    '【原稿正文（除点名的位置外，逐字保留）】',
    String(bodyText || '').trim().slice(0, 8000)
  )
  // 只有站长意见、没勾任何条目时，这一节整个不出现 —— 不能出现「这次只改这 0 处」
  if (issues.length) {
    parts.push('', `【AI 自评点名要改的 ${issues.length} 处】`, describeIssues(issues))
  }
  if (own) {
    parts.push(
      '',
      '【站长自己点名要改的地方（这一份优先）】',
      own.slice(0, 800),
      '',
      '照办要求：',
      '1. 他的话可能不精确，先把他说的那一两句定位出来再动手 —— 改的必须是他真正不满意的地方。',
      '2. 他点到的地方都要改到；他没点到的地方，连同句子和标点逐字保留。',
      '3. 以他的为准：他写下的要求优先于 AI 清单，也优先于改稿契约第 5 条（「你可自行判断保持原样」那条是留给 AI 清单的余地，不适用于他亲手写的要求）。',
      '4. 他若明确要求改情节 / 开篇场景 / 人物 / 结局 / 整体重来（而不是只改某几句），就照他说的改 ——',
      '   这一条优先于改稿契约第 1 条，也优先于第 3、4 条（「不许增删」「篇幅相当」此时不适用），',
      '   并且改后的情节必须与上面【参考素材 / 改编底本】一致（他说「按素材来」时，就以素材为准）。',
      '   他只说「哪里不对、要以什么为准」时，自己定位到对应段落动手改，不许只做同义替换蒙混过去。'
    )
  }
  parts.push(
    '',
    plotLevel
      ? '【最后提醒】这一遍站长提了情节级要求：按他的要求改动相关的结构、场景与人物，其余部分保留；改完按三段式输出。'
      : '【最后提醒】没被点名的句子一律原样保留；改完按三段式输出。'
  )
  return parts.join('\n')
}
