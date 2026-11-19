#!/usr/bin/env node
/**
 * Grammar gate checks — `npm run check:grammar`.
 *
 * The gate is deliberately local and deterministic. These assertions pin the
 * cases that caused real production copy defects, plus the false positives we
 * do NOT want to block ("a university", "an hour", "a historic").
 */

import {
  blockingTextIssues,
  describeTextIssues,
  fixArticleAgreement,
  inspectEnglishText,
} from '../lib/textQuality.ts'

let failed = 0
const check = (name: string, condition: boolean, extra = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!condition) failed += 1
}

const hasRule = (text: string, rule: string, severity?: string) =>
  inspectEnglishText(text).some(
    (issue) => issue.rule === rule && (!severity || issue.severity === severity)
  )

// --- The two production defects -------------------------------------------

check(
  'flags "A abused"',
  blockingTextIssues('A abused woman escapes.').some((issue) =>
    issue.message.includes('"An abused"')
  )
)
check(
  'flags "a oppressed"',
  blockingTextIssues('In a bleak world, a oppressed miner unearths a power.').some((issue) =>
    issue.message.includes('"an oppressed"')
  )
)
check(
  'fixes both production defects',
  fixArticleAgreement('A abused woman. A oppressed miner.') ===
    'An abused woman. An oppressed miner.'
)

// --- Correct articles must not be flagged ---------------------------------

const correctArticles = [
  'An hour passed.',
  'An honest answer.',
  'An FBI agent waited.',
  'An MBA student.',
  'A university student left.',
  'A unifying theme.',
  'An uninformed reader.',
  'An unimportant detail.',
  'A European man arrived.',
  'A one-way street.',
  'A user opened the app.',
  'A UFO landed.',
  'A historic day.',
  'A NASA engineer.',
  'A UNESCO report.',
  'An X-ray was taken.',
]
for (const sample of correctArticles) {
  check(`accepts: ${sample}`, !hasRule(sample, 'article'))
}

check('fixes "An university"', fixArticleAgreement('An university student.') === 'A university student.')
check('fixes "A uninformed"', fixArticleAgreement('A uninformed reader.') === 'An uninformed reader.')

// --- Other local rules ----------------------------------------------------

check('flags repeated word as blocker', hasRule('The the door opened.', 'repeated-word', 'blocker'))
check(
  '"had had" is advisory only',
  hasRule('He had had enough.', 'repeated-word', 'warning') &&
    blockingTextIssues('He had had enough.').length === 0
)
check(
  'lowercase sentence start is advisory only',
  hasRule('this starts lowercase.', 'sentence-case', 'warning') &&
    blockingTextIssues('this starts lowercase.').length === 0
)
check(
  'does not block lowercase brand names at sentence start',
  hasRule('iPhone sales rose.', 'sentence-case', 'warning') &&
    blockingTextIssues('iPhone sales rose.').length === 0
)
check(
  'accepts lowercase dialogue tags',
  !hasRule('"Are you coming?" she asked.', 'sentence-case')
)
check(
  'accepts dotted abbreviations',
  !hasRule('Use tools, e.g. this one.', 'sentence-case') &&
    !hasRule('See No. 5 for details.', 'sentence-case')
)
check('flags space before punctuation', hasRule('Hello , world.', 'spacing', 'blocker'))
check(
  'double spaces are advisory only',
  hasRule('Too  many spaces.', 'spacing', 'warning') &&
    blockingTextIssues('Too  many spaces.').length === 0
)
check('flags unbalanced quote', hasRule('He said "hello.', 'pairing', 'blocker'))
check('accepts balanced quote', !hasRule('He said "hello".', 'pairing'))
check('accepts Chinese copy', inspectEnglishText('这是一段中文摘要，不应该被英文规则误判。').length === 0)
check(
  'summary is human-readable',
  describeTextIssues(blockingTextIssues('A abused woman.')).includes('Write "An abused"')
)

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`)
  process.exit(1)
}

console.log('\nAll grammar checks passed.')
