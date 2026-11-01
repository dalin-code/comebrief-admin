# AI 生成报 `502 fetch failed` 怎么查

后台「AI 创作」点生成时，`POST /api/ai/story` 回 502，界面上只写一句 `fetch failed`。
这篇记的是 2026-10 一次真实故障的排查过程与结论，下次再遇到照做即可。

## 症状

- 前端红框里只有一句 `fetch failed`（没有别的话），Network 面板里 `story` 请求 502。
- 服务端终端（`npm run dev` 那个窗口）会打两行：
  - `[ai-provider] Gemini 直连/<模型> 第 N 次请求异常（xxxxms）：...`
  - `[ai-story:xxxxxx] 模型调用失败 { status: 502, error: ... }`

## 根因

`fetch` 到 `https://generativelanguage.googleapis.com` **在 TLS 握手阶段被 reset**：

```
TypeError: fetch failed
  cause = ECONNRESET / Client network socket disconnected before secure TLS connection was established
  （约 5 秒抛出；请求根本没到 Google）
```

- 这是本机网络到 Google 的抖动 / 被拦，跟登录态无关，也不是代码 bug。
- 同一分钟内重发 12 次全部成功 → 属**偶发**，重试一次基本必成。
- 之所以只看到 `fetch failed`：Node 的 `fetch`（undici）对**所有**网络层错误都只抛这一句，
  真正的原因在 `error.cause` 里；谁直接 `e.message` 谁就丢了线索。

## 现在的行为（本次修复）

| 位置 | 改动 |
| --- | --- |
| `lib/aiGemini.ts` | `isNetworkFetchError()` / `describeNetworkError()`：认得出网络层失败，并翻成人话（带 `ECONNRESET` 之类 code） |
| `lib/aiProvider.ts` | 网络层失败只要「来得快」（< 12 秒）就自动重试一次（等 500ms），**不占用**调用方 `retries` 配额；重试用剩余时间预算，不会顶爆 `maxDuration` |
| `StoryComposer.apiPost` | 收到 502 / 503 自动重发一次（等 800ms）；504 故意不重发（模型已经跑了 50 多秒，再等一遍是让站长干等） |
| 三个 story 路由 | 模型调用失败时打日志（以前是静默返回，终端一个字都没有） |

所以现在的预期是：**点一次就出稿**。真要失败，提示会写清楚是哪一段网络不通。

## 自助排查

1. 不经过浏览器和登录态，单独测这条链路：

   ```bash
   # 换成 .env.local 里的 GEMINI_MODEL / GEMINI_API_KEY
   node -e "fetch('https://generativelanguage.googleapis.com/v1beta/models',{headers:{'x-goog-api-key':'<key>'}}).then(r=>console.log('HTTP',r.status)).catch(e=>console.log(e.cause&&e.cause.code))"
   ```

   - 返回 200 / 403 → 通；403 只是 key 不对或没带。
   - `ECONNRESET` / `ETIMEDOUT` / `ENOTFOUND` → 网络到 Google 不通，看下一步。

2. 让 Node 走本地代理。**Node 的 `fetch` 默认不读 `HTTP_PROXY` / `HTTPS_PROXY`**，
   要显式打开（Node 24+）：

   ```bash
   HTTPS_PROXY=http://127.0.0.1:7890 NODE_USE_ENV_PROXY=1 npm run dev
   ```

   验证代理真的生效：把端口改成一个没在监听的（比如 `http://127.0.0.1:9`），
   如果报 `ECONNREFUSED connect 127.0.0.1:9`，说明请求确实走了代理。

3. 终端里的 code 不是网络类（例如 `Gemini 404: model not found`、`Gemini 429`）→
   那是模型名写错或额度用完了，不是网络问题，改 `AI_STORY_MODEL` / 等额度恢复。

## 附录：`429` 免费额度用尽（2026-10-07 后台「重写」整片报红）

### 症状

后台点「按勾选的 N 条重写」，红框里是一整坨 JSON：

```
Gemini 429: { "error": { "code": 429, "message": "You exceeded your current quota,
please check your plan and billing details. For more information on this error,
head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your
current usage, head to: https://ai.dev/rate-limit. \n* Quota ex…
```

