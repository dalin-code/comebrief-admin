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
