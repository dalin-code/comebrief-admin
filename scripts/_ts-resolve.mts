/**
 * 让 `node` 也能解析项目里「无扩展名」的相对导入（'./aiGemini' 这种）。
 *
 * 为什么需要：Next.js 的打包器认识无扩展名导入，但 Node 原生 ESM 要求写全 `./aiGemini.ts`。
 * 项目里所有代码都用无扩展名写法（这是对的，别改），所以只在**跑调研脚本**时挂这个钩子：
 *
 *   node --import ./scripts/_ts-resolve.mts scripts/p1-smoke.mts
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const looksRelative = specifier.startsWith('./') || specifier.startsWith('../')
    const hasExtension = /\.[cm]?[jt]sx?$/.test(specifier)
    if (looksRelative && !hasExtension) {
      for (const ext of ['.ts', '.tsx', '.mts', '/index.ts']) {
        try {
          return nextResolve(specifier + ext, context)
        } catch {
          // 试下一个后缀
        }
      }
    }
    return nextResolve(specifier, context)
  },
})
