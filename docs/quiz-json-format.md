# 测验 JSON 格式（批量草稿导入）

## 问题

`/admin/quizzes/create` 的 **BATCH IMPORT** 以前是「一个 textarea + `JSON.parse` + `insert`」，
任何一步失败都只弹一句 `Invalid JSON Format`。于是三类完全不同的错误被伪装成同一句：

| 真实原因 | 用户看到的 | 后果 |
|---|---|---|
| AI 把 JSON 包在代码围栏里（三个反引号 + `json` 那一行）、用中文引号 `“ ”`、尾逗号、`//` 注释 | Invalid JSON Format | 明明内容是对的，无从下手 |
| 能 parse 但结构不对（`questions` 不是数组、`title` 为空） | 提示导入成功 | 之后点「编辑」直接白屏（编辑器无兜底地 `quizData.questions.map`） |
| 数据库报错（缺列 / RLS / 非空约束） | 还是 Invalid JSON Format | 完全误导 |

现在这三类都在**提交之前**分开报出来，并且带「第几行第几列 / 哪个字段」。

## 用法

1. 编辑页右上角 **BATCH IMPORT**。
2. **一个框 = 一篇**。也可以点底部「整段粘贴拆分」，把一整个 `[ {...}, {...} ]` 数组拆成多个框。
3. 每个框右上角 **模板** 插入一份能直接用的骨架，再改成自己的内容。
4. 框头的小徽章必须变成绿色（`可导入 · N 题 / N 结果 · 下限–上限 分`），
   「保存到草稿箱 (n/n)」才可点 —— **任何一个框红着都点不动**。
5. 导入一律落成草稿（`status = 'draft'`、`active = false`）。
   去 `/admin/quizzes` 打开这篇，改封面、设时间，按「草稿 / 发布 / 定时」走原来那套流程
   （定时到点由 `/api/cron/publish` 翻正，见 `docs/scheduled-publishing.md`）。

框头的几个按钮：

| 按钮 | 作用 |
|---|---|
| 模板 | 插入下面的 score 骨架 |
| 格式化 | 先容错、再按 2 空格缩进重排（不会改内容） |
| 清空 / 删除 | 空框留着不参与导入；只有一个框时不能删 |
| 自动修复 | 只处理围栏 / 中文双引号 / 尾逗号 / `//` 注释 / 全角空格，可「撤销」 |
| 格式说明 | 弹窗里的要点速查（和这份文档同源） |

## 骨架（score 模型，可直接用）

```json
{
  "title": "你是哪种恋爱类型",
  "model": "score",
  "categories": ["Persona"],
  "tags": [],
  "cover_url": "",
  "is_limited": false,
  "questions": [
    {
      "id": "q1",
      "title": "周五晚上突然空出三个小时，你会？",
      "weight": 1,
      "options": [
        { "id": "o1", "text": "约人出门，越热闹越好", "score": 4 },
        { "id": "o2", "text": "去一家熟悉的店坐一会儿", "score": 3 },
        { "id": "o3", "text": "在家补一部一直想看的片", "score": 2 },
        { "id": "o4", "text": "什么都不做，先睡一觉", "score": 1 }
      ]
    },
    {
      "id": "q2",
      "title": "对方三天没回消息，你的第一反应是？",
      "weight": 1,
      "options": [
        { "id": "o1", "text": "直接问一句「你最近还好吗」", "score": 4 },
        { "id": "o2", "text": "先忙自己的事，等对方开口", "score": 3 },
        { "id": "o3", "text": "翻一遍聊天记录找原因", "score": 2 },
        { "id": "o4", "text": "当作没发生，慢慢就淡了", "score": 1 }
      ]
    }
  ],
  "results": [
    {
      "id": "r1",
      "min_score": 2,
      "max_score": 4,
      "title": "松弛派",
      "description": "你把关系放在生活的其中一格，而不是全部。对方慢，你也慢，很少为了回应速度内耗。"
    },
    {
      "id": "r2",
      "min_score": 5,
      "max_score": 6,
      "title": "平衡派",
      "description": "你愿意主动，但也留着自己的节奏。关系里的分寸感是你最擅长的事。"
    },
    {
      "id": "r3",
      "min_score": 7,
      "max_score": 8,
      "title": "投入派",
      "description": "你习惯把在意说出口，也期待同样的回应。热烈是你的优点，偶尔也是你的负担。"
    }
  ]
}
```

