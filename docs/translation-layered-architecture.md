# 翻译为什么要分两层：LLM 母语化重写 → 传统 MT 兜底

2026-10-13 站长问：「LLM 都挂了，DeepL 就不能顶一下吗？」
这篇记的是那次改动的「为什么」和「怎么用」，下次再有人问同样的问题，指着这篇就行。

## 一、先说清楚红线：我们的翻译**不是**翻译

`POST /api/ai/translate` 干的活叫**母语化重写**。提示词里写死了一条红线：

> a reader must never feel it was translated

意思是允许它重组句子、把中文的比喻换成英文读者熟悉的比喻、把语序改成英文的呼吸节奏。
产出读起来像「本来就该是英文写的」，**不像一篇译文**。

而 DeepL / Google / Azure / LibreTranslate 这类是**忠实型机翻**：它逐句对齐，
不会重组、不会本地化，产出一定带翻译腔。

所以结论是硬的：**MT 永远不能当首选**，它只能当最后一根救命绳。
把它放在主路径上，等于悄悄把产品标准降了一档，而且没人会发现。

## 二、于是分了三层

```
① LLM 母语化重写      callText() → Gemini / OpenRouter Claude / DeepSeek 候选链
        ↓ 整条链都失败（429 额度用尽 / 503 / 网络断 / 超时）
② 传统 MT 兜底        translateWithMt() → DeepL → Google → Microsoft → LibreTranslate
        ↓ 没配，或也全挂
③ 老实报错            错误里写清「两边各试过什么」
```

第 ② 层**只在 ① 完全失败后**才被调用，返回的稿子会带 `degraded: true`，
提示里也会劝站长「稍后重译一遍」。默认行为（不配任何 MT Key）跟以前一模一样。

## 三、怎么开

`.env.local` 里加一行，再给至少一家配上 Key 就生效（Key 一个都没配 = 不启用，不会报错）：

```bash
# 按顺序降级，第一个成功的就用
AI_TRANSLATE_MT_FALLBACK=deepl, libretranslate
```

| 引擎写法 | 需要的环境变量 | 说明 |
| --- | --- | --- |
| `deepl` | `DEEPL_API_KEY` | 译感最好。免费版 Key 以 `:fx` 结尾，会自动走 `api-free.deepl.com`（想走代理再填 `DEEPL_API_URL`） |
| `google` | `GOOGLE_TRANSLATE_API_KEY` | Cloud Translation v2，API Key 就能用，不需要 Service Account |
| `microsoft` | `AZURE_TRANSLATOR_KEY` + `AZURE_TRANSLATOR_REGION` | Translator v3；region 必填（如 `eastasia`） |
| `libretranslate` | `LIBRETRANSLATE_URL`（`LIBRETRANSLATE_API_KEY` 可选） | 开源、可自建。公共实例普遍限流，所以这里**要求填你自己的地址** |

别名：`azure` = `microsoft`，`libre` = `libretranslate`。

**缺 Key 的引擎会被自动跳过**（在终端留一行 `[mt-provider] 跳过 deepl：要调用 DeepL 需要环境变量 DEEPL_API_KEY，但它是空的`），
不会因为它没配就把整条兜底链废掉 —— 这是「能配一个是一个」的意思。

改完 `.env.local` 要重启 `npm run dev`（Next 只在启动时读它）。

## 四、降级时，响应里多了什么

成功的响应结构没变（客户端一行代码都不用改），只是 `data` 里多了三个字段：

| 字段 | 含义 |
| --- | --- |
| `engine` | 这一版是谁产出的（`deepl` / `google` / `microsoft` / `libretranslate`） |
| `degraded: true` | **这一版是机翻兜底**，不是母语化重写 |
| `fallbackFrom: 'llm'` | 从哪一层降下来的（目前只有 `llm` 一种） |

外加 `warnings` 里会多一句给站长看的：

> LLM 母语化重写整条链都挂了（试过 gemini-3.5-flash、…），已用 DeepL 机翻兜底 ——
> 这一版是忠实直译、可能有翻译腔，建议稍后重译

`model` 字段会写成 `DeepL（机翻兜底）`，编辑器里一眼能认出来。
连 MT 也全挂时，错误信息会合成一句，把两边都点出来：

> DeepL 免费额度用完了…（连机翻兜底也没成。LLM 那边试过：gemini-3.5-flash、…）

## 五、几个实现取舍（以后别问「为什么不…」）

**为什么单独开一个 `lib/translationProvider.ts`？**
仓库的规矩是一事一文件：`aiGemini` 是工具箱、`aiProvider` 管 LLM、`aiMemo` 管记忆。
MT 的职责、配置、冷却、报错跟 LLM 都不一样，塞进 `aiProvider` 会互相污染。
最关键的是：**MT 的冷却必须独立**。LLM 被限流了不该影响 MT，反之亦然。

**为什么正文用 `tag_handling=html`，标题/摘要却单独再翻两句？**
MT 只知道「把这段文字变成英文」，它不知道什么叫「一篇稿子」——不会顺带给你
`TITLE/EXCERPT/BODY/GLOSSARY` 这套结构。所以正文交原始 HTML（保标签），
标题和摘要各自一次纯文本调用。分批翻译时跟 LLM 路径一致：只有第 1 段负责标题/摘要。

**MT 返回的是纯文本，怎么变成 HTML？**
分批翻译时送出去的是纯文本，拿回来按换行切成段落、补上 `<p>`（并把 `&<>` 转义）。
不补的话整篇会挤成一段 —— 站长看到的会是「翻译把排版弄丢了」。

