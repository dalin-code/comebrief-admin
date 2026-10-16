# 定时发布（Scheduled Publishing）

## 问题

后台在 BRIEFS / STORIES / QUIZZES 里都可以选「定时」并写入 `scheduled_at`，
但**没有任何东西在到点后把 `status` 从 `scheduled` 翻成 `published`**，
于是定时内容会永远停在那里。

## 解决

分两层，**不依赖外部调度器也能保持状态一致**。

### 第一层：后台列表页自愈（lib/scheduled.ts）

后台的 BRIEFS / STORIES / QUIZZES 列表页在加载时就会调一次 `publishDueRows()`，
把「已到点却还是 scheduled」的行真正翻成 `published`：

| 行为 | 说明 |
|---|---|
| 自愈触发 | `trends/page.tsx`（BRIEFS）、`stories/page.tsx`、`quizzes/page.tsx` 每次加载列表 |
| 手动入口 | BRIEFS 列表右上角的 **PUBLISH DUE** 按钮（外部定时器漏跑时的兜底） |
| 展示兜底 | `effectiveStatus()`：到点的定时内容一律显示为「已发布」（绿）—— 与前台可见性规则同源，即使写库被 RLS 拒绝，后台也不会再出现「前台已上线、后台写着定时」 |
| 幂等 / 降级 | 与下面的 cron 引擎完全一致（二次校验 status、缺列自动剔除字段重试） |

为什么必须有这一层：GitHub Actions 的定时任务在仓库长期无提交时会被自动停用，
Vercel Hobby 又不允许 `*/5` 的 cron —— 一旦外部定时器静默失效，光靠它就会出现
上面那种状态不一致。

### 第二层：`GET|POST /api/cron/publish` 引擎

新增 `GET|POST /api/cron/publish`（`app/api/cron/publish/route.ts`）：

| 行为 | 说明 |
|---|---|
| 扫描 | 三张表中 `status = 'scheduled'` 且 `scheduled_at <= now()` 的行 |
| 翻正 | `status = 'published'`，`published_at = scheduled_at` |
| 同步 `active` | `stories` 的前台是按 `active` 过滤的（ComeBrief 的 stories/page.tsx、首页、search 都带 `.eq('active', true)`），所以同时置 `active = true`；`quizzes` 前台不按 `active` 过滤，一并置真只为让两列保持一致、防止日后补过滤时踩雷 |
| 幂等 | update 时二次校验 `status = 'scheduled'`，重复调用不会重复发布 |
| 降级 | `published_at` / `publish_error` / `active` 等列不存在时自动剔除该字段重试 |

`published_at` 取的是 `scheduled_at` 而不是本次运行的 `now()`：
否则 cron 中断一段时间后一次性补发，多篇内容会拿到同一个时间戳，首页按时间排序就乱了。

### 调试用

```bash
# 只看会影响哪些行，不写库
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://admin.comebrief.com/api/cron/publish?dry=1"
```

## 必做配置

在 Vercel 项目环境变量里加：

```
CRON_SECRET=<随机长字符串>
SUPABASE_SERVICE_ROLE_KEY=<Supabase 的 service_role key>
```

### 一键配（推荐）

```bash
cd Sass
# 只配 Vercel（GitHub Secret 自己点网页）：
VERCEL_TOKEN=xxx node scripts/set-deploy-env.mts
# 顺手把 GitHub Actions Secret 也写了（本机有 gh 且已登录，或给 GH_TOKEN）：
VERCEL_TOKEN=xxx GH_TOKEN=xxx node scripts/set-deploy-env.mts
```

`scripts/set-deploy-env.mts` 做四件事，幂等、可重复跑：

1. 按域名 `admin.comebrief.com` 在 Vercel 里**自动找到**对应项目（不用猜项目名，个人名下和 team 下的项目都会翻；
   也可 `VERCEL_PROJECT=<项目名>` 直接指定）
2. 把两个变量以 `encrypted` 写进 `production,preview`，写完**回读项目的变量清单**证明真的进去了
3. 触发一次生产重新部署 —— 环境变量的改动**必须重新部署才生效**
4. 用 `gh` 把同一个 `CRON_SECRET` 写进 GitHub Actions Secret（没装 gh 就打印网页那三步）

密钥来源：`CRON_SECRET` 取「环境变量 → `~/.comebrief-cron-secret` → 都没有就随机生成 64 位十六进制并落盘（0600）」；
`SUPABASE_SERVICE_ROLE_KEY` 直接从仓库根的 `.env.local` 读 —— 脚本全程不打印值，只回读变量名。

### 手工配

| 位置 | 填什么 | 在哪 |
|---|---|---|
| Vercel 项目（挂 `admin.comebrief.com` 的那个） | `CRON_SECRET` | Settings → Environment Variables（勾 Production + Preview） |
| 同上 | `SUPABASE_SERVICE_ROLE_KEY` | 同上；值在 Supabase → Project Settings → API → `service_role` |
| Vercel | **重新部署一次** | Deployments → 最新那条 → Redeploy（不重新部署等于没配） |
| GitHub 仓库 `dalin-code/comebrief-admin` | `CRON_SECRET`（与上面同值） | Settings → Secrets and variables → Actions → New repository secret |

