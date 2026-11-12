# AI 起草测验（趋势 → 选题 → 生成 → 应用）

代码：`lib/quizKit.ts`（契约 + 5 条规则）· `lib/quizCompile.ts`（primary → 3/1 权重）·
`lib/quizTrends.ts` + `lib/quizTrends/sources.ts` + `lib/quizTrends/rss.ts`（8 个源）·
`lib/quizLexicon.ts`（热词）· `lib/quizAi.ts`（三段提示词）·
`app/api/admin/quiz/{trends,ideas,generate}`（三个路由）·
`app/admin/_components/QuizAiWizard.tsx`（向导）·
`scripts/check-quiz-kit.mts` / `scripts/check-trends.mts`（离线自检）

入口：`/admin/quizzes/create` 右上角 **AI 起草**（或左上角同一入口的「全自动」）。

---

## 一分钟版

1. **抓趋势**：8 个公开源 + 人工粘贴 → 去重 → 过滤（敏感 / 非英文 / 过期）→ 轮转合并 → 热词表。
2. **选方向**：把「标题块 + 热词块 + 分类词表」交给模型，回 4 个 idea。
3. **生成**：先写 4 个原型的文案（名字 / headline / quote / The Read / stats / pills），
   再写 8 题 × 4 选项 —— **每个选项只回答「最像哪个原型」**。
4. **应用**：代码把 `primary` 编译成 `3 / 1` 权重，跑 65,536 次全枚举，5 条规则 + 12 项检查全绿才允许填入编辑器。

填入**不保存、不发布**：保存仍是右上角 Save Draft，发布仍是原来那套（含 blocker 拦截）。

```sh
npm run check:kit      # 契约 / 5 规则 / 编译 / 全枚举分布
npm run check:trends   # RSS·Atom 解析 / 去重 / 轮转 / 过滤 / 热词（离线）
npm run check:quiz     # axes 引擎（原有）
```

---

## 为什么拆三段、为什么不让 AI 写权重

参考实现是 `quiz-kit`（`/Users/ludalin/Desktop/quiz-kit`）：模板 JSON + 5 条硬规则 + 配平模拟。
它的思路对，但直接照搬会和我们现有的 `lib/quizAxes.ts` 打架，所以做了四处**有意**的偏离：

| quiz-kit | 我们 | 原因 |
|---|---|---|
| 模型给每个选项写 0–3 权重 | 模型只给 `primary`，权重由代码算 | 模型每天都会写出「某列全 0」「15/15/1/1」这类**静默**故障；枚举才会发现，但那时已经上线 |
| `tieBreak: most recent` | 平局取 `archetypes` 声明顺序靠前者 | 两套并列会让「枚举说 20%，线上 19%」；`scoreByArchetype()` 与 `enumerateAxe()` 必须同源 |
| `matchPct` 可到 100% | 封顶 97（`MATCH_PCT_CAP`） | 100% 显得机械化、伪造感重（2026-11-06 决策） |
| 新造一套分类词表 | 用 `50_quiz_taxonomy.sql` 的 6 话题 / 16 标签，写库仍写旧词 | 前台 `lib/result-theme.ts` 按 `categories[0]` 挑配色，换词会让存量卷配色与「相关测验」一起错位 |

**权重规则只有两条**：

- 主原型 = 3 分（`PRIMARY_WEIGHT`）；
- 次原型 = 声明顺序里的**下一个原型**（循环）= 1 分（`SECONDARY_WEIGHT`）。

每题 4 个选项恰好覆盖 4 个原型（第 4 条规则），于是每题给每个原型的分是
`3（自己）+ 1（上一个选项的次权重）= 4`，8 题下来四列列合计**天然全部等于 32** ——
`balance` 检查永远过，不需要 `autoBalance()` 去补。平局率因此是结构性的 **9.2%**，
所以 `MAX_TIE_PCT` 已从 8% 抬到 12%（见 `docs/quiz-axes.md` 的「已知偏差」）。

---

## 数据形状

### 1. AI 交付的 QuizKit（中间层，不落库）

