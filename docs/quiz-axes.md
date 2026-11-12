# 原型轴打分（`model: 'axes'`）

代码：`lib/quizAxes.ts`（零依赖、纯函数） · 自检：`scripts/check-quiz.mjs` ·
数据结构：`supabase/50_quiz_taxonomy.sql`（在 `../ComeBrief/supabase/`）

## 问题：改一个选项的分，没人知道某个结果会不会从此抽不到

现在两套打分并存：

| 模型 | 选项写什么 | 结果怎么落 |
|---|---|---|
| `score` | `score: 1–4` | 总分落在 `min_score`–`max_score` 区间里 |
| `personality` | `tag: 'A' / 'B'` | 命中次数最多的 tag |

两者的共同毛病是**没有任何一处算过「结果的可达性」**。真实事故：

- 线上 22 篇里 3 篇 `questions_count` 是 0（真实题数 8/8/10）—— 没人发现；
- personality 模型的结果区间写成 `15-20`，而 8 题最多命中 8 次 —— **这条结果永远抽不到**；
- 改一个字之后某个原型再也没出现过 —— 页面照常渲染，只是永远给同几个答案。

axes 模型把这件事变成一张**能算的表**：每道题 4 个选项 × 每个原型 0–3 分，
8 题就是 65,536 种答案组合，全枚举一遍。于是「每个原型占多少比例 / 平局多少 /
有没有原型一种组合都抽不到」全部是算出来的，不是看出来的。

## 数据形状

```json
{
  "model": "axes",
  "title": "What Kind of Online Persona Are You?",
  "archetypes": [
    {
      "id": "sarcastic",
      "name": "The Sarcastic Meme Curator",
      "short": "Sarcastic",
      "headline": "You speak fluent irony.",
      "summary": "You read the room before you read the message. That is why every option you picked was slightly quieter than the one before it.",
      "quote": "I'm not late, the timeline is early.",
      "stats": ["8.4k memes archived", "97% reply rate", "3 group chats on mute"],
      "pills": ["Chronically online", "Screenshot hoarder"]
    }
  ],
  "questions": [
    {
      "id": "q1",
      "scene": "Monday, 9:03 AM",
      "title": "Your group chat is on fire at 9 AM. You…",
      "options": [
        { "id": "a", "text": "Reply with a meme in 4 seconds", "weights": { "sarcastic": 3, "observer": 0 } },
        { "id": "b", "text": "Read everything, say nothing",     "weights": { "observer": 3, "sarcastic": 1 } }
      ]
    }
  ]
}
```

要点：

- `archetypes[].id` 是**稳定的键**，改它等于换结果；`name` 是印在海报上的名字（≤ 40 字）。
- `archetypes[].summary` 是结果页的「The Read」那段正文（2–3 句）。前台已经支持
  （ComeBrief `lib/quiz-result.ts` 的 `pickSummary`），但它是**可选**的：不写不扣分，
  只是结果页少一段。AI 起草的写作要求见 `docs/quiz-ai-authoring.md`。
- `weights` 只写非 0 的格子，没写的按 0 算；每格 0–3（`MAX_WEIGHT`）。
- 也认 `w` 这个别名（老草稿），`weights` 优先。
- 没写 `archetypes` 时，适配层会按选项权重里出现的键名补齐并记一条 `issues`。
- 越界权重（负数 / >3）会被夹住并留痕；未声明的原型 id 会被忽略并留痕 ——
  **但都不抛异常**（和 `lib/quizPack` 的 `normalizePack` 同一套「容忍地读」原则）。

## 仲裁：同一份答案永远同一个结果

1. 总分最高的原型胜；
2. **平局按 `archetypes` 的声明顺序取靠前的那个**（确定性优先，而不是「随机一个有惊喜」）；
3. 平局仍然记一次 tie —— 平局率高说明题目区分度不够，这是真问题，不是噪声。

`scoreByArchetype()` 和 `enumerateAxe()` 共用这一份规则，所以
**「用户实际抽到的结果」和「枚举出来的分布」永远对得上** ——
这也是发布前检查有意义的前提：枚举说 20%，线上就该是 20%。