（`…` 是 `lib/aiProvider.ts` 里 `raw.slice(0, 300)` 截的 —— 连错误信息都是被截断的。）

### 两个根因，各修一半

1. **配置：兜底模型和主模型是同一个。**
   `.env.local` 里 `AI_STORY_MODEL` … `AI_UTIL_MODEL` 和 `AI_MODEL_FALLBACK`
   六行全填了 `gemini-3-flash-preview`。而 `lib/aiProvider.ts` 的兜底逻辑是
   `if (fallbackSpec && fallbackSpec !== spec)` —— 两边一样就直接跳过，
   **等于没配兜底**：主模型一撞 429，错误原封不动顶到站长脸上。
   → 现在主模型 `gemini-3.8-flash`、兜底 `gemini-3.5-flash`（不同的每日额度池）。

2. **代码：错误提示直接吐 JSON。**
   `Gemini ${resp.status}: ${raw.slice(0, 300)}` 对排查有用、对站长毫无用处 ——
   429 到底是「额度用完了」（该换模型 / 等一天）还是「点太快被限流」（缓十几秒），
   红框里根本看不出来。
   → `lib/aiGemini.ts` 新增 `extractProviderMessage()` + `describeProviderError()`，
   三个协议（Gemini / OpenAI 兼容 / Anthropic）和 `callGeminiText()` 统一改走它，
   按状态码说人话（429 还会再分「额度」和「限流」两种），英文原文只留给终端日志。

   > ⚠️ 2026-10-10 追认：这一版的「429 再分两种」其实是**猜的** —— 判据是拿
   > `/quota|billing|plan/` 去匹配 message，而 Google 对「每分钟限流」和「每日额度用尽」
   > 回的文案一模一样，于是每一句 429 都被说成「今天没了」。真正的判据见文末那一节。

### 自助排查（不要猜，直接 ping）

```bash
cd ~/Desktop/Sass && set -a && source .env.local && set +a
# ① 这把 key 到底能用哪些模型
curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" \
  | python3 -c "import json,sys;[print(m['name'].split('/')[-1]) for m in json.load(sys.stdin)['models'] if 'generateContent' in m.get('supportedGenerationMethods',[])]"
# ② 逐个 ping（列表里有 ≠ 能用；额度是按模型分的）
for M in gemini-3.8-flash gemini-3.5-flash; do
  echo -n "$M -> "
  curl -s -o /dev/null -w '%{http_code}\n' -X POST \
    "https://generativelanguage.googleapis.com/v1beta/models/$M:generateContent" \
    -H 'Content-Type: application/json' -H "x-goog-api-key: $GEMINI_API_KEY" \
    -d '{"contents":[{"role":"user","parts":[{"text":"ping"}]}],"generationConfig":{"maxOutputTokens":8,"thinkingConfig":{"thinkingBudget":0}}}'
done
```

- `200` = 可用；`429` = 这个模型当天额度用尽；`404` = 模型名不存在或已对新用户下线。
- **换模型不用改代码**，只改 `.env.local` 那六行，重启 `npm run dev` 生效。

## 附录：摘要栏里出现 `99)经(100)蜕(101)变…`（2026-10-07 后台）

### 症状

1. 编辑页点「AI 一键生成摘要」，摘要框里出现的不是摘要，而是一串「编号 + 汉字」：

   ```
   99)经(100)蜕(101)变(102)的(103)彼(104)此(105)
   ```

2. 同一篇稿子上点「母语化重写 → 英文」，红框提示「**中文正文太短了，先写完再翻译**」——
   可编辑器里明明是一整篇中文。

### 根因

**① 摘要：思考 token 把输出额度吃光了，那一栏里装的是模型的「数数草稿」。**

`/api/ai/excerpt` 走的是 `callGeminiText()`，而这个函数**不认 `thinkingConfig`**
（翻译、写稿早就关掉了思考，只有摘要这条漏了）。Gemini 3.x 的思考 token 和答案共用
`maxOutputTokens`；提示词里写着「摘要不超过 120 字」，模型就真的**一个汉字一个汉字地数了一遍**
（`(101)接(102)与…`，因为要核对字数），980 个 token 全花在数数上：