这份骨架就是 `lib/quizPack.ts` 里的 `SCORE_TEMPLATE`（弹窗「模板」按钮插的同一份），
改了这边也要改那边；`scripts/p13-quiz-pack-check.mts` 会断言它「零 blocker 零 warning」。

## 字段表

### 顶层

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | ✅ | 列表页标题，不能为空/空白 |
| `model` | ✅ | `score`（累加分，默认）或 `personality`（按 tag 计数） |
| `categories` | 建议 | 数组。编辑器预置 `Persona` / `Subconscious` / `Social` / `Future`；不写按 `["Persona"]` 存 |
| `tags` | 否 | `hot` / `featured` / `hardcore` 的子集；其它值能存，但后台没有对应按钮 |
| `cover_url` | 否 | 封面 URL；留 `""`，导入后在编辑页上传 |
| `is_limited` | 否 | `true` / `false`，前台的 Limited 角标 |
| `questions` | ✅ | 至少 1 题。**缺它以前会「导入成功但编辑页白屏」**，现在直接拦 |
| `results` | ✅ | 至少 1 条，缺了测完没有结果页 |

### `questions[]`

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 否 | 同篇内唯一；不写自动补 `q1`、`q2`… |
| `title` | ✅ | 题干 |
| `weight` | 否 | 默认 1（库里生产数据全是 1） |
| `options` | ✅ | 至少 2 个；前端版式按 4 个设计 |

### `options[]`

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 否 | 自动补 `o1`…`o4`（生产数据里每题都复用 o1..o4，同篇内按题分组即可） |
| `text` | ✅ | 选项文案 |
| `score` | `score` 模型必填 | 整数，生产惯例 1 / 2 / 3 / 4 |
| `tag` | `personality` 模型必填 | 对应 `results` 里的某个人格 |

### `results[]`

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 否 | 自动补 `r1`… |
| `min_score` / `max_score` | ✅ | **闭区间**、整数 |
| `title` | ✅ | 结果名 |
| `description` | 建议 | 结果解读，空的结果页会很干（只提醒，不拦） |

## score 模型的分数区间怎么算

```
下限 = Σ（每题最小的选项分）
上限 = Σ（每题最大的选项分）
```

真实数据：8 题、每题 4 个选项、分值 1/2/3/4 →

- 下限 = 8 × 1 = **8**，上限 = 8 × 4 = **32**
- 结果区间：`8-12` / `13-19` / `20-26` / `27-32`

三条硬规则：

1. 第一条的 `min_score` 必须等于下限，最后一条的 `max_score` 必须等于上限
   （否则区间外的分数拿不到结果 → 白屏/空结果页）。
2. 相邻两条：`下一条.min_score = 上一条.max_score + 1`。留缝就会有一段分数无人接管（**拦**）。
3. 重叠只提醒（前端取第一条命中，后面的可能永远出不来）。

常见规模对照：

| 题数 × 选项分值 | 可达区间 | 建议结果条数 |
|---|---|---|
| 2 × 1–4 | 2–8 | 3 |
| 4 × 1–4 | 4–16 | 4 |
| 8 × 1–4 | 8–32 | 4 |
| 10 × 1–4 | 10–40 | 4–5 |

换分值（比如 0/1/2/3）算法一样，只是上下限跟着变：8 题 × 0–3 → `0–24`。

## personality 模型

和 score 只有两处差别：

- `options[].tag` 必填（写人格名，和 `results[].title` 对应）；
- `results[].min_score / max_score` 不是分数和，而是**某个 tag 被选中的次数**。

注意（这也是不建议首选它的原因）：

1. 库里老数据是 8 题、区间 `0-5` / `5-10` / `10-15` / `15-20` —— 8 题最多命中 8 次，
   `15-20` 永远到不了。历史数据本身就是松的，别照抄。
2. 前台渲染在 ComeBrief 仓库，区间边界到底是 `>= min && <= max` 还是别的，
   这边验证不了 —— 所以 personality 的问题只给 warning，不拦提交。
3. 要用的话：**tag 个数 = results 条数**，区间按题数铺满到「全选同一 tag」的上限。

字段位置只差 `tag` 这一处：

