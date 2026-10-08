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
```

没配 `CRON_SECRET` 时，生产环境访问该路由会直接返回 **503**（避免出现一个裸奔的公开写接口）；
开发环境则放行，方便本地调试。

## 触发方式（三选一）

### 方案 A：GitHub Actions（默认已启用，推荐）

`.github/workflows/publish-scheduled.yml` 已就位，每 5 分钟打一次接口。

需要在仓库 Settings → Secrets and variables → Actions 里配置：

| Secret | 是否必填 | 说明 |
|---|---|---|
| `CRON_SECRET` | 必填 | 与 Vercel 环境变量一致 |
| `ADMIN_BASE_URL` | 选填 | 默认 `https://admin.comebrief.com` |

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