| thinkingConfig | finishReason | thoughtsTokenCount | 输出 |
| --- | --- | --- | --- |
| 不传（默认开思考） | MAX_TOKENS | 984 | `101)接(102)与(103)紧(104)绷(105)张(106)力(` |
| `includeThoughts: true` | MAX_TOKENS | 980 | 1140 字思考 + 70 字答案，答案尾巴还挂着 `Count:\n那(` |
| `thinkingBudget: 0` | STOP | 0 | 干净的 120 字摘要，4.5 秒 |

（同一份正文、同一个 prompt，只改 `thinkingConfig`。所以「摘要乱码」= 那一栏里装的是数数草稿的
尾巴；`finishReason=MAX_TOKENS` 还把它截掉了前半截。）

**② 翻译：只在「一个地方」找中文原稿。**

新建稿的页签初值是 `'en'`，中文正文被直接写/粘在英文页签里；而翻译读的是 `zhHtmlRef.current`
（= 库里的 `content_zh_html`），线上抽查 20 篇有 19 篇这一栏是空的 → 判定「中文正文太短」。
「发布护栏 → 先去翻译」那颗按钮还多一层坑：它先 `switchLang('zh')` 再调 `handleTranslate`，
而 `setLang` 是异步的，`handleTranslate` 这一帧闭包里读到的还是 `'en'`。

### 改动

| 位置 | 改动 |
| --- | --- |
| `lib/aiGemini.ts` | `callGeminiText()` 支持 `thinkingBudget` / `model`，并过滤 `thought: true` 的 part；`finishReason=MAX_TOKENS` 时打日志（⚠️ `callGeminiText()` 已在 2026-10-10 删除，理由见文末） |
| `app/api/ai/excerpt/route.ts` | 传 `thinkingBudget: 0`；输出要过验收（数数残渣 / 被截断 / 太短 → 换模型或重试）；英文栏拒绝拿中文正文生成；像 `callText` 一样换 `AI_MODEL_FALLBACK` 兜底 |
| `lib/storyPrompt.ts` | 新增 `isCountLeak()` / `stripCountLeak()`（认 + 清数数残渣）、`isMostlyChinese()`、`pickChineseOriginal()`（中文原稿到底在哪一边；纯函数，好测） |
| `app/admin/(protected)/trends/edit/page.tsx` | 翻译改用 `pickChineseOriginal()`：中文停在英文页签里也能找回来，并放回「中文原稿」（保存时才会落进 `content_zh_html`）；报错改成「中文原稿还是空的：先切到「中文原稿」页签写完正文」；摘要按钮同样拦住「英文页签 + 中文正文」；新建稿的页签初值改成 `'zh'` |
| `scripts/p9-excerpt-check.mts` | 复验脚本：13 条纯函数断言 + 三组真 HTTP（zh 长文 / en 撞中文 / en 长英文），跑完自动删临时账号 |

### 复验

```bash
cd ~/Desktop/Sass && node --import ./scripts/_ts-resolve.mts scripts/p9-excerpt-check.mts
# 期望输出：结果：63 通过 / 0 失败（离线断言 + 真调摘要 + 自检接口 + 记忆复用）
# 只想跑不联网的那部分：P9_OFFLINE=1 … → 结果：40 通过 / 0 失败
```

### 怎么一眼认出这类「脏输出」

- 终端里出现 `[aiGemini] <模型> 输出摸到 maxOutputTokens 上限了（finishReason=MAX_TOKENS）`；
- 响应里 `thoughtsTokenCount` 接近 `maxOutputTokens`（说明额度都被思考吃了）；
- 想看模型到底在「想」什么：临时加 `generationConfig: { thinkingConfig: { includeThoughts: true } }`，
  思考内容会以 `parts[].thought === true` 返回（**只在排查时开**，正式代码里一律过滤掉）。


## 附录：两个模型同时报错 + 提示框糊满屏幕（2026-10-10 后台，站长截图）

### 症状

点「生成摘要」/「母语化重写 → 英文」，红色提示几乎占满一行：