`scoreByArchetype()` 的返回：

| 字段 | 含义 |
|---|---|
| `archetypeId` / `archetype` | 胜出的原型（id + 完整对象） |
| `score` | 该原型拿到的原始总分 |
| `maxScore` | **同样这些题**、全选最重那一项时的分数（未作答的题不计入分母） |
| `matchPct` | `score / maxScore × 100`，四舍五入后夹在 **1–97** |
| `tied` | 平局时并列的全部原型 id（含自己，按声明顺序） |
| `tally` | 每个原型的总分 |
| `answered` / `missing` | 已答 / 未答题数 |

`matchPct` 封顶 97 是刻意的（决策 2026-11-06）：100% 读起来像机器算的，
而且会和「必中」这个承诺绑死。下限 1 是为了避免一题没答时页面显示 `0%`。


## 12 项发布前检查（`axeChecks`）

全部由数据推出：不联网、不看数据库、不读时间。`blocker` 拦发布，`warning` 只扣分。

| id | 检查 | 触发条件 | 级别 | 扣分 |
|---|---|---|---|---|
| `reachable` | 每个原型都抽得到 | 存在命中数为 0 的原型（**死区**） | blocker | 40 |
| `nameunique` | 结果名互不重复 | 两个原型名（trim + 小写后）相同 | blocker | 10 |
| `minhit` | 最低命中率 ≥ 12% | 某个原型命中占比 < 12% | warning | 8 |
| `tie` | 平局率 ≤ 12% | 平局组合占比 > 12% | warning | 10 |
| `balance` | 列合计不偏沉 | 极差 > `max(4, 总和 × 15%)` | warning | 6 |
| `deadopt` | 无废选项 | 某选项对所有原型都是 0 分 | warning | 4 / 个（封顶 12） |
| `thin` | 每题至少喂养 2 个原型 | 某题只有一个原型的权重 > 0 | warning | 6 |
| `name` | 结果名 ≤ 40 字 | 最长名字超限（360px 下要 4 行） | warning | 5 |
| `shape` | 6–10 题 × 4 选项 | 题数越界或有题不是 4 个选项 | warning | 5 |
| `stats` | 每个原型都有料 | 缺 `headline` / `quote` / 3 条 `stats` | warning | 4 |
| `pills` | pill tags 不溢出 | > 4 个，或单个 > 18 字 | warning | 3 |
| `scale` | 用满 0–3 档 | 全卷最高权重 < 3 | warning | 4 |

健康分 = `100 − Σ(未通过项的扣分)`，夹到 0–100（`axeHealthScore`）。
扣分口径与静态稿 `/mockup/quiz-studio` 屏 03 逐项一致（40 / 8 / 10 / 6 / 4n / 4 / 6 / 5 / 5 / 4 / 3），
**前台展示的分数与 CI 的退出码必须同源**。

和静态稿唯一的差别是第 11、12 项：静态稿里 `poster`（海报导出）/ `jsonld`（结构化数据）
两项恒为通过 —— 那时没有真实导出可测；真正落地时换成了两项**能算**的：
`nameunique`（blocker）和 `scale`（全卷最高权重没用满 3）。项数仍是 12，健康分可比。

实测三档（`scripts/check-quiz.mjs` 里的 fixture）：

| 卷 | 未通过项 | 健康分 |
|---|---|---|
| 8 题 × 4 原型、列配平 | 无（`tie` 9.2% 已在新上限 12% 内） | **100** |
| 上一档 + 1 个废选项 + 50 字结果名 | `tie` 12% + `deadopt` + `name` | **81**（与静态稿一致） |
| 两列权重全 0（死区） | `reachable` 等 | **15** |

> `blocker` 只有两个：「原型抽不到」和「结果名重复」。前者是「用户永远看不到某个结果」，
> 后者是「两条结果印在卡片上完全一样」—— 这两种发出去比不发更伤，所以不给「先发后修」的口子。

## 精确枚举 vs 抽样

