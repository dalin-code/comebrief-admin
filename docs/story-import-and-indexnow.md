# 稿件导入与 IndexNow 一键推送

两个后台提效功能（2026-11-01）。都要点按钮，但语义完全不同：前者**写库**，后者**通知搜索引擎**。

---

## 1. 编辑页「导入」= 智能分章

位置：`/admin/stories/create`（新建或 `?id=xxx` 编辑）顶栏的「导入」按钮。

弹窗有两个 tab：

| tab | 输入 | 产出 |
|---|---|---|
| 智能分章 | 整篇 txt / md / 粘贴文本 | 当前作品的 N 章 |
| JSON 批量 | 一份 JSON 数组 | 多部独立作品（旧逻辑，原样保留） |

### 写入语义（重要）

- **一律落草稿**：新建作品时写 `status=draft`、`active=false`、`scheduled_at=null`。
- **编辑已发布作品只覆盖内容**：只写 `title / cover_url / content / raw_data`，**不碰**
  `status / active / published_at`。否则「编辑一篇已发布的连载并导入稿件」会把它悄悄下线。
- **新作品写完立刻 `router.replace('/admin/stories/create?id=<新 id>')`**：不换地址的话，
  用户再点一次保存会再插一条重复作品。
- 追加模式会丢掉「空占位章」（新建作品默认那一章没正文的「第一章：序幕」）。

### 切章规则（`lib/storyImport.ts`）

按行扫描，优先级从高到低：

1. Markdown `#` / `##`（`###` 及以上算正文小节，只脱壳不切）
2. 特殊章：`序章` `序言` `楔子` `引子` `前言` `尾声` `终章` `尾章` `后记` `番外`
3. `第X章` / `第X节` / `第X回` / `第X卷` / `第X篇` / `第X部`（支持全角数字、`：`/`、`/`·` 分隔）
4. `Chapter X` / `Part X`（阿拉伯数字与罗马数字）

兜底：

- 一个标记都没有 → 整篇一章 + 明确提示，另给一个「按约 3000 字等分」按钮（不默认开，散文硬切会切在句子中间）。
- 首个标记之前的内容：≥120 字单独成「前言」章，否则并进第一章。
- 单章 <200 字 / >20000 字 / 空章 → 该行单独告警；>300 章截断并告警；重复标题告警。

### 正文必须是纯文本

前台 `ComeBrief/app/(public)/stories/[slug]/page.tsx` 是 `content.split('\n').map(<p>)`。
所以入库前要剥掉 `#`、`**`、`` ` ``、链接语法、`---` 分隔线 —— 留着就会原样显示给读者。

### 编码

`.txt` 用 `file.arrayBuffer()` + `decodeTextFile()`：先按 UTF-8 解，替换字符（`U+FFFD`）占比
超过 0.5% 就用 GBK 重解一次，取更干净的那个。中文 Windows 导出的 txt 大量是 GBK，
用 `readAsText` 会整篇乱码。上限 2MB。

### 复验

```bash
node --import ./scripts/_ts-resolve.mts scripts/p14-story-import-check.mts
```

断言 47 条：四种标记混排、Markdown 残留、正文句子不被误判、前言/短题记、章数上限、
合并 / 拆分、等分、GBK 嗅探。

---

## 2. IndexNow 一键推送

位置：stories / quizzes / trends 三个列表页的操作区（`app/admin/_components/IndexNowButton.tsx`）。

推的是**整站 sitemap**，不是当前列表：`/api/admin/index-push` 的设计前提是
「sitemap 已经是 canonical 的唯一镜像」，按列表推反而会漏页面。

### 两条鉴权通道

`app/api/admin/index-push/route.ts`：

1. `Authorization: Bearer <CRON_SECRET>` 或 `?secret=<CRON_SECRET>` —— 给 cron / curl，零网络成本，先判。
2. `Authorization: Bearer <Supabase access token>` —— 后台按钮带的登录票，走 `requireAdmin`。

没配 `CRON_SECRET` 时生产环境只认 ①；开发环境无票时照旧放行。响应一律 `Cache-Control: no-store`，
路由声明 `dynamic = 'force-dynamic'`（GET 也能触发推送，被缓存住就等于点了没反应）。

### 前端提示

| 结果 | 文案 |
|---|---|
| 全部成功 | 成功推送 N 条页面链接至 Bing/Yandex |
| 部分被拒 | 已推送 M / N 条，其余被拒：`<IndexNow 原始原因>` |
| 401 | 登录已过期…（重新登录） |
| 503 | 连不上 Supabase Auth，稍后重试即可（**别**赶人去重登） |

403 通常 = `ComeBrief/public/<key>.txt` 取不到或内容与 `INDEXNOW_KEY` 不一致；
422 = URL 不属于该 host。

### 手动复验

```bash
# 只读 sitemap，不推送
curl 'http://localhost:3001/api/admin/index-push?dry=1'
# 生产（cron 通道）
curl -X POST 'https://<admin-host>/api/admin/index-push' -H "Authorization: Bearer $CRON_SECRET"
```
