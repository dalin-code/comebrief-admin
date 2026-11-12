/**
 * 把**被截断**的 JSON 前缀补成合法 JSON：只补括号，不改内容。
 *
 * 为什么需要：`max_tokens` 用尽时模型正好写在一半（`{"ideas":[{"title":"…"},{"ti`），
 * 这时候整条回复都会作废 —— 而前面几条其实是好的。这里的做法是
 * **回退到最后一个完整闭合的元素**，再把剩下的括号补齐，于是「4 条里写完 3 条」
 * 能救回 3 条，而不是让用户点重试（重试大概还是同样的长度）。
 *
 * 只补括号的好处：不会凭空造字段，也不会把半个字符串「猜」成完整的 ——
 * 半个字符串在 `normalize*` 里本来就过不了校验，会被丢掉。
 *
 * 零依赖：`scripts/check-quiz-kit.mts` 直接 import 它做离线自检。
 *
 * @returns 补好的 JSON 字符串；不是截断（本来就是完整但非法的 JSON）时返回 null
 */
export function closeTruncatedJson(text: string): string | null {
  const raw = String(text || '')
  const start = raw.search(/[[{]/)
  if (start < 0) return null
  const src = raw.slice(start)

  const stack: string[] = []
  let inString = false
  let escaped = false
  /** 最后一个「一个元素刚闭合」的位置，以及那一刻的括号栈 */
  let safeIndex = -1
  let safeStack: string[] = []

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch)
      continue
    }
    if (ch === '}' || ch === ']') {
      if (!stack.length) return null // 括号不配对，不是「截断」，别瞎补
      stack.pop()
      // 栈里还有内容 = 刚闭合的是更深一层的元素（数组里的一项）
      if (stack.length) {
        safeIndex = i
        safeStack = [...stack]
      }
    }
  }

  // 括号已经配平：说明不是截断，是纯粹的非法 JSON，交给调用方报原来的错
  if (!stack.length || safeIndex < 0) return null

  const head = src.slice(0, safeIndex + 1)
  const tail = [...safeStack].reverse().map((ch) => (ch === '{' ? '}' : ']')).join('')
  return head + tail
}