- 组合数 ≤ `MAX_EXACT_COMBOS`（200 万）→ **精确全枚举**。8 题 × 4 = 65,536，10 题 × 4 = 1,048,576。
- 超过上限 → 退化成 60,000 次的**确定性抽样**（固定种子 `SAMPLE_SEED`），同一份卷每次跑结果一致、可 diff。

为什么默认精确而不是「随便抽一万次」：抽样百分比每次都不一样，改一格数字会跳 0.3%，
评审时看起来像 bug；而「某个原型完全抽不到」这种稀有事件恰恰最容易被抽样漏掉 ——
漏掉的那一次就是线上事故。

## CI

```sh
npm run check:quiz                       # 38 条断言（默认模式，CI 跑这个）
npm run check:quiz:file ../quiz.json     # 体检一份真卷：raw_data 对象或数组都行
```

工作流：`.github/workflows/checks.yml`（`typecheck` + `check:quiz`）。
脚本直接 `import '../lib/quizAxes.ts'`，靠 Node ≥ 24 原生剥类型；`quizAxes.ts` 刻意零依赖，
所以不需要挂 `--import ./scripts/_ts-resolve.mts`。

38 条断言分 10 组：

| 组 | 钉住的行为 |
|---|---|
| 1a–1g | 全枚举：65,536 组合、不是抽样、占比加总 100%、四个原型都抽得到、列合计 / 列满分、确定性 |
| 2a–2e | 干净卷：零 blocker、12 项齐全、12 项全绿（`tie` 9.2% ≤ 12%）、健康分 = 100 − 扣分 |
| 3a–3c | 死区 → `blocker`，点名是哪个原型 |
| 4a–4b | 废选项 → `warning`，点名「Q6 选项 B」 |
| 5a–5b | 平局率超限 → `warning`，不拦发布 |
| 6a–6c | 超长结果名 / 题量越界 → `warning`，不产生 blocker |
| 7a–7c | 超上限 → 抽样，但理论组合数仍是 `4^14`，且抽样确定 |
| 8a–8f | `matchPct` 封顶 97、`score == maxScore`、分母只算已答题、中途退出 / 一题没答都不崩 |
| 9a–9c | `score` / `personality` 卷不被 axes 认领，`auditAxeQuiz` 返回 `null` |
| 10a–10d | 适配层：`w` 别名、越界夹住、未声明原型忽略、字符串权重转数字 |
| 11a–11b | `summary`（The Read）能穿过适配层；没写的不被补成空串 |

`--file` 模式的输出是给人看的：`✓` 通过、`!` 警告、`✗` blocker；有 blocker 时退出码 1，
所以能直接塞进「发布前必须跑一次」的流程。不是 axes 卷会打印 `SKIP … 旧路径不动` 并返回 0。

## 已知偏差与待办（别当成 bug 去「修」）

1. **`tie` 阈值已从 8% 抬到 12%（2026-11-09）。** 8 题 × 4 原型 + 3/1 权重这一结构下，
   干净卷的平局率实测稳定在 **9.2%** —— 它是结构决定的，不是作者能修的。旧阈值把
   「结构本身合格」的卷一律判成 warning（健康分 90），那不是区分度问题，是阈值写错了。
   现在干净卷是 **100 分**，而 6 题（38%）或完全不给次权重（25%）照样被拦住。
   改动已同步：`MAX_TIE_PCT` / 本文 / `scripts/check-quiz.mjs` 的 `2c 2d 5a`。
2. **前台已接 axes（P2 + P3 完成）。** `ComeBrief/lib/quiz.ts` 的 `scoreQuiz()` 现在分两路：
   `raw_data.model === "axes"` 时走 `lib/quiz-axes.ts` 的仲裁（最高分胜出、同分看声明顺序、
   不掷骰子），其余仍按 `score` 落进 `results` 的 `min ~ max` 区间。两边的分工是刻意的：
   **Sass 侧做穷举体检**（`enumerateAxe` 全量 65,536 种作答组合 + 作者视角的诊断），
   **ComeBrief 侧只做仲裁与排版**（`npm run check:axes`，28 条用例，含一份硬编码的
   平局数 / 命中数基线 —— 改动仲裁规则会逼你显式重设基线，而不是悄悄漂移）。
   结果页与海报换了一套章节措辞（`The read` / `Your mix` / `Neighbours` /
   `Stubby says`），旧卷一个字都没变。