```json
{
  "title": "Which Group Chat Member Are You?",
  "hook": "Eight taps and we will tell you who you are at 2am.",
  "topic": "pop-culture",
  "tags": ["Internet Lore"],
  "locale": "en",
  "archetypes": [
    {
      "id": "sarcastic-curator",
      "name": "The Sarcastic Meme Curator",
      "short": "Sarcastic",
      "headline": "You speak fluent irony.",
      "quote": "I am not late, the timeline is early.",
      "summary": "You read the room before you read the message... (The Read, 2–3 句)",
      "stats": ["3 group chats on mute", "97% reply rate", "2am scroll sessions"],
      "pills": ["Chronically online", "Screenshot hoarder"]
    }
  ],
  "questions": [
    {
      "scene": "Monday, 9:03 AM",
      "title": "Your group chat is on fire before you have had coffee. You...",
      "options": [
        { "text": "Reply with a meme in four seconds", "primary": "sarcastic-curator" },
        { "text": "Read the whole thing, type nothing", "primary": "calm-observer" },
        { "text": "Screenshot it for later", "primary": "main-character" },
        { "text": "Mute the chat until noon", "primary": "midnight-overload" }
      ]
    }
  ],
  "meta": {
    "trendIds": ["google-trends:brat-summer", "reddit:the-group-chat"],
    "terms": ["brat summer"],
    "keywords": ["Which Group Chat Member Are You?"],
    "geo": "US",
    "window": "24h",
    "fetchedAt": "2026-11-09T09:00:00.000Z",
    "generatedAt": "2026-11-09T09:03:12.000Z",
    "model": "gemini-3.8-flash"
  }
}
```

固定形状：**4 个原型 × 8 题 × 4 选项**（`KIT_ARCHETYPES` / `KIT_QUESTIONS` / `KIT_OPTIONS`）。
字数上限：`name` ≤ 40、`headline` ≤ 90、`quote` ≤ 140、`summary` ≤ 320、题干 ≤ 120、选项 ≤ 90、
`stats` ≤ 4 条、`pills` ≤ 4 个且每个 ≤ 18 字。

`meta` 会原样写进 `raw_data.meta`：三个月后有人问「这题为什么这么出」，答案在这儿，
不在某个人的记忆里。

### 2. 应用到编辑器之后

`compileQuizKit()` 产出 `model: 'axes'` 的正文：`archetypes` 原样带过去（含 `summary`），
`questions[].options[].weights` 变成 `{ 主原型: 3, 次原型: 1 }`，选项 id 固定 `a/b/c/d`，
题目 id 固定 `q1…q8`。分类写**旧词汇**（`topicToCategories`）：

| 话题 | 写进 `categories` |
|---|---|
| personality | `Persona` |
| pop-culture | `Sports` |
| love | `Social` |
| career | `Future` |
| lifestyle / trivia | 话题全名（旧词表没有对应档） |

---

## 五条硬规则（`validateQuizKit`）

| id | 规则 | 级别 | 为什么 |
|---|---|---|---|
| `archetypes` | 正好 4 个；id 合法（`a-z0-9_-`，2–32）且唯一；名字非空、≤ 40 字、互不重复 | blocker | 少于 4 个没有「四选一」的意义；id 重复会让权重落在同一列 |
| `questions` | 正好 8 题；题干非空、≤ 120 字、互不重复 | blocker | 题量是完成率与区分度的平衡点；重复题干 = 同一题问两遍 |
| `options` | 每题正好 4 个；非空 / 不是占位（`Option A`、`lorem`）/ 同题不重复 / ≤ 90 字 | blocker | 360px 下 90 字已经占满两行 |
| `mapping` | 每个 `primary` 都是已声明的原型；**每题 4 个选项覆盖 4 个不同原型** | blocker | 这一条是配平的来源；破一个，某列就偏轻，作答会整片落进另一档 |
| `copy` | 每个原型都有 headline / quote / summary / ≥3 stats / ≥2 pills | warning | 缺了能进编辑器补，不拦应用 |

blocker 存在时「应用到编辑器」是禁用的；warning 只标出来。
半成品也能走 `compileQuizKit()`（进矩阵手工救），但 `validateQuizKit` 会先拦住 ——
**代码不会替模型编造权重来「凑满」**。

---

## 趋势源（8 个 + 人工粘贴）

