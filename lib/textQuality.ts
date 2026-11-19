/**
 * English copy checks for the admin write paths.
 *
 * This module exists because bad grammar kept reaching the public site through
 * fields that are easy to miss: article excerpts (which feed meta / Open Graph
 * descriptions) and AI-generated summaries. The checks are intentionally local,
 * deterministic and dependency-free so they can run in every API route and in
 * CI without a model call.
 *
 * Design rules:
 *   · Only inspect text that is predominantly English. The story workflow is
 *     Chinese-first; flagging Chinese prose with English rules would be noise.
 *   · Prefer false negatives over false positives. Proper-noun articles ("a
 *     European", "an FBI agent") and ambiguous cases are handled or skipped.
 *   · `fixArticleAgreement()` fixes the one mechanical mistake we can correct
 *     without changing meaning. Everything else is reported for a human.
 */

export type TextIssueSeverity = 'blocker' | 'warning'

export type TextIssueRule =
  | 'article'
  | 'repeated-word'
  | 'sentence-case'
  | 'spacing'
  | 'pairing'

export type TextIssue = {
  rule: TextIssueRule
  severity: TextIssueSeverity
  /** Human-readable explanation, safe to show in an admin toast. */
  message: string
  /** The exact slice that triggered the issue. */
  match: string
  /** Optional replacement for mechanical fixes. */
  suggestion?: string
  /** Offset in the inspected string, for stable ordering. */
  index: number
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/g
const LATIN = /[A-Za-z]/g

/**
 * A rough language guard. An English title/excerpt has far more Latin letters
 * than CJK characters; Chinese story copy does the opposite. Mixed strings with
 * a dominant Latin side are still checked.
 */
export function isEnglishText(text: string): boolean {
  const value = String(text || '')
  const cjk = (value.match(CJK) || []).length
  const latin = (value.match(LATIN) || []).length
  if (latin === 0) return false
  if (cjk === 0) return true
  return latin >= cjk * 4
}

/** Words starting with a vowel letter but a consonant sound. */
const A_SOUND_WORDS = new Set([
  'one',
  'once',
  'ouija',
  'ewe',
  'eulogy',
  'euphemism',
  'euro',
  'european',
  'ubiquitous',
  'ufo',
  'ukulele',
  'unanimous',
  'unesco',
  'unicorn',
  'unicellular',
  'unicycle',
  'uniform',
  'unilateral',
  'union',
  'unique',
  'unison',
  'unit',
  'unite',
  'unity',
  'universal',
  'universe',
  'university',
  'usable',
  'usage',
  'use',
  'used',
  'useful',
  'user',
  'users',
  'usual',
  'usually',
  'utensil',
  'uterus',
  'utility',
  'utopia',
])

/** Words starting with a consonant letter but a vowel sound. */
const AN_SOUND_WORDS = new Set([
  'heir',
  'heiress',
  'heirloom',
  'herb',
  'herbal',
  'honest',
  'honestly',
  'honor',
  'honors',
  'honour',
  'honours',
  'hour',
  'hourly',
])

/**
 * All-caps initialisms whose pronunciation is letter-by-letter. "NASA" and
 * "NATO" are deliberately absent: they are read as words, so their article is
 * decided by the spoken form, not the first letter.
 */
const LETTER_BY_LETTER = new Set([
  'AI',
  'API',
  'CIA',
  'DNA',
  'FAA',
  'FBI',
  'FCC',
  'FDA',
  'FTC',
  'HR',
  'HTML',
  'HTTP',
  'HTTPS',
  'IRS',
  'LCD',
  'LED',
  'LLM',
  'MBA',
  'MLB',
  'MRI',
  'MVP',
  'NBA',
  'NFL',
  'NGO',
  'NHL',
  'PR',
  'RNA',
  'RSS',
  'SEO',
  'SQL',
  'SSN',
  'UFO',
  'URL',
  'USB',
  'XSS',
])

/** Vowel-sound letter names: A, E, F, H, I, L, M, N, O, R, S, X. */
const VOWEL_SOUND_LETTER = /^[AEFHILMNORSX]$/

/** Words where both "a" and "an" are defended by style guides; do not flag. */
const AMBIGUOUS_H = new Set(['historic', 'historical'])

function expectedArticle(rawWord: string): 'a' | 'an' | null {
  const word = String(rawWord || '').replace(/^[^A-Za-z]+|[^A-Za-z'-]+$/g, '')
  if (!word) return null

  const lower = word.toLowerCase()
  if (AMBIGUOUS_H.has(lower)) return null

  // "X-ray" is pronounced "ex-ray".
  if (/^x-/i.test(word)) return 'an'

  // Single letters and known initialisms are pronounced by letter name.
  if (/^[A-Z]$/.test(word)) return VOWEL_SOUND_LETTER.test(word) ? 'an' : 'a'
  if (word === word.toUpperCase() && LETTER_BY_LETTER.has(word)) {
    return VOWEL_SOUND_LETTER.test(word[0]) ? 'an' : 'a'
  }
  // Unknown all-caps initialisms are pronounced unpredictably ("a UNESCO",
  // "an SEC filing"). Leave them alone instead of guessing.
  if (/^[A-Z]{2,}$/.test(word)) return null

  if (AN_SOUND_WORDS.has(lower)) return 'an'
  if (A_SOUND_WORDS.has(lower)) return 'a'
  if (/^one(?:-|$)/.test(lower) || /^once(?:-|$)/.test(lower)) return 'a'
  if (/^(?:use|usu|uti|ure|uro|ubiq|eu|ewe|uk)/.test(lower)) return 'a'
  // "uni" splits by sound: "a university / unifying" (yoo) but "an uninformed
  // reader / an unimportant detail" (uh). Only the un-im / un-in families take
  // "an"; everything else in this group starts with a yoo sound.
  if (lower.startsWith('uni')) return /^(?:unim|unin)/.test(lower) ? 'an' : 'a'

  return /^[aeiou]/.test(lower) ? 'an' : 'a'
}

function preserveArticleCase(rawArticle: string, expected: 'a' | 'an'): string {
  const isCapitalised = rawArticle[0] === rawArticle[0].toUpperCase()
  return isCapitalised ? expected[0].toUpperCase() + expected.slice(1) : expected
}

/** Issues that should stop a save / AI output from being accepted. */
export function blockingTextIssues(text: string): TextIssue[] {
  return inspectEnglishText(text).filter((issue) => issue.severity === 'blocker')
}

/** Compact one-line summary for API errors and admin toasts. */
export function describeTextIssues(issues: TextIssue[], limit = 2): string {
  if (issues.length === 0) return ''
  const shown = issues
    .slice(0, limit)
    .map((issue) => issue.message)
    .join('; ')
  return issues.length > limit ? `${shown} (+${issues.length - limit} more)` : shown
}

/**
 * Fix only "a/an" agreement. This is the one rule where the intended text is
 * unambiguous, so callers may apply it automatically (AI output) or use the
 * result as a suggestion (editor saves are still rejected for review).
 */
export function fixArticleAgreement(text: string): string {
  const value = String(text || '')
  if (!isEnglishText(value)) return value

  return value.replace(
    /\b(a|an)(\s+)([A-Za-z][A-Za-z'-]*)/gi,
    (full, article: string, space: string, word: string) => {
      const expected = expectedArticle(word)
      if (!expected || expected === article.toLowerCase()) return full
      return `${preserveArticleCase(article, expected)}${space}${word}`
    }
  )
}

export function inspectEnglishText(text: string): TextIssue[] {
  const value = String(text || '')
  if (!isEnglishText(value)) return []

  const issues: TextIssue[] = []

  // 1. a / an agreement.
  const articlePattern = /\b(a|an)(\s+)([A-Za-z][A-Za-z'-]*)/gi
  for (const match of value.matchAll(articlePattern)) {
    const article = match[1]
    const word = match[3]
    const expected = expectedArticle(word)
    if (!expected || expected === article.toLowerCase()) continue

    const suggestion = `${preserveArticleCase(article, expected)} ${word}`
    issues.push({
      rule: 'article',
      severity: 'blocker',
      message: `Write "${suggestion}" instead of "${match[0]}".`,
      match: match[0],
      suggestion,
      index: match.index ?? 0,
    })
  }

  // 2. Repeated words ("the the"). "had had" and "that that" can be valid
  // English, so they are advisory rather than blocking.
  const repeatedPattern = /\b([A-Za-z][A-Za-z'-]*)\b(\s+)\1\b/gi
  for (const match of value.matchAll(repeatedPattern)) {
    const word = match[1]
    const lower = word.toLowerCase()
    const advisory = lower === 'had' || lower === 'that'
    issues.push({
      rule: 'repeated-word',
      severity: advisory ? 'warning' : 'blocker',
      message: `Repeated word "${word}".`,
      match: match[0],
      suggestion: word,
      index: match.index ?? 0,
    })
  }

  // 3. Sentence starts with a lowercase letter. Abbreviations are skipped so
  // "e.g. this" does not produce noise.
  const sentencePattern = /(^|[.!?]\s+)(["'“‘(]*)([a-z][A-Za-z'-]*)/g
  for (const match of value.matchAll(sentencePattern)) {
    const lead = match[1]
    const quote = match[2]
    const word = match[3]
    const index = (match.index ?? 0) + lead.length + quote.length

    if (lead.endsWith('. ')) {
      const before = value.slice(Math.max(0, index - 20), index).trimEnd()
      // Abbreviations and dotted initialisms are not sentence boundaries.
      if (/\b(?:[A-Za-z]\.){2,}$/.test(before)) continue
      if (
        /\b(?:e\.g|i\.e|etc|Mr|Mrs|Ms|Dr|Prof|St|vs|Jr|Sr|No|Inc|Ltd|Co|Corp|Dept|Est|Ave|Blvd|Rd|Fig|Vol)\.$/i.test(
          before
        )
      ) {
        continue
      }
    }

    // Dialogue tags are lowercase in correct English:
    //   "Are you coming?" she asked.   /   "Stop!" he shouted.
    const punctuation = lead.trim()
    const charBefore = value[index - lead.length - 1] || ''
    if ((punctuation === '?' || punctuation === '!') && /["'”’]/.test(charBefore)) {
      continue
    }

    const suggestion = word[0].toUpperCase() + word.slice(1)
    // Advisory: sentence-initial brand names such as "iPhone" and "eBay" are
    // legitimate lowercase starts. Surface the issue without blocking a save.
    issues.push({
      rule: 'sentence-case',
      severity: 'warning',
      message: `Capitalise the first word of a sentence: "${word}" → "${suggestion}".`,
      match: `${quote}${word}`,
      suggestion,
      index,
    })
  }

  // 4. Spacing before punctuation is a typo; double spaces are advisory.
  const punctuationSpace = /\s+([,.;:!?])/g
  for (const match of value.matchAll(punctuationSpace)) {
    issues.push({
      rule: 'spacing',
      severity: 'blocker',
      message: `Remove the space before "${match[1]}".`,
      match: match[0],
      suggestion: match[1],
      index: match.index ?? 0,
    })
  }

  const doubleSpace = /[ \t]{2,}/g
  for (const match of value.matchAll(doubleSpace)) {
    issues.push({
      rule: 'spacing',
      severity: 'warning',
      message: 'Use a single space instead of repeated spaces.',
      match: match[0],
      suggestion: ' ',
      index: match.index ?? 0,
    })
  }

  // 5. Unbalanced quotes / brackets. Apostrophes are excluded because they are
  // far more often contractions than quotation marks.
  const pairings: Array<{
    label: string
    open: string
    close: string
    countOpen: number
    countClose: number
  }> = [
    {
      label: 'double quotes',
      open: '"',
      close: '"',
      countOpen: (value.match(/"/g) || []).length,
      countClose: 0,
    },
    {
      label: 'curly double quotes',
      open: '“',
      close: '”',
      countOpen: (value.match(/“/g) || []).length,
      countClose: (value.match(/”/g) || []).length,
    },
    {
      label: 'parentheses',
      open: '(',
      close: ')',
      countOpen: (value.match(/\(/g) || []).length,
      countClose: (value.match(/\)/g) || []).length,
    },
    {
      label: 'square brackets',
      open: '[',
      close: ']',
      countOpen: (value.match(/\[/g) || []).length,
      countClose: (value.match(/\]/g) || []).length,
    },
  ]

  for (const pair of pairings) {
    const balanced =
      pair.close === pair.open ? pair.countOpen % 2 === 0 : pair.countOpen === pair.countClose
    if (balanced) continue

    const openIndex = value.indexOf(pair.open)
    issues.push({
      rule: 'pairing',
      severity: 'blocker',
      message: `Unbalanced ${pair.label}.`,
      match: pair.open,
      index: openIndex === -1 ? 0 : openIndex,
    })
  }

  return issues.sort((a, b) => a.index - b.index)
}