```
主模型 gemini-3.8-flash 失败：Gemini 429: { "error": { "code": 429, "message":
"You exceeded your current quota… ｜ 兜底模型 gemini-3.5-flash 也失败：
Gemini 429：这个模型的免费额度已经用完。① 等额度恢复；② 换模型
（AI_STORY_MODEL / AI_REVISE_MODEL / AI_TRANSLATE_MODEL / AI_UTIL_MODEL…）
```

3.5 秒后消失。**能读到的东西只有「又挂了」三个字。** 数据本身没坏（摘要栏里上次的内容还在）。

### 四个真根因（都不是「Google 挂了」这么简单）

1. **429 一律被判成「当日额度用尽」。** 判据是 `/quota|billing|free tier|plan/` 去匹配 message，
   而 Google 对**每分钟限流（RPM）**和**每日额度用尽（RPD）**回的 message 一字不差。
   → 一个「等 20 秒就好」的限流被说成「去换模型 / 等明天」，把人往错的方向指。
   **真判据**：`error.details[]` 里 `QuotaFailure.violations[0].quotaId`
   （`…PerDay…` = 日额度；`…PerMinute…` = 限流）+ `RetryInfo.retryDelay`（`"23s"`）+ 响应头 `Retry-After`。

2. **一次失败把两条错误拼起来。** `主模型 X 失败：… ｜ 兜底模型 Y 也失败：…` ——
   两个模型同时 429 时这两句**长得一模一样**，信息量等于零。
   → 现在同一类原因只说一句：「`gemini-3.8-flash、gemini-3.5-flash 都在限流：约 20 秒后恢复，再点一次就行`」。

3. **兜底只有一级，且没有记忆。** 旧代码写死 `[主模型, 兜底]`，两个池子一起干了就真没路；
   而且每次点击都从头再问一遍**已经挂掉**的模型（429 还在继续吃 RPM 计数）。
   → `AI_MODEL_FALLBACK` 现在支持**逗号分隔的一串**；失败的模型进进程内冷却表（rate/quota/5xx 都算），
   冷却期内直接跳过它。真全挂了且只是限流，还会按对面给的 `retryDelay` **原地等一次**再打
   （摘要那条路 `autoWaitMs: 8000`）。

4. **`/api/ai/excerpt` 走的是一条「假兜底」。** 它绕过 `callText` 自己拼候选：
   `GEMINI_ENDPOINT(兜底模型)` → 一旦 `AI_MODEL_FALLBACK` 按文档配成别的供应商
   （`deepseek:deepseek-chat`），URL 就成了 `models/deepseek%3Adeepseek-chat:generateContent` → **404**。
   而且它读的是 `GEMINI_MODEL`，文档却说杂活任务用 `AI_UTIL_MODEL`。
   → 摘要路由改走 `callText({ task: 'util' })`；`callGeminiText()` / `getGeminiConfig()` 已删除
   （全项目只有它在用，留着就是第二套 429 判断）。

### 改动

| 位置 | 改动 |
| --- | --- |
| `lib/aiGemini.ts` | 新增 `parseProviderError()` / `parseRetryDelay()` / `logProviderError()`：真正解析 `details[].quotaId` 与 `RetryInfo.retryDelay`、`Retry-After`；`describeProviderError()` 改成按 `kind` 说话，429 那句从 150 字压到 45 字；**删掉 `callGeminiText()` / `getGeminiConfig()`**（不再有第二套调用路径） |
| `lib/aiProvider.ts` | `AI_MODEL_FALLBACK` 支持逗号/换行分隔的一串（`parseModelChain()`）；进程内冷却表（rate/quota/5xx）+ `autoWaitMs` 等待重试；`totalBudgetMs` 兜住整条链的总时长；失败信息收敛成一句（`composeFailure()`）；真实状态码不再被改写成 502 |
| `app/api/ai/excerpt/route.ts` | 改走 `callText({ task: 'util' })`（跨供应商兜底不再是 404）；输出不合格时换兜底链第一个模型再问一次；`fresh: true` 可强制重问 |
| `lib/aiMemo.ts`（新） | 摘要类「同样输入 → 同样输出」的任务：5 分钟内重复点复用上次结果，并做并发去重（连点三下不再烧三份额度）。**翻译故意不用** —— 那个按钮的语义就是「换一版」 |
| `app/api/ai/status/route.ts`（新） | 🩺 自检：`GET` 只读配置（不花额度）；`?probe=1` 并行真调每个模型（20 秒超时，`ignoreCooldown`） |
| `app/admin/_components/AiHealthCard.tsx`（新） | 编辑页右侧栏最上面那张「AI 自检」卡（默认收起）：任务→模型、兜底链、哪把 Key 缺了、谁在冷却、真调结果 |
| `app/admin/(protected)/trends/edit/page.tsx` | 提示框：最大宽度 560px + 允许换行 + 点一下可关；错误留 8 秒（原 3.5 秒）；连续两条不再互相掐断定时器；429 且 `retryAfterMs ≤ 8s` 时自动等一次再重发；模型类错误末尾指路「右侧 AI 自检」 |
| `app/api/ai/translate/route.ts` | 错误响应带上 `kind` / `retryable` / `retryAfterMs` / `tried`；补 `totalBudgetMs: 52000` |