```json
{
  "model": "personality",
  "questions": [
    {
      "title": "朋友临时取消约会，你会？",
      "options": [
        { "text": "立刻约别人", "tag": "行动派" },
        { "text": "在家看剧", "tag": "独处派" },
        { "text": "反复想原因", "tag": "内耗派" },
        { "text": "无所谓", "tag": "随缘派" }
      ]
    }
  ]
}
```

`results` 就要有对应的 4 条（`行动派` / `独处派` / `内耗派` / `随缘派`），
`min_score / max_score` 按「该人格被选中几次」来铺：8 题时是 `0-1` / `2-3` / `4-5` / `6-8` 这类，
最后一条必须能盖住「8 题全选同一个人格」。

## 校验规则一览

**拦提交（红，必须修）**

- 顶层不是对象 / `title` 空白
- `model` 不是 `score` / `personality`
- `categories`、`tags` 不是数组
- `cover_url` 不是字符串
- `questions` 不是数组或为空、题目不是对象、题干为空
- 选项少于 2 个、选项文案为空
- `score` 模型：选项 `score` 缺失或不是数字
- `personality` 模型：选项 `tag` 缺失
- `results` 不是数组或为空、`min_score`/`max_score` 不是数字、`min > max`、结果标题为空
- `score` 区间没顶满下限 / 上限，或中间有缝

**只提醒（黄，能导）**

- `categories` / `tags` 里有编辑器不认识的取值
- `is_limited` 不是 true/false
- 分数不是整数
- 同篇内题目 id / 结果 id 重复
- `description` 为空
- `score` 区间重叠
- `personality` 的 tag 个数与结果条数对不上

## 报错 → 怎么改

| 提示 | 含义 | 改法 |
|---|---|---|
| 第 N 行第 M 列：这里出现了一个不该出现的字符 `}` | 多了一个 `}`，或前面少逗号 | 先点「自动修复」，不行就按行列位置改 |
| 内容没写完：括号或引号少了一个 | 结尾少了 `}` / `]` / `"` | 补齐（长内容最容易漏最后一层） |
| 已自动容错：去掉代码围栏 / 把 N 个中文双引号换成英文 / 删掉 N 个尾逗号 … | AI 输出的常见脏格式 | 已经在内存里修好了，点「自动修复」可把干净文本写回框里 |
| 全角逗号「，」/ 全角冒号「：」 | JSON 只认英文标点 | 换成 `,` / `:` |
| 看起来用单引号当了键的引号 | 用了 Python 风格 | 键和值都改成英文双引号 |
| 缺 questions 数组（…打开会白屏） | 结构缺字段 | 用「模板」当骨架，把内容填进去 |
| 最低分没人接 / 最高分没人接 | 区间没顶到可达上下限 | 改第一条 `min_score` / 最后一条 `max_score` |
| 区间有缝 | 相邻两条之间漏了分数 | 让 `下一条.min_score = 上一条.max_score + 1` |
| 区间重叠（提醒） | 两条结果覆盖同一分数 | 收窄其中一条 |
| 选项里出现了 N 个 tag，但只有 M 条结果 | personality 没对齐 | 补/删结果，或统一 tag 名 |
| `导入失败：new row violates …` / `permission denied` | 数据库层（RLS / 非空约束） | 不是格式问题；看服务端日志。缺列会被自动剔除后重试 |

## 自检（改完 lib/quizPack.ts 或本文档的模板就跑一遍）

```bash
node --import ./scripts/_ts-resolve.mts scripts/p13-quiz-pack-check.mts
```

覆盖：模板本身零 blocker 零 warning、围栏/中文引号/尾逗号/注释的容错、
字符串里的 `//` 不被误删、缺 `questions`、区间有缝/重叠、归一化补默认值、数组多篇、格式化。

## 相关文件

| 文件 | 作用 |
|---|---|
| `lib/quizPack.ts` | 解析 / 诊断 / 校验 / 归一化 / 模板 —— **唯一逻辑源** |
| `app/admin/_components/QuizBatchImport.tsx` | 批量导入弹窗（多框、实时徽章、自动修复、拆分粘贴） |
| `app/admin/(protected)/quizzes/create/page.tsx` | 编辑页，`BATCH IMPORT` 入口 + 导入成功后的 toast/跳转 |
| `scripts/p13-quiz-pack-check.mts` | 上面那条自检命令 |
| `docs/scheduled-publishing.md` | 导入后的草稿怎么排期、谁能翻成 published |



