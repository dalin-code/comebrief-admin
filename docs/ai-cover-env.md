# 线上 AI 封面报 `Missing env: CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN` 怎么修

后台编辑页点「AI 生成 / AI 重绘」，红框内容是：

```
封面生成失败：Missing env: CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN
```

本地一切正常、只有线上（`admin.comebrief.com`）这样，基本可以直接断定：
**Vercel 项目的环境变量里没有这两项**。本文记录原因与修复步骤。

## 根因

- `/api/ai/draw` 通过 `process.env.CLOUDFLARE_ACCOUNT_ID` / `process.env.CLOUDFLARE_API_TOKEN`
  读 Workers AI 凭据（见 `app/api/ai/draw/route.ts` 的 `getCfAccountId()` / `getCfToken()`）。
- 仓库根的 `.env.local` 在 `.gitignore` 里，**不会随代码上传**。Next.js 在 Vercel 上只把
  「项目 Settings → Environment Variables」注入 `process.env`，不会去读一个没上传的文件。
- 代码里的 `patchCloudflareEnvFromFiles()` 只是给「自托管、仓库根真的有 `.env.production` / `.env`」
  的场景兜底；Vercel 的运行时目录（`/var/task`）里没有这些文件，所以线上它什么也补不到。
- 于是本地 `npm run dev` 能出图，线上同一个按钮只会 500 + 上面那句。

> 顺带说明：`NEXT_PUBLIC_CLOUDFLARE_*` 这两个别名也会被读取，但把服务端 Token 写成
> `NEXT_PUBLIC_` 会被打进浏览器包 —— **不要**为了「让它生效」改成公开变量。

## 修法一：一键同步（推荐）

`scripts/set-deploy-env.mts` 已经能按域名自动找到 Vercel 项目，并把 `.env.local` 里的
Cloudflare 两项以 `encrypted` 写进 `production,preview`，最后触发一次生产部署：

```bash
cd Sass
# Vercel → Account Settings → Tokens → Create 拿一个 token
VERCEL_TOKEN=xxx ONLY_CLOUDFLARE=1 node scripts/set-deploy-env.mts
```

`ONLY_CLOUDFLARE=1` 会跳过 `CRON_SECRET` / `SUPABASE_SERVICE_ROLE_KEY` / GitHub Secret，
只写封面用的两项并重新部署 —— 只修封面时建议带上，避免顺带改写定时发布的密钥。

脚本会回读变量清单，六项应全部是 ✅（`ONLY_CLOUDFLARE=1` 时只看 Cloudflare 那两项）：

```
   ✅ CRON_SECRET                production,preview
   ✅ SUPABASE_SERVICE_ROLE_KEY  production,preview
   ✅ CLOUDFLARE_ACCOUNT_ID      production,preview
   ✅ CLOUDFLARE_API_TOKEN       production,preview
   ✅ GROQ_API_KEY               production,preview
   ✅ SILICONFLOW_API_KEY        production,preview
```

`GROQ_API_KEY` / `SILICONFLOW_API_KEY` 是选填项（各是一个 OpenAI 兼容供应商）：
本地 `.env.local` 里有就同步、没有就提示一句跳过，不影响封面和定时发布。

⚠️ 这两家都**必须**在模型写法里带前缀（`groq:openai/gpt-oss-20b`、`siliconflow:deepseek-ai/DeepSeek-V3.2`）——
它们的模型 ID 自带斜杠，不写前缀会被当成 OpenRouter。硅基流动还只认国际站
`api.siliconflow.com`：同一把 Key 打 `.cn` 会回 `30014 Token is invalid`。
另外 Key 配好 ≠ 能用：余额为 0 时照样每次都是 HTTP 402 / `code 30001`。

不带 `ONLY_CLOUDFLARE=1` 时，脚本会把 `CRON_SECRET` 与 `~/.comebrief-cron-secret`
对齐、并尝试同步 GitHub Actions Secret（幂等；本机没装 `gh` 时会打印手工步骤）。
如果你不确定它们原来是否一致，优先用上面的 `ONLY_CLOUDFLARE=1`。

## 修法二：手工配

1. Cloudflare 控制台 → Workers & Pages → 右侧 **Account ID**，复制；
2. Cloudflare → My Profile → API Tokens → Create Token → **Workers AI** 模板，复制 token；
3. Vercel → 挂 `admin.comebrief.com` 的项目 → Settings → Environment Variables，各建一条：
   `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`，**Production + Preview 都要勾**；
4. Deployments → 最新那条 → **Redeploy**。

第 4 步不能省：Vercel 的环境变量只在**新部署**里生效，旧 deployment 继续读旧环境。

## 怎么确认配好了

1. 编辑页右侧栏 → 🩺 **AI 自检** → 「只查配置」，`CLOUDFLARE_ACCOUNT_ID` /
   `CLOUDFLARE_API_TOKEN` 两行应显示 **✓**（它们和 LLM 的 Key 一起列在「Key」那一行）。
   命令行等价物：

   ```bash
   curl -sS -H "Authorization: Bearer <站长登录票>" \
     "https://admin.comebrief.com/api/ai/status" | python3 -m json.tool
   ```

2. 再点一次「AI 生成」。这次如果还报错，错误已经不是缺变量，而是 Cloudflare 侧的
   鉴权 / 权限 / 模型问题（例如 token 不是 Workers AI 模板生成的、Account ID 与 token 不属于同一账号），
   按路由返回的 `hint` 处理即可。

## 常见误判

| 现象 | 真正原因 |
|---|---|
| 本地出图正常，线上报缺变量 | Vercel 没配这两项，或只配了 Development |
| Vercel 里明明有，还是报缺 | 配完没 Redeploy；或配到了另一个项目（域名不在那个项目上） |
| 配了仍报 `Authentication error` / `10000` | token 不是 Workers AI 的 REST token，或 Account ID / token 不同账号 |
| 报 `7000 No route for that URI` | 模型 ID 被整体 URL 编码了 —— 代码已用 `cfRunUrl()` 保留 `/`，不是环境变量问题 |