| 源 | 覆盖 | 形态 | 备注 |
|---|---|---|---|
| `google-trends` | 搜索爆发（最像「此刻」） | RSS（`ht:` 命名空间） | `GLOBAL` 只能落到 US |
| `google-news` | 新闻头条 | RSS | **授权是个人 / 非商业**，见下 |
| `wikipedia` | 集体好奇心 | JSON（日榜） | 数据延迟 2–4 天：从**昨天**起往回找 5 天，取第一个有数据的 |
| `reddit` | 社区口语 / 梗 | RSS（`/r/popular/hot/.rss`） | `.json` 一律 403，别试 |
| `knowyourmeme` | 梗的出生地 | RSS | |
| `apple-music` | 听歌口味 | JSON | 用 301 之后的正式域名（少一跳 ≈ 少 1 秒）；偶发 8s 超时，会重试一次 |
| `popcrave` | 名人 / 饭圈 | RSS | |
| `buzzfeed` | 大众趣味（quiz 邻域） | RSS | |
| `manual` | 人工粘贴 | 文本 | 一行一条，`标题 \| https://…` 也认 |

TikTok Creative Center / YouTube Trending / X / Instagram 都**没有**匿名可用的接口
（要登录或商业授权），它们的信号由上面 8 个源 + 粘贴覆盖。

### 采集行为

- 每个源 8 秒超时，`Promise.allSettled` 并发：**一个源挂了不影响其他源**；
- 超时 / 连接失败 / 上游 5xx **重试一次**（Apple CDN 实测会偶发 8 秒不响应或 502）；404 不重试；
- 合并用**轮转**（`mergeRoundRobin`）：任何单个源占比 ≤ 1/N，不会 60 条里 55 条是搜索词；
- 10 分钟进程内缓存（最多 12 条），反复点「抓趋势」不会重复打源；
- 全部源失败且没有粘贴 → **424 Failed Dependency**（「采集挂了」≠「今天什么都没发生」）；
- 全部被过滤 → 200 + 说明（放宽时间窗或加两条粘贴）。

### 合规（商用前必读）

- **Google News RSS 的授权是「个人 / 非商业」。** 我们只读标题、不落库原文、不重发内容，
  但仍然把它做成**可关的源开关**（向导第一步）。商用请关掉它，或换成付费新闻源；
- 所有请求带明确的 UA（`SassQuizTrends/1.0`）—— Reddit / KYM 对默认 UA 直接 403；
- 标题与链接只用于当次生成，`raw_data.meta` 里只留 id / 热词，不留原文；
- 热搜不等于事实：模型出的题只借「热度与语境」，不陈述新闻事实（提示词里明确禁止）。

---

## 热词（`lib/quizLexicon.ts`）

三类分开抽，因为模型对它们的用法完全不同：

| 类别 | 怎么抽 | 用在哪 |
|---|---|---|
| `entity` | 连续大写词（含 `of / the / de / van` 这类连接词，≤ 4 词），保留原始大小写；**查询型源**（Google Trends / Wikipedia）的整条标题也收 | 题干里的「谁」 |
| `slang` | 命中 `SLANG_SEEDS`（146 条，只收能公开写的） | 选项的语气 |
| `phrase` | 2–3 词的重复 n-gram，**至少两条标题、且来自两个不同源** | 趋势强度的旁证 |

打分：`出现次数 × 2 + 源权重和 + 类别加成 + 跨源加成`。
「Taylor Swift」同时出现在 Google Trends 与 Wikipedia 才算真热；只在 BuzzFeed 出现一次的
大概率只是一篇稿子。人工钉住的词（向导里点星）**一定排在最前**。

「两个不同源」这条是实测加的：Reddit 里两场同赛事的讨论帖会让
`stage semi-final` 这种碎片命中两次、爬到最前面，而它对人没有任何意义。

敏感过滤是**粗筛**（政治 / 灾难 / 医疗 / 犯罪 / 宗教冲突 / 性），命中就整条丢掉且不进提示词；
判据不是「不礼貌」，而是「拿它出测验会冒犯到人」。第二步还要人再看一遍。