### 怎么查（不用再猜）

编辑页右侧栏点开「🩺 AI 自检」→「只查配置」（不花额度）或「真调一次」（花一点点，给真话）。
命令行等价物：

```bash
cd ~/Desktop/Sass
P9_OFFLINE=1 node --import ./scripts/_ts-resolve.mts scripts/p9-excerpt-check.mts   # 40 条离线断言，不联网
P9_SKIP_MODELS=1 node --import ./scripts/_ts-resolve.mts scripts/p9-excerpt-check.mts # 离线 + 打自检接口，不花模型额度
node --import ./scripts/_ts-resolve.mts scripts/p9-excerpt-check.mts                 # 全量 63 条（会真调 4 次模型）
```

脚本里新增的那几段：**A2** 429 归类（RPD/RPM/只有响应头/什么线索都没有）、**A3** 兜底链拆分、
**C** 自检接口的 JSON 形状、**D** 同一段正文连点两下（第 2 下必须 `cached: true` 且秒回，
带 `fresh: true` 时必须真的重问）。

### 现场实测（2026-10-10 当天，别被「429」这个标签骗了）

自检接口 `?probe=1` 的真实回包：

| 模型 | 结果 |
| --- | --- |
| `gemini-3.8-flash`（当时的主模型） | **503 / 挂起 >20 秒** —— 它根本**不是** 429，是**模型本身在生病** |
| `gemini-3.5-flash`（兜底） | ✅ 1.5 秒回 |

`ListModels` 显示两个名字都在列表里（62 个模型中 45 个是 gemini 系）—— 名字没错，就是 3.8 那阵子不稳。
**结论：直接换模型最快，不用改代码。** 当时可用的 Flash 档：
`gemini-3.5-flash` / `gemini-3.6-flash` / `gemini-3.7-flash` / `gemini-flash-latest`。

```bash
# .env.local —— 六行一起改成同一个「活着」的模型；兜底留一串不同的
GEMINI_MODEL=gemini-3.5-flash
AI_MODEL=gemini-3.5-flash
AI_STORY_MODEL=gemini-3.5-flash
AI_REVISE_MODEL=gemini-3.5-flash
AI_TRANSLATE_MODEL=gemini-3.5-flash
AI_UTIL_MODEL=gemini-3.5-flash
AI_MODEL_FALLBACK=gemini-3.6-flash, gemini-3.7-flash
# 改完必须重启 npm run dev（Next 只在启动时读 .env.local）
```

### 顺便修掉的三个小坑

- **超时被当成「挂了」**：自检探测最初只给 10 秒，把「慢」判成「不可用」——自检给错答案比不给更糟，改成 20 秒并**并行**探测（串行 4×20 秒会顶爆 `maxDuration=60`）。
- **慢失败拖住每一次点击**：主模型不健康时，每次调用都要先陪它耗完超时才轮到兜底。现在 5xx / 超时 / 网络断也会进 **45 秒冷却**，冷却期内直接走兜底。
- **重试时机**：旧代码限流后固定等 1.2 秒重试（对面说的是 20 秒 —— 白送一次失败）。现在听对面的 `retryDelay`，上限 10 秒。

## 附录：四个候选全挂，屏幕上却只写「还在冷却（剩 4 秒）」（2026-10-26 后台）

### 症状

