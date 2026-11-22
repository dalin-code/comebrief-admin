# Quiz Studio（真实后台）

入口：`/admin/quiz-studio`（侧边栏「QUIZ STUDIO 工作台」）。

这是 `/mockup/quiz-studio` 静态稿的落地版：六屏保留，但列表、操作、矩阵保存、
分类统计、待放行队列、前台预览全部接真实数据。旧 `/admin/quizzes` 列表仍然保留，
作为 fallback；新建/批量导入保存后也会回到这个新工作台。

## 六屏分别做什么

| 屏 | 真实数据 / 动作 |
| --- | --- |
| 列表 | 读 `quizzes` 全表；按分类、状态、关键词筛选；按健康分从低到高排；点行打开详情抽屉 |
| 详情抽屉 | 显示封面、状态、健康检查、分类、前台地址、题目/结果预览；可编辑、主推、发布/下线、复制、删除 |
| 矩阵 | 只处理 `model: "axes"` 的卷；复用 `QuizAxesEditor` 的 0–3 权重表、全枚举、自动配平与右栏 12 项检查；保存写回 `raw_data` |
| 检查 | 对任意卷跑发布前检查；axes 卷与 CI 的 `check:quiz` 同源，旧卷按结构完整度检查；blocker 会锁发布 |
| 分类 | 用 `quizzes.categories` 实时聚合，slug 化后对应前台 `/quizzes/topic/[slug]`；点分类可跳回列表筛选 |
| 待放行 | 列出真实草稿 / 定时卷，按健康分排序；可检查、放行、删除 |
| 前台 | iframe 直接嵌真实 ComeBrief `/quizzes`（或某个 topic），不是第二套假前台 |

## 三个点菜单（真实动作）

- 查看详情
- 编辑内容 → `/admin/quizzes/create?id=...`
- 权重矩阵（仅 axes 卷）
- 打开前台
- 设为主推 / 取消主推
- 复制一份（剥掉 id / 时间戳，强制回到草稿，slug 加时间后缀）
- 发布上线 / 下线（有 blocker 时发布会被拦住）
- 删除（二次确认）

## 健康分口径

- **axes 卷**：`auditAxeQuiz()` + `enumerateAxe()`，12 项检查、全枚举命中率 / 平局率；
  与 `scripts/check-quiz.mjs` 同一份判据。
- **旧 score / personality 卷**：没有权重矩阵，只检查结构完整度（标题、题目、选项、
  结果、分类、封面、题量、结果名）。不伪造命中率或浏览量。
- 列表 / 检查 / 待放行共用 `lib/quizStudio.ts` 的 `quizHealth()`，不会出现三处分数不一样。

## 数据与地址

- 分类可能是数组，也可能是历史 CSV 字符串；`quizCategories()` 统一归一。
- 前台地址优先读 `NEXT_PUBLIC_SITE_URL`；本地默认 `http://localhost:3000`，
  线上未配置时退回 `https://comebrief.com`。
- 主题页不存在「跑归并脚本」这一步：改 `quizzes.categories`，列表、主题页、sitemap
  会一起变。全中文分类没有可用 slug，不会生成主题页。

## 分类词表（2026-11-22 统一）

后台分类按钮、前台 `/quizzes` 页签、`/quizzes/topic/<slug>`、`quiz_topics` 表现在是
**同一份 6 个分类**，顺序固定：

| # | 分类 | slug | 旧词（只做反查，不再写库） |
|---|---|---|---|
| 1 | `Career` | `career` | Future / Work |
| 2 | `Personality` | `personality` | Persona / Archetypes / MBTI |
| 3 | `Pop Culture` | `pop-culture` | Sports / Entertainment / Trivia & Knowledge / Technology |
| 4 | `Relationships` | `relationships` | Social / Love / Dating |
| 5 | `Lifestyle` | `lifestyle` | Lifestyle & Aesthetics / Aesthetics |
| 6 | `Mindset` | `mindset` | Subconscious / Mental / Emotions |

- 候选值只有一份真源：`lib/quizKit.ts` 的 `QUIZ_TOPICS` → `QUIZ_CATEGORY_ORDER`；
  编辑器按钮（`lib/quizPack.ts` 的 `QUIZ_CATEGORIES`）与分类屏（`quizTopicList()`）都取它。
- 打开旧卷时，不在表内的分类值会**补在按钮列表末尾**，仍然可见、可点掉 ——
  不会出现「已选分类指向一个不存在的按钮」。
- 历史脏值（例如手打错字）在分类屏里垫底，等人工归并；不自动改写。

## 原型卷打开时的提示（红框已修）

`normalizeAxeQuiz()` 把结果分成两份：

| 字段 | 含义 | 编辑器行为 |
|---|---|---|
| `issues` | **真的改了数据**（权重越界夹住、未知原型 id 丢弃、名字补全…） | 绿色提示条「已自动纠正 N 处」 |
| `advisories` | 只提示、没动数据（缺 quadrant → 结果页退回雷达图） | 不弹条，避免合法卷一打开就是红色警告 |

另外：原型只写了 `quadrant`、没写 `color` 时，归一化阶段就按象限补
`AXE_QUADRANT_COLORS`（与前台 `lib/quiz-result.ts` 的兜底色同值），
所以「N 个原型没有 color」这条提示已经不存在了。

## 自动生成（Autopilot）没有接

静态稿的第 5 屏是一条完整 AI 流水线。当前后台没有接生成任务，所以「待放行」屏
只做真实队列：列出草稿 / 定时卷，人工检查后发布。没有假装在跑采集、成本或候选池。
等生成链路真的接上，再把 S1–S5 放回这一屏。

## 自检

```bash
npm run typecheck
npm run check:studio   # 分类归一 / 旧卷健康分 / 复制载荷 / 矩阵 raw_data
npm run check:quiz     # axes 全枚举与 12 项检查
npm run check:pack     # 批量导入解析 / 校验 / 归一化
```

`check:studio` 已加入 `.github/workflows/checks.yml`。
