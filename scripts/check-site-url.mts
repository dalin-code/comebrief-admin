#!/usr/bin/env node
/**
 * 站点 origin 归一化自检（**完全离线**）。
 *
 * 为什么需要：后台的 `NEXT_PUBLIC_SITE_URL` 是人工填的，2026-11-25 就被粘成了
 * `[https://www.comebrief.com] (https://www.comebrief.com)` —— 于是 IndexNow
 * 按钮抛「Failed to parse URL」，「保存后刷新前台」静默跳过，广告兜底跳转拼坏。
 * 这类脏值不会让 typecheck 变红（它只是 string），只能靠断言钉住。
 *
 * 用法：node --import ./scripts/_ts-resolve.mts scripts/check-site-url.mts
 */

// 后面的 SITE_URL 断言要的是「没配」的状态；本地 .env.local 不该影响结论。
// （dynamic import 必须在改完 env 之后，静态 import 会被提升到赋值之前。）
delete process.env.NEXT_PUBLIC_SITE_URL
const { DEFAULT_SITE_URL, SITE_URL, normalizeSiteUrl } = await import('../lib/siteUrl.ts')

let failed = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` —— ${extra}` : ''}`)
  if (!cond) failed += 1
}

const cases: Array<[string, string | null | undefined, string]> = [
  // 线上真实脏值：从聊天/文档里复制链接会带上 Markdown 的方括号与括号。
  [
    '1a Markdown 包装（线上真实值）',
    '[https://www.comebrief.com] (https://www.comebrief.com)',
    'https://www.comebrief.com',
  ],
  ['1b Markdown 包装 + 结尾斜杠', '[https://comebrief.com/](https://comebrief.com/)', 'https://comebrief.com'],
  ['1c 双引号 + 前后空白', '  "https://comebrief.com/"  ', 'https://comebrief.com'],
  ['1d 单引号 + 结尾斜杠', "'https://comebrief.com///'", 'https://comebrief.com'],
  ['1e 尖括号（自动链接语法）', '<https://comebrief.com>', 'https://comebrief.com'],
  ['1f 结尾句号', 'https://comebrief.com.', 'https://comebrief.com'],
  ['1g 结尾右括号', '(https://comebrief.com)', 'https://comebrief.com'],
  ['1h 带路径（只取 origin）', 'https://comebrief.com/sitemap.xml', 'https://comebrief.com'],
  ['1i 带查询串与锚点', 'https://comebrief.com/?utm=1#top', 'https://comebrief.com'],
  ['1j 协议/主机大写', 'HTTPS://ComeBrief.COM/', 'https://comebrief.com'],
  ['1k 保留端口（本地）', 'http://localhost:3000/', 'http://localhost:3000'],
  ['1l 一条带空格的地址只取第一段', 'https://comebrief.com /sitemap.xml', 'https://comebrief.com'],
  ['1m 空串', '', ''],
  ['1n 只有空白', '   \n\t ', ''],
  ['1o null', null, ''],
  ['1p undefined', undefined, ''],
  ['1q 没有协议不猜', 'comebrief.com', ''],
  ['1r 非 http(s) 协议不认', 'ftp://comebrief.com', ''],
  ['1s 只有协议', 'https://', ''],
  ['1t 纯文本', '随便一段话，没有链接', ''],
]

for (const [name, input, expected] of cases) {
  const actual = normalizeSiteUrl(input)
  check(name, actual === expected, `in=${JSON.stringify(input)} out=${JSON.stringify(actual)}`)
}

// 多条链接时取第一条 —— 顺序即优先级，避免同一条变量里前后矛盾时结果飘。
check(
  '2a 多条链接取第一条',
  normalizeSiteUrl('https://www.comebrief.com 或 https://comebrief.com') === 'https://www.comebrief.com'
)

// 幂等：归一化过的值再归一化一次不应再变（调用点会重复经过它）。
check('2b 幂等', normalizeSiteUrl(normalizeSiteUrl('https://comebrief.com/x')) === 'https://comebrief.com')

// 没配变量时的兜底：SITE_URL 永远是可用的 origin，绝不是空串。
check('3a 未配置时退回默认主域', SITE_URL === DEFAULT_SITE_URL, SITE_URL)
check('3b 默认主域是 apex', DEFAULT_SITE_URL === 'https://comebrief.com', DEFAULT_SITE_URL)
check('3c 默认值本身能过归一化', normalizeSiteUrl(DEFAULT_SITE_URL) === DEFAULT_SITE_URL)

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