> 两处填的 `CRON_SECRET` 必须**一模一样**。本地那份落在 `~/.comebrief-cron-secret`
> （0600、**不带尾换行**，粘进后台不会多出一个空行），粘之前先 `pbcopy < ~/.comebrief-cron-secret`；
> 服务端 key 也能从本地直接拷：`grep -E '^SUPABASE_SERVICE_ROLE_KEY=' .env.local | cut -d= -f2- | tr -d '\n' | pbcopy`。
>
> 想确认线上到底认没认这两个变量，用 dry 跑一次（只读，不写库）：
> ```bash
> curl -sS -H "Authorization: Bearer $(cat ~/.comebrief-cron-secret)" \
>   "https://admin.comebrief.com/api/cron/publish?dry=1"
> ```
> 预期 200 + `"dry":true`；`503 CRON_SECRET is not configured` = 变量没生效（多半漏了 Redeploy 或改错了项目）；
> 不带 `Authorization` 再打一次应当拿到 **401**（拿到 503 说明变量还没生效）。

没配 `CRON_SECRET` 时，生产环境访问该路由会直接返回 **503**（避免出现一个裸奔的公开写接口）；
开发环境则放行，方便本地调试。

`SUPABASE_SERVICE_ROLE_KEY` 同样不能少：cron 引擎走的是 `getSupabaseAdminClient()`
（这条链路没有请求者身份可以退，和后台写接口不一样），缺它时 `/api/cron/publish` 只会 500，
一篇也翻不了。

> 线上实测（2026-10-16）：admin 这个 Vercel 项目**只配了 URL 和 anon key**，
> `SUPABASE_SERVICE_ROLE_KEY` / `CRON_SECRET` 都没配 —— 于是「到点自动翻正」这条路
> 从来没有跑通过，定时稿一直停在 `status = 'scheduled'` + `published_at = NULL`，
> 直到站长打开一次后台触发第一层自愈。
>
> 后台的话题排序 / 删话题接口已经不再受这个变量影响：它们改走
> `lib/supabaseAdmin.ts#getSupabaseWriteClient()` —— 有 service role key 就用它，
> 没有就退回站长那张登录票（`Authorization: Bearer <token>`，身份与浏览器直写等价），
> 并按「回读行数」校验写入真的生效。
> 但 cron 没有登录票可退，所以这一项仍然必配。

### 这两个变量没配时，前台表现如何（2026-10-16 起）

到点但还没被翻正的定时稿，`published_at` 仍是 NULL —— 前台已经不会再出现「到点了
首页什么都没有」，取数与渲染各兜了一层：

| 位置 | 处理 |
|---|---|
| 首页 / `/briefs` 取数 | `ComeBrief/lib/feed.ts#fetchVisibleArticles()`：除「已发布 + 按 `published_at` 倒序」外，再取一条「`status='scheduled'` 且 `scheduled_at <= now()`」的窗口合并进来 —— 否则这类行 `published_at` 为 NULL，会排在全部已发布内容后面被 `limit` 直接切掉（首页 limit 是 24，必现） |
| 卡片 / hero 上的日期 | `ComeBrief/lib/utils.ts#articleDate()`：`published_at` 为 NULL 时退到 `scheduled_at`，不再渲染成空白 |

也就是说「定时到点读者能不能看到」不再依赖调度器；调度器仍然决定
`published_at` 与后台列表里的状态是否被真正翻正。

## 触发方式（三选一）

### 方案 A：GitHub Actions（默认已启用，推荐）

`.github/workflows/publish-scheduled.yml` 已就位，每 5 分钟打一次接口。

需要在仓库 Settings → Secrets and variables → Actions 里配置：

| Secret | 是否必填 | 说明 |
|---|---|---|
| `CRON_SECRET` | 必填 | 与 Vercel 环境变量一致 |
| `ADMIN_BASE_URL` | 选填 | 默认 `https://admin.comebrief.com` |

装了 `gh` 的话一条命令就够（值从本地那份取，不进 shell 历史、不进聊天记录）：

```bash
gh secret set CRON_SECRET -R dalin-code/comebrief-admin --body-file - < ~/.comebrief-cron-secret
```

选它的原因：GitHub Actions 的定时任务**没有套餐限制**。

### 方案 B：Vercel Cron（需确认是 Pro 套餐）

⚠️ **Vercel Hobby 套餐只允许「每天一次」的 cron。**
如果在这个项目里写 `*/5 * * * *`，**部署会直接失败** —— 所以本仓库刻意没有提交 `vercel.json`。

确认后台项目在 Pro 套餐上之后，再新建 `vercel.json`：

```json
{
  "crons": [
    { "path": "/api/cron/publish", "schedule": "*/5 * * * *" }
  ]
}
```

配好 `CRON_SECRET` 后，Vercel 会自动带上 `Authorization: Bearer <CRON_SECRET>`，无需额外处理。

### 方案 C：外部 cron 服务

任何支持定时 HTTP 的服务（cron-job.org 等）都行，请求：

```
POST https://admin.comebrief.com/api/cron/publish
Authorization: Bearer <CRON_SECRET>
```

## 需要先完成的数据库变更

阶段 0 的 `ComeBrief/supabase/10_schema.sql` 必须先执行，
它负责补齐 `status`、`scheduled_at`、`is_featured`、`featured_order`、`published_at`、`publish_error`
这些列。代码侧已经做了缺列降级，但定时发布本身依赖这些列存在。