3. **`50_quiz_taxonomy.sql` 的 `scoring_mode` 已经允许 `axes`。** 前台接好之后，
   给卷子标 `model: "axes"` 是安全的；真正的拦路虎是 P4（编辑器还画不出权重矩阵），
   见第 5 条。
4. `questions_count` 是 `41` 的触发器维护的；`50` 只读不写它（`est_minutes` 按它派生）。
   跑 `50` 之前先跑 `41`，否则时长会按可能过期的题数算。
5. **后台编辑器 / BATCH IMPORT 已经认 `axes`（P4 完成）。**
   `/admin/quizzes/create` 的 Logic 页多了第三个模型 `Archetype Matrix`：选中后中间区换成
   `app/admin/_components/QuizAxesEditor.tsx` —— 点格子循环 0→1→2→3、列合计 / 命中占比 /
   平局率当场重算（每次改权重跑一遍 `enumerateAxe`，延后 140ms 防打字卡）、
   「配平」给最轻的那列补分、右栏是同一份 `axeChecks` 的 12 项。
   发布（非草稿）时后台会先跑一遍 `auditAxeQuiz()`，有 blocker 直接拦下 ——
   留一个「只靠 CI 守门」的口子等于允许手点发布绕过它。
   `lib/quizPack.ts` 的 `validatePack` 也放开了 `axes`：结构交给 `normalizeAxeQuiz`，
   可发性交给 `axeChecks`（见 `axePackIssues()`），所以批量导入和编辑器右栏的 blocker
   永远同源。两项 blocker 是「有原型一种组合都抽不到」和「两个原型同名」，其余只提醒。
   未做：Sheets 直接粘贴权重矩阵（现在要么点格子，要么整卷 JSON 导入）。

## 与代码 / 数据的对应

| 位置 | 作用 |
|---|---|
| `lib/quizAxes.ts` | 适配层 `normalizeAxeQuiz` / 枚举 `enumerateAxe` / 打分 `scoreByArchetype` / 检查 `axeChecks` / 一步到位 `auditAxeQuiz` |
| `app/admin/_components/QuizAxesEditor.tsx` | 权重矩阵编辑器：点格子循环、实时全枚举、自动配平、`axeChecks` 右栏 |
| `app/admin/(protected)/quizzes/create/page.tsx` | Logic → Archetype Matrix 入口；发布前跑 `auditAxeQuiz()` 拦 blocker；`raw_data` 按模型二选一 |
| `lib/quizPack.ts` 的 `axePackIssues()` | 批量导入的 axes 判据（结构与 `axeChecks` 同源，`check:pack` 钉住） |
| `scripts/check-quiz.mjs` | 38 条断言 + `--file` 真卷体检 |
| `.github/workflows/checks.yml` | CI（`typecheck` + `check:quiz`） |
| `app/mockup/quiz-studio/` | 静态稿，屏 02 / 03 的数字与本文同源 |
| `../ComeBrief/supabase/50_quiz_taxonomy.sql` | `quiz_topics` / `quiz_tags` / `quizzes.topic_id` / `scoring_mode` 双写 |
| `../ComeBrief/lib/quiz-axes.ts` | 前台的归一化 / 仲裁 / `axeMatchPct`，只依赖本仓的算法口径 |
| `../ComeBrief/lib/quiz-result.ts` | `buildArchetypeProfile()`：原型卷的配比、邻座、贴纸、章节名 |
| `../ComeBrief/scripts/check-quiz-axes.mjs` | `npm run check:axes`：28 条用例 + 与 Sass `enumerateAxe` 对过的基线 |
| `../ComeBrief/.github/workflows/checks.yml` | 前台的 CI（`typecheck` + `lint` + `check:axes`），不需要网络与数据库 |