点「AI 生成」一律失败，红字只有一句：

> `gemini-3.5-flash 都刚失败过，还在冷却：最快 4 秒后可以再点`

等 4 秒再点，还是同一句。终端里也只有一句聚合后的 error —— **到底谁挂了、为什么挂，一个字都看不到**。

### 实测（同一天逐个直连，不是猜的）

| 供应商 | 模型 | 真实回包 |
| --- | --- | --- |
| Gemini 直连 | `gemini-3.5-flash` / `gemini-3.6-flash` | **429**，`quotaId=GenerateRequestsPerDayPerProjectPerModel-FreeTier` → 当日额度，约 4.5 小时后重置 |
| Gemini 直连 | `gemini-3.7-flash` | **20 秒超时**（慢失败） |
| Gemini 直连 | `gemini-3.8-flash` | **503** |
| Groq | `openai/gpt-oss-20b` | **能过**，但响应头 `x-ratelimit-limit-tokens: 8000`（免费档 TPM）；长文提示词 + `max_tokens: 8192` → **413**，`code: rate_limit_exceeded` |
| OpenRouter | `deepseek/deepseek-chat` | **402**，`total_credits: 0`（"can only afford 3914 tokens"，我们要 8192） |
| 硅基流动 | `deepseek-ai/DeepSeek-V3.2` | **402 / `code: 30001`** 余额不足（同一把 Key 打 `.cn` 更狠：`30014 Token is invalid`） |

结论：四个候选里**没有一个真的「被限流」** —— 两个余额为 0、一个单次请求超 TPM、一个当日额度用尽。

> **同一天 11:00 复测（别把早上的结论当永久结论）**：`gemini-3.5-flash` / `gemini-3.6-flash`
> 已经恢复（8192 也过），Groq 短提示词能过、真实长提示词仍 413，OpenRouter 余额只够 ~3386 token
> （600 能过、8192 回 402），硅基流动仍是 `402 / 30001`。**每日额度是按模型分池的，几小时就会自己回来。**

### 2026-10-26 下午：兜底换成 OpenRouter 免费档（怎么挑、怎么读 429）

站长要求把 `AI_MODEL_FALLBACK` 换成「OpenRouter 上最新的免费长文本模型」。这类活儿**先查目录再改配置** ——
一个拼错或已下线的 ID，线上表现就是 404「模型名不存在」，看上去跟「服务挂了」没什么区别。

```bash
# ① 查目录（公开接口，不用 Key）：还有谁带 :free、上下文多长（2026-10-26 共 464 个模型）
curl -s https://openrouter.ai/api/v1/models -o /tmp/m.json && node -e "for(const m of require('/tmp/m.json').data.filter(x=>x.id.endsWith(':free')))console.log(m.context_length+'\t'+m.id)"

# ② 查这把 Key 的余额/档位（is_free_tier=true 就是免费档，429 会按上游池算）
curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY"
```

逐个真调（`:free` pricing=0，不扣余额；1024 = 摘要/杂活形状，8192 = `/api/ai/story` 的真实形状）：

| 模型 | 上下文 | 1024 | 8192 | 结论 |
| --- | --- | --- | --- | --- |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1M | ✅ 2.3s | ✅ 1.8s | 进链，第一顺位兜底 |
| `nvidia/nemotron-3.5-lightning:free` | 1M | ❌ 空内容 + `finish_reason=length` | ✅ 14.7s | 进链；推理模型，摘要类小额度顶不上 |
| `nvidia/nemotron-3.5-super-vl:free` | 1M | ✅ 39s | ✅ 2.5s | 进链；小额度慢过 excerpt 的 22s 超时 |
| `meta-llama/llama-3.3-70b-instruct:free` | — | 目录里**不存在** | — | 不写（llama 系列现在一个 `:free` 都没有） |
| `xingchen-agi/xing4.0-29b-a4b:free` | 262k | ❌ 429 | ❌ 429 | Phala 上游池被占满 |
| `recursive/flint-v1.0:free` | 262k | 429（时好时坏） | ✅ 0.98s | 备用 |
| `google/gemma-4-31b-it:free` | 262k | ❌ 429 | ❌ 429 | 备用 |
| `thinkingmachines/inkling:free` | 1M | ❌ **403** | — | 账号没权限，别写进链 |