**它拦不住全部。** 实测（2026-11-09，US 24h）：维基日榜会混进政治人物与《Deaths in 2026》
这类条目，名单只能挡住其中一部分；单字的法语页名（`Scène`）也会漏过来 —— 它没有虚词、
也只有一个词，任何「按虚词判语言」的规则都救不了。这两类都只能靠第二步的人工确认 ——
向导刻意没有「一键发布」。

### 语言判别为什么改了两次

第一版只有「有英文虚词吗」这一条，实测被两条标题穿过去：

- `In einem unbewohnten Haus Leiche von 13-jähriger Lisa Ta … gefunden`
  —— 它含 `in`（英语也有），于是被判成英文，还顺带产出 `Haus Leiche`、`Marzahn` 四个热词；
- `ich_iel` —— 整条就是子版名，两个词，短查询豁免直接放过。

第二版加了「4 个词以上却一个英文虚词都没有 → 外语」，结果把
`Taylor Swift announces Eras Tour film`、`Squid Game season 3 first look` 也杀了 ——
**用噪声换干净不值**：留着的外语条目点一下就排除了，丢掉的真趋势却回不来。

现在的规则（`isEnglishText`）只剩三条硬证据：子版名 / 非拉丁字母 ≥ 20% / 外语虚词命中
（≥3 直接判外语；≥2 且不少于英文虚词也判外语；有外语词 + 德语构词后缀 + 零英文虚词也判外语）。
其余一律放行。另外分词用 `\p{L}`（Unicode 字母），否则 `policía` 会被切成 `polic` + `a`，
而 `a` 正好是英文虚词 —— 一条西语标题就这样「洗白」了。

---

## API 契约

三个路由都要求 `Authorization: Bearer <Supabase access_token>`（`requireAdmin`）。

### `POST /api/admin/quiz/trends`

```jsonc
// 入
{ "geo": "US", "window": "24h", "sources": ["google-trends", "reddit"], "manual": "一行一条", "pinned": ["brat summer"] }
// 出
{ "ok": true, "items": [TrendItem], "terms": [HotWord], "sources": [TrendSourceStatus],
  "geo": "US", "window": "24h", "fetchedAt": "...", "cached": false, "filtered": 7 }
```

错误：`424` 全部源失败（带 `sources` 明细）；`200 + error` 全部被过滤；`401` 未登录。

### `POST /api/admin/quiz/ideas`

```jsonc
{ "trends": [TrendItem], "pinned": ["…"], "avoidTitles": ["上个月的标题"], "count": 4 }
→ { "ok": true, "ideas": [QuizIdea], "model": "gemini-3.8-flash", "truncated": false }
```

`truncated: true` 表示模型没写完、最后一条被丢掉：步 2 会显示「只拿到 N 条选题」，但不阻断。

### `POST /api/admin/quiz/generate`

```jsonc
// stage=copy
{ "stage": "copy", "idea": {…}, "vocabularyBlock": "…" }
→ { "ok": true, "archetypes": [KitArchetype], "problems": [], "truncated": false }

// stage=questions（必须先有 4 个原型）
{ "stage": "questions", "idea": {…}, "archetypes": [KitArchetype], "meta": {…} }
→ { "ok": true, "kit": {…}, "validation": {…}, "summary": { health, hitPct, tiePct, … }, "truncated": false }
```

`summary` 由服务端跑全枚举算出，前端不必重算；`validation` 就是五条规则的原始结果。

### 模型把 JSON 写断了怎么办

实测第一次真实使用就撞上了：`{"ideas": [{"title": "What Kind of Clutch Player…", "angle": "How do you han`
—— 只有一百来个字符，连一条都没写完。提示框里那句「模型返回的不是合法 JSON」对人毫无用处。

三件事一起做，按这个顺序：

1. **加额度**：选题 1800 → 2600、文案 2400 → 2800、题目 3600 → 4600 token。
   推理模型（gpt-oss / Qwen3）的**思考也算在这笔额度里**，1800 经常被思考吃光；
2. **救回写在前面的条目**（`lib/jsonSalvage.ts` 的 `closeTruncatedJson`）：回退到**最后一个
   完整闭合的元素**、把剩下的括号补齐，于是「4 条写完 3 条」能拿到 3 条。
   它只补括号、不猜内容 —— 半个字符串在 `normalize*` 里本来就过不了，会被丢掉。
   只在括号没配平时才生效，所以对完整输出零副作用；