**为什么给 MT 的时间预算只有 6 秒（总 10 秒）？**
MT 是「一次 HTTP 就回」的同步接口，正常几百毫秒。而 LLM 那条链往往把 60 秒的
`maxDuration` 啃掉大半才认输，剩给兜底的本来就不多 —— 预算必须能在夹缝里跑完，
而且「慢失败」比「失败」更糟（站长盯着转圈等到白屏）。

**为什么去重、冷却、`tried` 这些都照抄 `aiProvider` 的规矩？**
因为路由层要用同一套姿势处理两层的结果（`ok / status / error / kind / retryable /
retryAfterMs / tried`）。`translateWithMt()` 的返回结构刻意跟 `CallTextResult` 对齐，
少一层心智负担。

**为什么缺 Key 不报错，只是跳过？**
生产环境里「一个 Key 都没配」是常态（我们就是这样）。它意味着**兜底不启用**，
而不是配置写错了 —— 后者才需要红字。自检页里这一项也刻意用 `info` 而不是 `error`。

**DeepL 的 456 是什么？**
「额度用尽」。它**不是** 429，`parseProviderError` 认不出来，会掉进
「unknown」。所以 `parseMtError()` 单独认了一下，翻成「额度用完了」并进冷却。

## 六、顺带修掉的「退出系统」


站长报：后台左下角的「退出系统」点了没反应。

**根因是两条叠在一起的：**

1. `app/admin/_components/Sidebar.tsx` 里那个按钮是**纯装饰** —— 有图标、有文字、
   有 hover 效果，就是**没有 `onClick`**。看起来像坏了，其实是根本没接线。
2. 全项目唯一带登出的 `Header.tsx` 是**死代码**（没有任何文件 import 它），
   而且它退完是 `router.push('/')` —— 回的是前台首页，不是登录页。
   也就是说：即使有人把它挂上去，退完也进不了登录页。

**修法**：`lib/clientAuth.ts` 新增 `signOutAndRedirect()`，三步走，每步都往下兜：

```
1. signOut()                   正常路径：清本地票 + 通知服务端作废
2. signOut({ scope: 'local' }) 上一步失败 → 至少把本地这张票扔掉
3. window.location.href = /admin/login?redirect=…
```

**为什么最后必须是硬跳转**：登录守卫写在客户端 `app/admin/layout.tsx` 里
（`getSession()` 那一段），靠 Next 的软跳转不会可靠地重跑那套判断 ——
会出现「名义上登出了、人还站在后台里」。硬跳转才会让守卫重新走一遍。

`Sidebar` 那边补上 `onClick` + 二次确认（它就贴在菜单底部，平时扫菜单很容易手滑，
而退出的代价是「这次没保存的稿子白写」）+ loading + 失败提示。
死代码 `Header.tsx` 删掉。

## 七、自检：怎么看兜底链现在行不行

`GET /api/ai/status` 的 `data` 里多了一块 `mt`：

```json
{
  "mt": {
    "enabled": true,
    "chain": ["deepl", "libretranslate"],
    "rows": [{ "spec": "deepl", "ok": true, "label": "DeepL", "baseUrl": "https://api-free.deepl.com", "cooling": "", "error": "" }],
    "keys": { "DEEPL_API_KEY": true, "GOOGLE_TRANSLATE_API_KEY": false, "...": false },
    "summary": { "level": "ok", "text": "兜底链就绪：deepl → libretranslate" }
  }
}
```

带 `?probe=1` 时还会对每个引擎**真翻一次「你好」**（毫秒级，比 LLM 那边的探测便宜得多），
结果放在 `mtProbe` 里。后台「AI 自检」卡片上也多了一块「翻译兜底 · 传统 MT」，
样式跟上面几块一致；**没配时是灰色的 info 一句话，不是红字** —— 没配不算错。

最常看的三种 `summary`：

| 情况 | 文案 | 意思 |
| --- | --- | --- |
| 没配 | `没配 AI_TRANSLATE_MT_FALLBACK：LLM 全挂时翻译会直接报错…` | 兜底不启用（= 以前的行为），不算配置错误 |
| 配了但部分引擎用不了 | `1 / 2 个兜底引擎用不了：要调用 Google 翻译需要环境变量…` | 剩下那家还能顶，按提示补 Key |
| 都不可用 | `兜底链里的 2 个引擎都用不了：…` | 现在 LLM 一挂就真的没退路了 |

## 八、怎么验

```bash
cd Sass
npm run typecheck && npm run lint

# ① 纯离线：引擎解析 / 语言码 / 四家回包形状 / 错误分类 / 注入 fake fetch 跑降级链路
P10_OFFLINE=1 node --import ./scripts/_ts-resolve.mts scripts/p10-translation-fallback.mts

# ② 含真 HTTP（需要 npm run dev 跑在 3001）
P10_SKIP_MODELS=1 node --import ./scripts/_ts-resolve.mts scripts/p10-translation-fallback.mts  # 不花额度
node --import ./scripts/_ts-resolve.mts scripts/p10-translation-fallback.mts                    # 真调一次模型
```

离线那段里最关键的两个断言是：
**「DeepL 429 → 自动换到 LibreTranslate」**（降级顺序不能乱）和
**「全挂 → 合并成一句人话」**（别把英文原文丢给站长）。

真 HTTP 那段特意留了一条**反向**断言：**正常路径必须还是 LLM**（`degraded !== true`）。
2026-10-13 实测：主模型挂了，自动落到 `openrouter:deepseek/deepseek-chat`，
30 秒出稿 —— 兜底链在，但 MT 一次都没被惊动。这就是我们想要的分层。