三条免费档专有的规矩：

1. **`:free` 一个字符都不能省** —— 省了就是付费模型，这把 Key 只够 ~3386 token，长文直接 402。
2. **免费档的 429 不是「你的次数用完了」**：响应里 `metadata.limit_source = upstream_provider_shared_pool`，
   是**上游供应商的公共池**满了，和账号无关 → 只有换**不同供应商**的模型才有用；都挂了就等十几秒
   （`rate` 冷却 15 秒，表里的冷却逻辑会自动再试）。
3. **推理型模型（lightning）给太小的 `max_tokens` 会返回空内容**（`finish_reason=length`）。
   现在的代码把这种失败标成 `badrequest`「maxOutputTokens 太小、被思考吃光」，不会再伪装成 `server`。

现状配置（改完**必须重启 `npm run dev`**，Next 只在启动时读 `.env.local`）：

```bash
AI_MODEL_FALLBACK=gemini-3.6-flash, openrouter:nvidia/nemotron-3-ultra-550b-a55b:free, openrouter:nvidia/nemotron-3.5-lightning:free, openrouter:nvidia/nemotron-3.5-super-vl:free
```

> 免费档只适合「Gemini 当天额度用完」顶一阵，不适合当主力：上游池随时 429。要长期稳还是充值
> （OpenRouter 满 $10 起解除免费档限制、硅基流动 ¥10 起），或把 `AI_UTIL_MODEL` 单独指向便宜的小模型。

### 三个代码缺陷（这才是「看不出原因」的真凶）

1. **`parseProviderError()` 不认识 402 / 413** → 一律落到 `unknown`。后果有三层：
   - 不进冷却表（下一次点击照样白打一遍）；
   - 提示语是原文 `报 402：Sorry, your account balance is insufficient`，把「该充钱」说成「服务异常」；
   - `KIND_PRIORITY.unknown = 7`，比 `rate` 还「不重要」。
2. **`composeFailure()` 用 `KIND_PRIORITY` 挑主因，而冷却条目（`cold`）挂在 `kind='rate'`** → 优先级 5，
   比真实死因的 7 靠前。于是「上一轮留下的冷却提示」把「余额不足 / 超 TPM」全盖住了。
3. **三个路由只打聚合后的 `error`**：`details` 这种东西根本不存在，终端里复盘不出「谁、为什么、HTTP 几」。

### 改动

- `402 → quota`（冷却 **10 分钟**）、`413 → toolarge`（新 kind，冷却 60 秒）；`markCooldown` 都收。
- `composeFailure()`：**`cold` 条目永远不担任主因**，主因只在「这一轮真发过请求」的候选里挑；
  全部都是冷时才退回用它们（并回 429，绝不回 `status: 0`）。
- `cold` 条目带上「上次是什么原因」，措辞改成
  `gemini-3.5-flash → 额度/余额不足；本轮没问：冷却中，剩 4 秒` —— 「没问」和「问了挂了」不再混为一谈。
- `CallTextResult.details: string[]`：一行一个候选；`/api/ai/story`、`/api/ai/translate`、`/api/ai/excerpt`
  失败时把它打进终端、也放进响应体（提示框只有一行宽，装不下）。
- 自检 `summarize()`：先按 kind 统计（`quota×2、toolarge×1`），再**单独点名 402**
  —— 「其中 X 是余额不足（HTTP 402），必须充值才有额度」。
- 用户侧提示语按状态码分流：402 说「充值」，429 说「换模型 / 等重置」，413 说「调小 maxOutputTokens」。

### 错误对照表（现在的口径）