3. **选题那条路自动重试**：断在半句不是「模型不好」，是额度不够 —— 先按 2600 打一次，
   仍在半句就按 3600 再打一次；如果补完括号是空数组（第一条都没写完），再给一次机会。
   每次的 `timeoutMs` 都是「离 52 秒还剩多少」，所以最多三次也不会撞上 60 秒上限。

题目/文案断了**不自动重试** —— 那两处 UI 本来就有「重写文案 / 重写题目」，重试一次等于
在背后偷偷花掉用户 20 秒，而且题目缺一条会被五条规则直接拦下（比悄悄发出去好）。

---

## 向导（`QuizAiWizard`）

| 步 | 做什么 | 可回退 |
|---|---|---|
| 1 Trends | 地区 / 时间窗 / 源开关（带每次抓取条数）· 人工粘贴 · 热词点星 · 点掉不用的条目 | — |
| 2 Idea | 4 个方向（标题 / 副标题 / 角度 / 四档方向 / 分类标签）· 「换一批」 | ✔ |
| 3 Generate | 「文案 + 题目」一起写，或只重写其中一段；5 条规则 + 健康分 + 四个原型命中占比 | ✔ |
| 4 Apply | 标题 / 分类 / 标签 / 题干全览 + 「应用到编辑器」 | ✔ |

- **全自动**：抓趋势 → 选题（取第一个）→ 文案 → 题目 → 停在**第 4 步**。
  它停在最后一步是刻意的：草稿必须由人按保存（和批量导入一样，AI 不直接写库）；
- 题目没过 `mapping` 时自动**换一版文案**重来一次（模型分不清两个结果时，重写文案比硬凑题目更有效），
  仍不过就把 blocker 摊开给人看；
- 「应用到编辑器」做四件事：填标题 / 分类 / 标签、切 `model: 'axes'`、替换 `axeQuiz`、把 `meta` 暂存到
  `raw_data.meta`（保存时才写库）。**不保存、不发布。**

---

## 验收标准（都能对着 UI / 脚本核）

| # | 标准 | 怎么看 |
|---|---|---|
| 1 | 8 个源全部有独立状态，挂一个不影响其他 | 源 chip 上的条数 / `×` |
| 2 | 合并后单源占比 ≤ 50% | `check-trends` 3k |
| 3 | 每题 4 个选项覆盖 4 个原型 | `check-kit` 3f（改一个就红） |
| 4 | 编译后四列列合计相等（各 32） | `check-kit` 4g |
| 5 | 全枚举 65,536 组合、平局 9.2%、健康分 100 | `check-kit` 4j–4m |
| 6 | 有 blocker 时「应用」禁用 | 第 4 步底部提示 |
| 7 | 应用后不自动保存 | 编辑器仍是「Save Draft」 |
| 8 | `meta` 落进 `raw_data.meta` | 保存后用 `check:quiz --file` 或直接看行 |
| 9 | 模型写断 JSON 时能拿到前面写完的条目 | `check-kit` 7a–7f |

```sh
npm run typecheck && npm run check:quiz && npm run check:pack && npm run check:studio && npm run check:kit && npm run check:trends
```

---

## 已知边界（不是 bug）

1. **只有英文。** `locale` 固定 `en`；中文版要等前台的多语言路由，不在这一版。
2. **没有调用 `repairWeights()`。** 权重是算出来的，不存在「权重写歪了要修」这件事；
   `docs/quiz-axes.md` 里的 `autoBalance()` 仍然留给手写卷。
3. **不做图片。** 封面仍是人工上传；Apple Music 只取歌名与艺人，不取封面（版权）。
4. **不做事实核查。** 提示词只允许「借语境」，不允许陈述新闻事实；写题时若出现具体数字/日期，
   仍是人要复核的内容。
5. **`summary` 的影子字段。** 前台已支持（`ComeBrief/lib/quiz-result.ts`），
   但旧卷不写它也不会被补，所以列表里新旧卷会长得不一样 —— 这是有意的（不伪造内容）。
6. **趋势缓存是进程内的。** 多实例部署时每个实例各有一份，最多多打一次源；要跨实例共享得换 Redis，
   这一版没做。


