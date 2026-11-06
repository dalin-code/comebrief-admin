# Quiz Studio 静态稿（v1）

可点原型的唯一入口：`/mockup/quiz-studio`（`npm run dev` → http://localhost:3001/mockup/quiz-studio）。

这份东西**不是功能**，是给「taxonomy / 打分引擎 / 校验 / autopilot」四件事定形状的评审稿。
代码在 `app/mockup/quiz-studio/`，七个文件、零依赖、零 fetch、不碰数据库；评审完可以直接整目录删掉。

## 六屏分别要评审什么

| 屏 | 路由形态 | 要定的判断 |
| --- | --- | --- |
| 01 测验列表 | `/admin/quizzes` | 健康分是否进列表、是否可排序；一条低分卷在列表上能不能被一眼看到 |
| 02 权重矩阵 | 编辑器 Logic | 0–3 四档够不够；点格子循环 vs 输入框；「自动配平」的力度是否可信 |
| 03 发布前检查 | 编辑器右栏 / 整页 | 12 项够不够、blocker 与 warning 的分界；「发布后会发生什么」是否要提前列出来 |
| 04 分类矩阵 | `/admin/taxonomy` | 6 个 topic 够不够；旧的两套分类降级成 tag 是否可接受 |
| 05 自动出题 | `/admin/autopilot` | 前 30 天是否一律人工放行；雷区过滤放在 S2 而不是生成后是否同意 |
| 06 前台列表 | `/quizzes` | 一张卡只留一个 badge；筛选维度换成 topic 而不是字符串匹配 |

## 哪些是真算的

屏 02 / 03 的数字不是画上去的，改一格会真的变：

- `enumerate()`：8 题 × 4 选项 = **65,536 种答案组合全枚举**，得到每个原型的命中占比；
- `healthChecks()`：可达性、最低命中率 ≥12%、平局率 ≤8%、列合计极差、废选项、
  每题喂养原型数、结果名长度、题量 —— 逐条从数据推，blocker 扣 40 / warning 扣 4–10；
- `healthScore()`：`100 − 40×blocker − 4~10×warning`，和列表页展示的分数同一套口径。

演示用的小机关：`QUESTIONS` 第 6 题的 B 选项权重全 0（废选项 → `−4`）；
`ARCHETYPES` 最后一个名字故意 50 字（长名溢出 → `−5`）。给任意一格加 1 分，
对应的检查项会立刻转绿、健康分从 81 变 86。

## 哪些是假的

列表行、候选池、生成队列、成本（$0.14/轮）、浏览量、分享率全部手写。
`POSTER` / `JSONLD` / `STATS` / `PILLS` 四项在静态稿里恒为通过（没有真实导出可测）。

## 和现有代码的对应

- 分类三套并存：前台 `../ComeBrief/lib/result-theme.ts`、后台 `lib/quizPack.ts:QUIZ_CATEGORIES`、
  趋势 `MASTER_CATEGORIES` —— 屏 04 就是要归并它们。
- blocker / warning 的判定口径沿用 `lib/quizPack.ts`，矩阵只是把「权重」从散文里搬进表格。
- 屏 05 的 S3 生成应当只填「场景文案 + 原型名/引语/解读」，
  权重、平局规则、结构来自 `lib/storyRecipes.ts` 那种「配方」，
  否则 AI 会产出结构上就坏掉的卷（这也是现在 `scale` / `axes` 两套打分共存的起因）。

## 落地顺序（与静态稿一一对应）

1. **P0** `scripts/check-quiz.mjs`：把屏 03 的计算搬成 CI 断言（全枚举 + 命中率 + 平局率）。
   ✅ 已完成（38 条断言，进 `.github/workflows/checks.yml`）。
2. **P1** `supabase/50_quiz_taxonomy.sql`：`quiz_topics` / `quiz_tags` / `quiz_tag_links`，
   `quizzes` 加 `topic_id` / `quiz_format` / `scoring_mode` / `est_minutes` / `locale`。
   ✅ 已写完（幂等 + 双写触发器），待 Supabase 上实跑。
3. **P2** `scoreByArchetype` + 4 条轴投影，旧 `scale` 路径不动（零回归）。
   ✅ Sass 侧 `scoreByArchetype` 在 `lib/quizAxes.ts`；前台 `ComeBrief/lib/quiz.ts` 的
   `scoreQuiz()` 已加 axes 分支（`lib/quiz-axes.ts` + `npm run check:axes`，与
   `enumerateAxe` 的 65,536 组基线对过），只有显式 `model: "axes"` 才走这条路。
4. **P3** `/quizzes/topic/[slug]`、`/quizzes/[slug]/r/[resultId]`。
   🟡 结果页 / 海报已按原型卷换版式（`kind: "archetype"`：配比、邻座、贴纸、事实条、
   分享文案）；主题页与单结果永久链接仍未开工。
5. **P4** Studio：把屏 02 的矩阵做成真编辑器。
   ✅ 已落地 —— `app/admin/_components/QuizAxesEditor.tsx`（点格子循环 0→1→2→3、
   列合计 / 命中占比 / 平局率实时重算、自动配平、12 项检查右栏），
   入口是 `/admin/quizzes/create` → Logic → Archetype Matrix；批量导入也认 axes 了
   （`axePackIssues()`，与 `check:quiz` 同一份判据）。
   未做：Sheets 直接粘贴权重（现在只能一格一格点 / 整卷 JSON 导入）。
6. **P5** Autopilot S1–S5，先开「只生成、不自动发」。

落地后的口径写在 `docs/quiz-axes.md`（12 项检查、扣分表、仲裁规则、已知偏差）。

## 已定的事（2026-11-06，原「还没定的事」五项里的三项）

| 决定 | 结论 | 落在哪 |
|---|---|---|
| `matchPct` 是否封顶 97 | **封顶 97**，下限 1 | `MATCH_PCT_CAP` / `axeMatchPct()` |
| `categories` 迁移期是否双写 | **双写**：`topic_id` 为真源，旧列只镜像 `legacy_name`（NULL 的新话题不镜像） | `50_quiz_taxonomy.sql` 第 6 节 |
| 语言 | **英文单语**：`quizzes.locale` 只允许 `en`（以及 `en-US` 这类区域变体） | `quizzes_locale_chk` |

仍没定：自动发布闸门（≥90 自动 / 全人工）、Reddit 走 `r.jina.ai` 代理的脆弱性。