| HTTP | `kind` | 冷却 | 提示语在说什么 | 该怎么办 |
| --- | --- | --- | --- | --- |
| 401 / 403 | `auth` | 不冷却 | Key 被拒 / 没权限 | 改 `.env.local` 的 Key（改完立刻能试，不用等） |
| 402 | `quota` | 10 分钟 | **余额不足**（OpenRouter credits=0、硅基流动 30001） | **充值**，或换一家有额度的供应商 |
| 429 + `perDay/daily` 或 `retryDelay > 2min` | `quota` | 60 秒起 | 免费额度用完了 | 换模型（同供应商换模型不一定有用：额度按模型分池） |
| 429（其余） | `rate` | 15 秒起 | 被限流，约 N 秒后恢复 | 缓一下再点 |
| 404 | `notfound` | 不冷却 | 模型名不存在 / 这把 Key 用不了它 | 核对模型 ID（带斜杠的别漏 `groq:` / `siliconflow:` 前缀） |
| 400 / 422 | `badrequest` | 不冷却 | 请求被模型拒绝（附对面原话） | 看终端里的原文 |
| 413 | `toolarge` | 60 秒 | 单次请求超每分钟 token 上限（Groq 免费档 8000 TPM） | 调小 `maxOutputTokens` 或换模型 |
| 5xx / 超时 / 断网 | `server` | 45 秒 | 服务暂时不稳定 | 等几秒重试（会自动走兜底） |

### 自助排查（别靠提示框猜，直接打）

```bash
# ① 硅基流动（只认国际站 .com；.cn 会回 30014 Token is invalid）
curl -s -w '\n%{http_code}\n' https://api.siliconflow.com/v1/chat/completions \
  -H "Authorization: Bearer $SILICONFLOW_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-ai/DeepSeek-V3.2","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'

# ② OpenRouter 还剩多少钱（0 就是 402 的根源）
curl -s https://openrouter.ai/api/v1/credits -H "Authorization: Bearer $OPENROUTER_API_KEY"

# ③ Groq 的限流额度（看 x-ratelimit-limit-tokens）
curl -s -D - -o /dev/null https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"openai/gpt-oss-20b","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'
```

后台「AI 自检」→ **「真调一次」** 会无视冷却表（`ignoreCooldown: true`），
刚充完值立刻想验证就走它；它探测时 `maxOutputTokens` 只有 32，**测不出余额和 TPM 上限** ——
这两类问题只有真的写一篇才会露出来，所以失败时务必看终端里那几行「候选逐条」。

**复验脚本**：[`scripts/p12-ai-candidates-probe.mts`](../scripts/p12-ai-candidates-probe.mts) —— 一条命令看全「谁挂了、为什么挂」：

```bash
cd Sass
# A 离线分类断言 + B 配置解析（前缀对不对）+ C 逐个真调（花少量额度）
node --import ./scripts/_ts-resolve.mts scripts/p12-ai-candidates-probe.mts

# 额度紧张时只看 A/B，一次网络都不发
P12_OFFLINE=1 node --import ./scripts/_ts-resolve.mts scripts/p12-ai-candidates-probe.mts

# 按「写正文」的真实形状测（story 路由就是 maxOutputTokens 8192）—— 413 / 402 只有这个尺寸才现原形
P12_MAX=8192 node --import ./scripts/_ts-resolve.mts scripts/p12-ai-candidates-probe.mts
```

脚本 B 段会顺带钉住一个容易错的点：`deepseek-ai/DeepSeek-V3.2` 这种**裸写**会被判成 OpenRouter，
硅基流动必须写 `siliconflow:deepseek-ai/DeepSeek-V3.2`。

## 相关：翻译的第二层兜底（2026-10-13）

这篇讲的全是 **LLM 那半边**：模型 429 / 503 / 网络断、冷却、跨供应商的兜底模型链。
翻译现在还有**第二层**：当 `AI_MODEL_FALLBACK` 里的模型**全都**失败时，`/api/ai/translate`
会自动降级到传统机器翻译（DeepL / Google / Microsoft / LibreTranslate），
响应里带 `degraded: true` 并提示站长重译一遍。

- **配置与原理**：[`docs/translation-layered-architecture.md`](./translation-layered-architecture.md)
  （为什么 MT 只能当兜底、不能当首选；四家的 Key 怎么配；缺 Key 为什么只是跳过）
- **自检里怎么看**：`GET /api/ai/status` 的 `data.mt`；后台「AI 自检」卡片里的
  「翻译兜底 · 传统 MT」一块（没配时是灰色的 info，不是红字）
- **复验脚本**：`scripts/p10-translation-fallback.mts`
  （`P10_OFFLINE=1` 可纯离线跑，不动额度、不用开 dev server）

