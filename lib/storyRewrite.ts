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
  '1. 情节、人物、时间线、视角、结局、段落顺序 —— 一个字都不许改。',
  '2. 只改下面点名的地方（AI 清单里的，和站长自己写的意见）。两处都没点到的句子，请逐字保留（连同标点）。',
  '3. 不许为了让句子「好看」而加形容词、加氛围、加比喻；不许新增人物、场景或对话轮次；不许删段落。',
  '4. 改完的总长度与原稿相当（上下浮动别超过 15%）。',
  '5. 清单里某条你若判断改了会更差，就保持原样 —— 但不要因此去动别的句子。',
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

/** 重写的 user：原稿 + 点名清单（AI 的）+ 站长自己写的意见 */
export function buildRewriteUserPrompt(input: {
  title: string
  bodyText: string
  excerpt?: string
  issues: ReviewIssue[]
  /** 站长自己写的评价与想法（可留空）—— 和 issues 合起来才是完整依据 */
  notes?: string
}) {
  const { title, bodyText, excerpt, issues, notes } = input
  const own = String(notes || '').trim()
  const parts: string[] = []
  if (title.trim()) parts.push(`【原稿标题】${title.trim().slice(0, 60)}`)
  if (excerpt?.trim()) parts.push(`【原稿摘要】${excerpt.trim().slice(0, 200)}`)
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
      '3. 以他的为准：他写下的要求优先于 AI 清单，也优先于改稿契约第 5 条（「你可自行判断保持原样」那条是留给 AI 清单的余地，不适用于他亲手写的要求）。'
    )
  }
  parts.push('', '【最后提醒】没被点名的句子一律原样保留；改完按三段式输出。')
  return parts.join('\n')
}
