# 前台缓存即时刷新（On-demand Revalidation）+ 话题矩阵是页签真源

## 一、话题矩阵 = 前台页签的唯一真源（2026-10-16 改）

站长的要求原话：「管理后台新增一个标签并拖到对应位置，保存后前端页面的位置与后台
保持一致；后台删掉某个标签并保存，前端同步隐藏该标签，该标签下的文章统一放到
Other；前端上线后注意缓存更新。」

| 后台动作 | 落库 | 前台表现 |
|---|---|---|
| 新增话题（编辑器「运营配置」里输入 + 保存/发布） | 保存**成功之后**把名字补进 `categories` | `/briefs` 页签立刻出现（计数 0 也显示，位置按后台顺序） |
| 拖动排序 | `POST /api/admin/categories/reorder` → 第 i 个话题 `created_at = 2026-01-01 + i 秒` | 页签顺序与后台一模一样 |
| 删除话题 | `POST /api/admin/categories/delete` → 先把名下文章并进 `Other`，再删 `categories` 那一行 | 页签消失；那些文章出现在 `Other` 下 |

* 前台实现：ComeBrief `lib/categories.ts` 的 `categoryTabs(articles, preferredOrder)`
  —— `preferredOrder` 就是 `app/(public)/briefs/page.tsx` 从 `categories` 表按
  `created_at,id` 读出来的那一串，页签照抄它（含还没有文章的话题）。
  文章里出现、矩阵里没有的话题按字母序补在最后（历史脏值不至于让文章「无处可去」）。
  真源读不到时退回 `CATEGORY_ORDER` 的旧行为，页签少几个好过整页崩掉。
* 「新增话题」只在保存那一刻落库：编辑器的输入框加的是本地 state
  （`showToast('新话题就绪')`），点保存/发布才写 `categories`。
  ⚠️ 这段补库逻辑曾经跑在**登录校验与文章写库之前**，保存半途失败就会留下一个
  「后台矩阵里有、articles.category 里 0 行」的孤儿话题 —— 前台永远不给它页签，
  正是站长看到的「后台加了标签，网站没显示」。现在它挪到写库成功之后
  （`app/admin/(protected)/trends/edit/page.tsx` 的 `upsertCategories`）。

## 二、缓存：从「最多一分钟」到「一两百毫秒」

前台 `/`、`/briefs`、`/briefs/[slug]` 都是 ISR（`revalidate = 60`）。后台改完
只靠 ISR 的话，站长点完保存就去刷新页面，看到的还是旧版。

| 环节 | 位置 | 说明 |
|---|---|---|
| 前台接收 | `ComeBrief/app/api/revalidate/route.ts` | 校验 `REVALIDATE_SECRET`，`revalidatePath` 刷 `/`、`/briefs`、`/briefs/[slug]`（动态路由按 `page` 型失效）；只认白名单路径 |
| 服务端转发 | `Sass/app/api/admin/revalidate/route.ts` | `requireAdmin` 鉴权后由服务端拿密钥打前台 —— 密钥不进浏览器 |
| 通知逻辑 | `Sass/lib/revalidateFrontend.ts` | 5 秒超时、**永不抛错**、没配变量就跳过并记一行日志 |
| 触发点 | `categories/reorder`、`categories/delete`、`trends/edit` 保存成功路径 | 全部在**写库成功之后**；保存失败不刷前台（否则「页面动了内容没变」更像坏了） |

## 三、必做配置

前台（ComeBrief）和后台（Sass）两个 Vercel 项目都要加，`REVALIDATE_SECRET`
两边填**同一个值**：

```
REVALIDATE_SECRET=<随机长字符串>
```

后台（Sass）再加一个前台地址（不配就认 `NEXT_PUBLIC_SITE_URL`）：

```
FRONTEND_REVALIDATE_URL=https://www.comebrief.com/api/revalidate
```

没配全套时的行为（都不会报错）：

| 缺什么 | 结果 |
|---|---|
| 前台没有 `REVALIDATE_SECRET` | 前台接口回 503 并点名变量；后台日志记一行「跳过」，前台最多 60 秒后自己刷新 |
| 后台没有 `REVALIDATE_SECRET` / 地址 | 后台直接跳过通知（`skipped: true`），后台 toast 会写「最多一分钟后按这个顺序排」 |
| 前台接口超时 / 502 | 后台日志记一行，不影响已保存的内容 |

## 四、自检

```bash
# 前台：密钥正确 → {"ok":true,"revalidated":["/","/briefs","/briefs/[slug]"]}
curl -sS -X POST "https://www.comebrief.com/api/revalidate" \
  -H "x-revalidate-secret: $REVALIDATE_SECRET"

# 密钥不对 / 没带 → 401
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "https://www.comebrief.com/api/revalidate"
```

后台侧的返回里带 `frontend` 字段（`ok` / `skipped` / `error`），后台 toast 直接
用它决定文案是「前台已同步刷新」还是「最多一分钟后」。
