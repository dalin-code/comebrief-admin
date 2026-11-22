/**
 * 「AI 整理」的提示词：把一段不规整的卷子稿改写成**严格可解析**的文本模板。
 *
 * 边界很清楚：它只做**格式与语言**这两件事 —— 补缺失的字段、把中文改成英文、
 * 给每个选项标能量档。它不负责发明新题（那件事在 `lib/quizAi.ts` 的三段生成里，
 * 那边有趋势、热词、配平数学）。
 *
 * 为什么单独一个文件：提示词里的那段格式说明必须和 `lib/quizText.ts` 的解析器逐字对齐。
 * 改了解析器（比如新增 `SHORT:`）就要改这里；`scripts/check-quiz-text.mts` 会盯住模板，
 * 而这里的对齐靠「同一张模板的两份写法」—— 所以两边都写全，不省略。
 */
import { QUIZ_SYSTEM } from './quizAi'
import { QUIZ_TEXT_MAX_QUESTIONS, QUIZ_TEXT_MIN_QUESTIONS, type QuizTextIssue } from './quizText'

/** 复用房规，只换掉「输出必须是 JSON」那一节 —— 整理任务的出口是纯文本。 */
const HOUSE_STYLE = QUIZ_SYSTEM.split('Output rules:')[0].trimEnd()

export const QUIZ_TEXT_SYSTEM = `${HOUSE_STYLE}

Output rules:
- Reply with the quiz text only. No commentary before or after, no markdown fences, no bullet list of what you changed.
- Follow the template EXACTLY, including the punctuation of the section headers. A human parses this file with a line-based parser; one stray word breaks the import.
- English only. If the input is Chinese, translate it — keep names short enough to fit a poster.`

/** 模板语法（和 `QUIZ_TEXT_TEMPLATE` 一一对应；解析器在 lib/quizText.ts）。 */
const GRAMMAR = `TITLE: <one line, max 80 chars>
HOOK: <one line, max 160 chars>
TOPIC: <one of: career, personality, pop-culture, relationships, lifestyle, mindset>
TAGS: <1–3 tags separated by " / ">
AXIS X: <low end> ←→ <high end>
AXIS Y: <low end> ←→ <high end>

== RESULT 1 | TL | pose=wave ==
NAME: <2–4 words>
SHORT: <2 words max — this is the label on the map>
HEADLINE: <max 90 chars>
QUOTE: <max 140 chars, no surrounding quotes>
READ: <3–4 sentences, max 320 chars>
STATS: <stat> / <stat> / <stat>
PILLS: <pill> / <pill>

(…RESULT 2 | TR, RESULT 3 | BL, RESULT 4 | BR…)

== Q1 | Monday, 2:07 AM ==
<the question line, max 120 chars, a specific scene>
A. <option>  (i1)
B. <option>  (i2)
C. <option>  (i1)
D. <option>  (i3) (b)`

/**
 * 整理请求。`issues` 是解析器已经找出来的毛病 —— 直接告诉模型比让它自己猜准得多，
 * 而且这些提示是**机器生成**的（不会漏项）。
 */
export function buildQuizTextTidyPrompt(input: { text: string; issues: QuizTextIssue[] }): string {
  const parts: string[] = []

  parts.push('## Task')
  parts.push(
    'Rewrite the quiz below into the house template. Keep the author\'s voice, jokes and choices. Fix ONLY what the template needs: missing fields, missing quadrants/poses, missing intensity markers, Chinese text, wrong counts.'
  )
  parts.push('Do not invent a different quiz. Same premise, same four results (keep their order), same questions unless one is unusable.')

  parts.push('')
  parts.push('## Hard rules')
  parts.push('1. Exactly 4 results, one per quadrant: TL, TR, BL, BR — never two results in the same corner.')
  parts.push('2. Each result gets a different pose: shades, wave, love, worry. Never repeat one.')
  parts.push(`3. ${QUIZ_TEXT_MIN_QUESTIONS}–${QUIZ_TEXT_MAX_QUESTIONS} questions. Every question has exactly 4 options.`)
  parts.push('4. Option order is positional: A → RESULT 1, B → RESULT 2, C → RESULT 3, D → RESULT 4. Rotate which result comes first across questions so no result is always A.')
  parts.push('5. Every option ends with an intensity marker (i1) / (i2) / (i3): 1 = barely reacts, 3 = goes all in. Inside one question use at least two different values.')
  parts.push('6. Exactly one option per question is marked (b) — the one most people would NOT pick. Put it on a different option position across questions.')
  parts.push('7. Option text max 90 chars, no "all of the above", no "none of these". Question titles are scenes, not survey questions.')
  parts.push('8. Keep TITLE / HOOK / NAME / HEADLINE / QUOTE / READ / STATS / PILLS. Every result needs all of them.')
  parts.push('9. Section headers are literal: `== RESULT 1 | TL | pose=wave ==` and `== Q1 | scene ==` (the scene part is optional, max 40 chars). Do not translate the words RESULT / Q / pose=.')

  parts.push('')
  parts.push('## Template (copy this shape)')
  parts.push('```')
  parts.push(GRAMMAR)
  parts.push('```')

  if (input.issues.length) {
    parts.push('')
    parts.push('## What the parser complained about (fix all of these)')
    for (const item of input.issues.slice(0, 12)) {
      parts.push(`- [${item.level}] ${item.label}${item.detail ? ` — ${item.detail}` : ''}`)
    }
  }

  parts.push('')
  parts.push('## The quiz to rewrite')
  parts.push('```')
  parts.push(input.text.trim().slice(0, 16000))
  parts.push('```')

  return parts.join('\n')
}
