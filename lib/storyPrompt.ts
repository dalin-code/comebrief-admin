/**
 * 故事创作面板的「大脑」 —— 把站长选中的标签，翻译成给 AI 的写作指令。
 *
 * 设计要点（这是整套功能里最值得花心思的一块）：
 *   1. 每个标签不只是把名字塞进去，而是把「定义 + 例句」一起给模型。
 *      只给名字（例如"白描"），模型会自己去猜，出来的东西往往很油；
 *      给了例句，它就有了可以模仿的手感。
 *   2. 末尾的禁忌清单是必须的。不写清楚，模型会自动往「升华、总结人生、
 *      仿佛/似乎、命运/灵魂」这些方向滑 —— 那就是所谓"AI 味"。
 *   3. 输出用 <<<TITLE>>> 这种分隔符而不是 JSON：1500 字的中文正文塞进 JSON
 *      字符串里，转义很容易出问题；纯文本分隔符则天然安全。
 */

export type DimensionKey = 'genre' | 'era' | 'pov' | 'style' | 'structure' | 'ending' | 'pace'

/**
 * 去掉模型偶尔自己加的 ``` 包裹。
 * 放在这个文件里（而不是 aiGemini）是为了让 storyPrompt 保持「零依赖」——
 * 后台面板是客户端组件，也会 import 这个文件做预览清洗，不能把服务端工具带进浏览器。
 */
export const stripFences = (text: string) =>
  String(text || '')
    .replace(/^\s*```[a-zA-Z]*[ \t]*\r?\n/, '')
    .replace(/\r?\n?```\s*$/, '')
    .trim()

/* ---------------- 模型「数数残渣」的识别与清理 ---------------- */

/**
 * 括号编号标记：`(101)`、`（99）`。
 *
 * 这是 Gemini 3.x 开着思考时的一种真实故障：它会一边写摘要一边**一个汉字一个汉字地数**
 * （因为提示词里规定了「不超过 120 字」，它就想核对字数），数数的过程写进了正式输出，
 * 于是摘要栏里出现 `99)经(100)蜕(101)变(102)的…` 这种鬼东西。
 * 更糟的是思考 token 和答案共用 maxOutputTokens，思考吃掉 980/1024 之后
 * finishReason 变成 MAX_TOKENS，那串数数记录还会被截掉前半截 —— 站长看到的「摘要」
 * 就是半截乱码。根治办法是关掉思考（thinkingConfig.thinkingBudget = 0），
 * 下面两个函数是兜底：认出来就别写进栏目，宁可报错重试。
 */
const COUNT_MARK = /[（(]\s*\d{1,4}\s*[)）]/g

/** 整段就是数数残渣吗（`(101)接(102)与…` 这种标记又密又多） */
export function isCountLeak(text: string) {
  const s = String(text || '')
  const marks = s.match(COUNT_MARK) || []
  // 少于 3 个标记的不算 —— 正常摘要里出现一个 `(2024)` 是合理的
  if (marks.length < 3) return false
  const plain = s.replace(/\s/g, '')
  if (!plain) return false
  return marks.length / plain.length > 0.12
}

/**
 * 把数数残渣从模型输出里剔掉。
 *   ① 整段都是残渣 → 返回空串（调用方应该报「请重试」，而不是把乱码写进栏目）
 *   ② 好句子后面拖了一串（`…拉开序幕。 Count: 那(`）→ 只留下前面那句
 */
export function stripCountLeak(text: string) {
  const s = String(text || '').trim()
  if (!s) return ''
  if (isCountLeak(s)) return ''
  // 「Count:」「字数：」这类标签后面跟的一定是草稿，从标签处砍掉
  const labeled = s.split(/\s*(?:Count|字符数|字数|计数)\s*[:：]/i)[0].trim()
  const marks = [...labeled.matchAll(COUNT_MARK)]
  if (marks.length >= 3) return labeled.slice(0, marks[0].index ?? 0).trim()
  return labeled
}

/**
 * 「这段看着是不是中文正文」。
 *
 * 用来兜住「页签错位」这种人为失误：编辑页默认停在英文页签，有人直接往里粘中文，
 * 于是英文栏里躺着中文、中文原稿那一栏是空的。这时候要是照着「英文摘要」去问模型，
 * 它会顺着正文语言吐一段中文回来（英文栏里挂一段中文，前台直接难看）；
 * 翻译那边也会因为读不到中文原稿而误报「中文正文太短了」。
 * 默认要求至少 minChars 个字符，免得把一句中文台词当成整篇原稿。
 */
export function isMostlyChinese(text: string, minChars = 80) {
  const plain = String(text || '').replace(/\s/g, '')
  if (plain.length < minChars) return false
  return countChineseChars(plain) / plain.length >= 0.3
}

/**
 * 挑出「中文原稿」那一份正文。
 *
 * 编辑页新建稿默认停在英文页签（lang 初值是 'en'），有人会直接往那边粘中文；
 * 老稿子的 content_zh_html 也可能是空的（线上抽查 20 篇有 19 篇是空的）。
 * 这两种情况下「正经位置」都是空串，翻译就会误报「中文正文太短了」——
 * 明明编辑器里躺着一整篇中文。
 *
 * 所以：official（正经位置）看着是中文就用它；否则去 others 里找第一份看着是中文的，
 * 并回报 recovered = true —— 调用方要负责把它写回 ref / 编辑器，不然保存时
 * 它会被当成英文版写进 content_html，中文那一栏永远是空的。
 */
export function pickChineseOriginal(opts: {
  /** 正经位置：停在中文页签时是编辑器正文，否则是暂存的 ref */
  official: string
  /** 另一边：停在中文页签时是暂存的英文 ref，否则先看编辑器再看英文 ref */
  others?: string[]
  /** 多少字才算「一篇原稿」而不是一句台词 */
  minChars?: number
}): { html: string; recovered: boolean } {
  const min = opts.minChars ?? 80
  const official = String(opts.official || '')
  if (isMostlyChinese(htmlToPlainText(official), min)) return { html: official, recovered: false }
  for (const other of opts.others || []) {
    const html = String(other || '')
    if (isMostlyChinese(htmlToPlainText(html), min)) return { html, recovered: true }
  }
  return { html: official, recovered: false }
}

/** HTML 正文 → 纯文本（翻译、摘要、字数统计都要先看纯文本） */
export const htmlToPlainText = (html: string) =>
  String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|blockquote|li|div)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export type StoryTag = {
  id: string
  dimension: DimensionKey
  name: string
  summary: string
  example: string
  usage_note: string
  sort_order: number
  is_active: boolean
}

export type StoryCombo = Partial<Record<DimensionKey, string[]>> & {
  length?: number
  idea?: string
  materials?: string
  /** 写法 code（A–F）。留空 = 用 story_skills 表里的默认写法 */
  skill?: string
}

/** 7 排的显示顺序与中文名 —— 后台面板与提示词共用这一份定义，不会再对不上 */
export const DIMENSIONS: Array<{
  key: DimensionKey
  label: string
  cn: string
  hint: string
  /** 最多能选几个 */
  max: number
}> = [
  { key: 'genre', label: '题材', cn: '①', hint: '写什么', max: 2 },
  { key: 'era', label: '时代', cn: '②', hint: '发生在什么时候', max: 1 },
  { key: 'pov', label: '视角', cn: '③', hint: '谁在讲', max: 1 },
  { key: 'style', label: '风格', cn: '④', hint: '语言长什么样', max: 2 },
  { key: 'structure', label: '结构', cn: '⑤', hint: '怎么排', max: 1 },
  { key: 'ending', label: '结局', cn: '⑥', hint: '怎么收', max: 1 },
  { key: 'pace', label: '节奏', cn: '⑦', hint: '快还是慢', max: 1 },
]

export const LENGTH_PRESETS = [
  { value: 800, label: '短（约 800 字）' },
  { value: 1500, label: '中（约 1500 字）' },
  { value: 2500, label: '长（约 2500 字）' },
]

/** 全局禁忌清单 —— 这一段的措辞直接决定成品有没有"AI 味" */
const FORBIDDEN = [
  '不许升华点题、不许在结尾总结人生道理',
  '不许写「他感到害怕」「她很伤心」这类直接把情绪说出来的句子',
  '不许出现命运、灵魂、救赎、深渊、宿命这类大词',
  '不许用排比句堆砌气氛，不许写散文诗',
  '不要连续使用「仿佛 / 似乎 / 好像」，全文最多出现两次',
  '不许出现「本文」「这个故事告诉我们」这类旁白',
]

/**
 * 默认世界设定：欧美背景。
 *
 * 站长 2026-10 的要求：人物、地名、生活场景一律以欧美国家为主，不要主动塞中国元素，
 * 除非他在【本篇构思】或【素材】里明确点名要中国背景。这里只写"默认值"，
 * 并且把优先级写死在最后一行 —— 站长的要求永远压过这一整段。
 *
 * 放在 system（buildStorySystemPrompt）里：它每次生成都一模一样，能稳定命中提示缓存。
 */
export const DEFAULT_WORLD_BRIEF = [
  '【世界设定（默认值）】',
  '- 故事默认发生在欧美世界：美国、英国、爱尔兰、加拿大、澳大利亚，或欧洲的城市与小镇。用当地的地名、季节、街景、职业。',
  '- 人物用西方名字，中文里按音译写：Noah Bennett → 诺亚·班尼特，Grace O’Connell → 格蕾丝·奥康奈尔。',
  '- 地名同样音译：Portland → 波特兰，Brighton → 布莱顿，the Lake District → 湖区。',
  '- 生活细节也用欧美的：超市、加油站、教堂、地铁、感恩节或圣诞节、美元英镑欧元、英里与华氏度。',
  '- 不要主动写中国元素：中式姓名、中式称谓（老王、张姨）、中式节日（春节、中秋）、中式饮食与计量（斤、两、人民币）、中国地名。',
  '- 例外：站长的【本篇构思】或【素材】里明确要求中国（或其他国家）背景时，一切以站长的要求为准。',
  '',
  '【优先级】站长的构思 > 站长的素材（情节主干照它写）> 本默认设定 > 你自己的自由发挥。',
].join('\n')

/**
 * 对抗同质化 —— 这几条是"每次生成都要重新做一遍"的硬要求。
 *
 * 为什么需要它：模型写短篇有极强的路径依赖，同一个标签组合连写几次，
 * 出来的往往是"同一个故事的换皮版"（同样的万能开场、同样的独居主角、同样的雨夜）。
 * 把这些最常撞的套路直接写成禁令，比事后让站长一篇篇去改便宜得多。
 */
const ANTI_REPETITION = [
  '动笔前先定一个"这一篇独有"的具体画面（一个能被拍下来的瞬间），再开始写；不要从"一个普通的早晨""闹钟响了"这类万能开场滑进去。',
  '主角的年龄、职业、住处、当天的天气，每一篇都要换，不许沿用上一篇的配置 —— 但站长的【本篇构思】或【参考素材】已经指定的，照其指定，不许改。',
  '不要用这些开场：闹钟响起、雨夜里的电话、镜子里的自己、翻开旧照片、多年以后、深夜的便利店（改编底本里就是这么开场的除外）。',
  '标题要落在一个具体的物件或动作上，不要用「孤独 / 城市 / 时间 / 记忆 / 光」这类抽象词。',
  '冲突必须来自主角当下正在做的一件具体的小事（一个动作、一句对话、一件要交出去的东西），不要靠回忆或旁白交代前史。',
]

const OUTPUT_SPEC = [
  '【输出格式（严格照办，不要输出任何多余内容）】',
  '<<<TITLE>>>',
  '（一份中文标题，12 字以内，不要加书名号）',
  '<<<EXCERPT>>>',
  '（80–120 字的内容摘要，用于前台列表页，不要剧透结局）',
  '<<<BODY>>>',
  '（正文：用 <p> 分段；需要小标题时用 <h3>；强调用 <strong>；引用用 <blockquote>）',
]

function renderTags(tags: StoryTag[] | undefined) {
  const list = (tags || []).filter(Boolean)
  if (!list.length) return ''
  return list
    .map((t) => {
      const lines = [`  ${t.summary || t.name}`]
      if (t.example) lines.push(`  例句参考：${t.example}`)
      if (t.usage_note) lines.push(`  适用：${t.usage_note}`)
      return lines.join('\n')
    })
    .join('\n')
}

/**
 * 拼出「生成一篇中文短篇」的完整指令。
 * combo 里某个维度没选 → 那段就不出现，把决定权交给模型。
 */
/** 「写作要求 + 禁忌清单 + 输出格式」—— 每次生成都一模一样，独立出来放 system，可被提示缓存 */
function buildStoryRules() {
  return [
    '【写作要求】',
    `- 直接开始讲故事。不要写标题、不要写「以下是」、不要解释、不要在结尾总结。`,
    '- 用具体的动作、对话、物件推进剧情；形容词能省就省。',
    '- 人名、地名要具体（例如「诺亚·班尼特」「波特兰的老码头」），不要用「小明」「某地」这类占位词。',
    '- 使用中文全角标点。对话用「」或「」，全文统一。',
    '',
    '【对抗同质化（每次生成都要重新做一遍，不许偷懒沿用上一篇的配置）】',
    ...ANTI_REPETITION.map((x) => `- ${x}`),
    '',
    '【禁忌清单（出现任何一条都算失败）】',
    ...FORBIDDEN.map((x) => `- ${x}`),
    '',
    ...OUTPUT_SPEC,
  ].join('\n')
}

/**
 * 「参考素材」= 改编底本（不是「只取细节的参考资料」）。
 *
 * 站长 2026-10 的原话：面板上的【参考素材】是他手写的原始故事 / 梗概，
 * 他要的是**以这份内容为主线情节**改编 —— AI 只补细节、场景衔接和缺失的铺垫，
 * 不许天马行空另写一篇（「不管给什么参考，写的故事基本上都是一个」就是这么来的）。
 *
 * 以前的措辞是「可参考的素材（用来获取细节和真实感，不要照抄句子）」，
 * 等于把一整篇梗概降级成了氛围素材，模型当然会自己另编一个故事。改成「改编底本」之后，
 * 下面这份措辞还要同时顶掉提示词里另外三处会「抢戏」的指令：
 *   · ANTI_REPETITION 的「主角配置每篇都要换」→ 素材定了就照素材（见上面那条限定语）；
 *   · avoidTitles 的「必须和往期明显不同」→ 只在素材没写到的部分生效；
 *   · DEFAULT_WORLD_BRIEF 的默认欧美背景 → 构思 / 素材点了名的以它们为准。
 * 最后再用一段「冲突时的优先级」收口，模型才不会各条指令各信一半。
 */
const ADAPT_MATERIAL_HEADER = '【改编底本（这是这一篇的情节主干，必须照它写）】'

const ADAPT_MATERIAL_RULES = [
  '下面这段是站长给的原始故事 / 梗概。你要做的是把它改编成一篇符合上面标签设定的中文短篇：',
  '- 主要人物及其关系、关键事件与因果、真相与反转、结局方向 —— 一律照它来。不许另起一个故事，不许把它的核心场景换掉。',
  '- 它没写到的部分（怎么开场、对话、动作、细节、过渡）由你补足；补的内容必须与它一致，不能引入与它冲突的新情节。',
  '- 可以按上面的【题材 / 时代 / 视角 / 风格】调整人名、地名、人称与文风。',
  '- 句子用你自己的写法重写，不要整段照抄下面的原文。',
].join('\n')

/** 「标签设定 + 构思 + 素材 + 篇幅」—— 每篇都不一样，放 user；且放在最后，模型记得最牢 */
function buildStorySetting(input: {
  combo: StoryCombo
  tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>>
  idea: string
  materials: string
  length: number
  /**
   * 最近已经写过的几篇（标题）。
   * 站长的原话是"文章同质化严重" —— 把上一篇的标题贴回给模型，是最省事也最有效的去重手段：
   * 它自己就能看出"哦，又写了一个雨夜 + 独居主角"，从而换一条路走。
   * 不传 / 传空数组时，这一段完全不出现（P0 盲测脚本要的"前后逐字节一致"靠这个保住）。
   */
  avoidTitles?: string[]
}) {
  const { tagsByDimension, idea, materials, length } = input
  const avoidTitles = (input.avoidTitles || []).map((t) => String(t || '').trim()).filter(Boolean).slice(0, 16)
  const lengthMin = Math.max(200, Math.round(length * 0.9))
  const lengthMax = Math.round(length * 1.15)

  const settingBlocks: string[] = []
  for (const dim of DIMENSIONS) {
    const picked = tagsByDimension[dim.key]
    if (!picked || !picked.length) continue
    const names = picked.map((t) => t.name).join(' ＋ ')
    settingBlocks.push(`【${dim.cn} ${dim.label}】${names}\n${renderTags(picked)}`)
  }

  const material = materials.trim().slice(0, 4000)
  const hasMaterial = !!material

  const parts = [
    settingBlocks.length ? settingBlocks.join('\n\n') : '（本次没有指定维度，请你自行判断最合适的写法。）',
    '',
    '【本篇构思（站长的总体要求，优先于改编底本）】',
    idea.trim() ||
      (hasMaterial
        ? '（没有额外构思：围绕下面的改编底本写，不要自己另想一个故事。）'
        : '（没有额外构思：请围绕上面选定的题材自行设计一个具体、可信、有画面的故事。）'),
  ]

  // 有素材 = 有情节主干。它紧跟构思、又在「对抗同质化 / 往期标题」之前，
  // 后面再补一段「冲突时的优先级」收口，模型才不会一边照素材、一边又去换主角。
  if (hasMaterial) parts.push('', ADAPT_MATERIAL_HEADER, ADAPT_MATERIAL_RULES, material)

  if (avoidTitles.length) {
    const titles = [
      '【最近已经写过的（这一篇必须和它们明显不同）】',
      avoidTitles.map((t) => `《${t}》`).join('、'),
      '请换一套开场方式、一个不同的主角配置（年龄 / 职业 / 住处）、一个不同的季节与地点，',
      '也不要重复上面这些故事里的核心物件与冲突。如果上面没有列出构思，就自己另想一个。',
    ]
    if (hasMaterial) {
      titles.push(
        '（有改编底本时，这一条只在素材没写到的部分生效 —— 不许为了「和往期不同」改掉素材里的开场、主角或核心冲突。）'
      )
    }
    parts.push('', ...titles)
  }

  if (hasMaterial) {
    parts.push(
      '',
      '【冲突时的优先级】站长的构思 > 改编底本的情节主干 > 默认世界设定 > 标签以外的自由发挥。',
      '素材已经定好的开场方式、主角配置、核心物件与冲突，一律照用，',
      '不许为了「和往期不一样」或「写得更漂亮」把它们换掉。'
    )
  }

  parts.push('', `【篇幅】${length} 字左右（${lengthMin}–${lengthMax} 字之间，宁可写满也不要写短）`)

  return parts.join('\n')
}

/** 角色定位 —— system 的第一段，永远不变 */
const STORY_ROLE = [
  '你是一位中文短篇小说作家，专门写两三分钟就能读完的短篇。',
  '请严格按照下面的设定，写一篇完整的故事。',
].join('\n')

/* ============================================================
 * 写法层（story_skills）：同一套标签，"怎么写"还能再换一档
 *
 * 背景：AI 味主要不在用词，而在**叙述姿态**（句长、停顿、说多少、
 * 什么时候收）。所以每个写法给三样东西：
 *   posture  姿态板 —— 明确告诉模型这次要偏在哪几条上
 *   exemplar 范文   —— 让它直接模仿手感，比讲一百句道理有用
 *   rules    专属规矩 + avoid 易踩的坑
 * ============================================================ */

export type StorySkill = {
  id?: string
  /** A/B/C/D/E/F —— 后台选择器上显示的那个字母 */
  code: string
  name: string
  /** 一句话卖点，选择器上的一行小字 */
  tagline?: string
  summary: string
  posture: string
  exemplar: string
  rules: string
  avoid: string
  /** 适合什么题材，只在后台展示，不进提示词 */
  best_for?: string
  /** 下面是库里那几列，只给后台管理页用（生成时不读） */
  sort_order?: number
  is_active?: boolean
  is_default?: boolean
}

/** 把写法渲染成提示词里的一段 */
export function buildSkillBlock(skill: StorySkill) {
  const parts: string[] = []
  parts.push(`【本次写法 · ${skill.code ? `${skill.code} ` : ''}${skill.name}】`)
  if (skill.summary.trim()) parts.push(`这个写法在干什么：${skill.summary.trim()}`)
  if (skill.posture.trim()) {
    parts.push('', '【姿态板：这次必须明显偏在这几条上（不偏就是 AI 的默认腔调，也就是所谓的 AI 味）】', skill.posture.trim())
  }
  if (skill.rules.trim()) parts.push('', '【这个写法专属的规矩】', skill.rules.trim())
  if (skill.avoid.trim()) parts.push('', '【这个写法最容易踩的坑（踩了就算写砸）】', skill.avoid.trim())
  if (skill.exemplar.trim()) {
    parts.push(
      '',
      '【范文：学它的句子长短、停顿位置、句子怎么结束 —— 不要抄情节、不要抄人物、不要抄句子】',
      skill.exemplar.trim()
    )
  }
  return parts.join('\n')
}

/**
 * system 提示词：稳定不变的那一半。
 * 顺序是「角色 → 写法（含范文）→ 世界设定 → 对抗同质化 + 写作要求与禁忌 → 输出格式」。
 * 每一段都不随请求变化，所以能稳定命中提示缓存 —— 别往里面塞随请求变的东西。
 */
export function buildStorySystemPrompt(skill?: StorySkill | null) {
  const parts: string[] = [STORY_ROLE]
  if (skill) parts.push('', buildSkillBlock(skill))
  parts.push('', DEFAULT_WORLD_BRIEF)
  parts.push('', buildStoryRules())
  return parts.join('\n')
}

/** user 提示词：这一篇专属的那一半（标签 + 构思 + 素材 + 不要撞的往期标题 + 篇幅） */
export function buildStoryUserPrompt(input: {
  combo: StoryCombo
  tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>>
  idea: string
  materials: string
  length: number
  /** 最近写过的标题 —— 用来把新一篇和旧的拉开距离，见 buildStorySetting */
  avoidTitles?: string[]
}) {
  return buildStorySetting(input)
}

/**
 * 兼容函数：把两半拼成「一整段」。
 * 拼接顺序与 buildStorySystemPrompt + buildStoryUserPrompt 保持一致（system 在前、user 在后），
 * 这样 P0 盲测脚本拿它当"线上提示词"的样本来核对时不会失真。
 */
export function buildStoryPrompt(input: {
  combo: StoryCombo
  tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>>
  idea: string
  materials: string
  length: number
  /** 选了写法就把范文一起给模型；不传则与拆分前的提示词逐字节一致 */
  skill?: StorySkill | null
  /** 最近写过的标题（可选）；不传时这一段不出现 */
  avoidTitles?: string[]
}) {
  const parts: string[] = [STORY_ROLE, '']
  if (input.skill) parts.push(buildSkillBlock(input.skill), '')
  parts.push(DEFAULT_WORLD_BRIEF, '')
  parts.push(buildStorySetting(input), '', buildStoryRules())
  return parts.join('\n')
}

/** 文风/结构类标签在提示词里的权重最高 —— 单独导出给「为什么这么写」的说明用 */
export function describeCombo(tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>>) {
  return DIMENSIONS.filter((d) => (tagsByDimension[d.key] || []).length)
    .map((d) => `${d.label}：${(tagsByDimension[d.key] || []).map((t) => t.name).join('＋')}`)
    .join(' · ')
}

/**
 * 中文 → 英文。
 * 站长选的方案是「母语化重写」：读起来必须像英语作家直接写的，不能有翻译腔；
 * 但情节、情绪、结局、伏笔位置一律不动 —— 这是不能越的红线。
 */
export function buildTranslatePrompt(input: {
  zhTitle: string
  zhExcerpt: string
  zhBodyText: string
  zhLength: number
}) {
  const { zhTitle, zhExcerpt, zhBodyText, zhLength } = input
  // 中文 → 英文的经验字数比约 1 : 0.65（词）
  const words = Math.max(400, Math.round(zhLength * 0.65))
  const wordsMin = Math.round(words * 0.85)
  const wordsMax = Math.round(words * 1.2)

  return [
    'You are a native English-speaking fiction editor.',
    'Below is a finished short story written in Chinese.',
    'Rewrite it as an ORIGINAL ENGLISH short story — a reader must never feel it was translated.',
    '',
    '【不可越界的红线】',
    '1. 情节、人物、人物关系、情绪走向、结局指向、伏笔位置，一律保持不变。',
    '   不许增加情节、不许删减情节、不许新增角色、不许改结局。',
    '2. 不要解释中国文化背景，也不要加译注 —— 需要读者自己体会的地方就让它留白。',
    '',
    '【可以自由发挥的地方】',
    '3. 句子顺序可以重组；中文成语、俗语不要直译，换成英语读者熟悉的说法。',
    '4. 中文的「留白」用英语的短句、停顿、留白来还原，不要补充说明。',
    '5. 保持原文的语气与节奏：原文快就快，原文慢就慢，原文冷就冷。',
    '6. 人名、地名一律还原成自然的英文写法（「诺亚·班尼特」→ Noah Bennett，「波特兰」→ Portland），',
    '   全篇统一 —— 同一个人从头到尾只能有一个英文写法。原文若是拼音名（Lin Wan），保留拼音即可。',
    '',
    `【篇幅】English, ${wordsMin}–${wordsMax} words（对应中文约 ${zhLength} 字）。`,
    '',
    '【英文写作要求】',
    '- Use straight, concrete prose. Show, do not tell. Avoid adjectives piling up.',
    '- 用英语全角标点；引号用弯引号 “ ”；破折号用 —。',
    '- 不要写标题以外的任何说明文字。',
    '',
    '【原始中文信息】',
    `中文标题：${zhTitle || '（无）'}`,
    `中文摘要：${zhExcerpt || '（无）'}`,
    '',
    '中文正文：',
    zhBodyText.slice(0, 12000),
    '',
    '【输出格式（严格照办，不要输出任何多余内容）】',
    '<<<TITLE>>>',
    '(The English title, in Title Case.)',
    '<<<EXCERPT>>>',
    '(A 120–180 character English excerpt for the listing page. Do not spoil the ending.)',
    '<<<BODY>>>',
    '(The English story body. Use <p> for paragraphs, <h3> for a section heading if needed, <strong> for emphasis, <blockquote> for quoted passages.)',
  ].join('\n')
}

/* 分批翻译的常量与提示词见本文件末尾的「分批翻译」一节 */

/** 生成摘要 —— 跟随当前语言页签：中文页签生成中文摘要，英文页签生成英文摘要 */
export function buildExcerptPrompt(input: {
  language: 'zh' | 'en'
  title: string
  bodyText: string
  excerpt?: string
}) {
  const { language, title, bodyText } = input
  if (language === 'zh') {
    return [
      '下面是一篇文章的标题和正文。请为它写一段摘要。',
      '',
      '要求：',
      '- 一段话，80–120 个汉字，中间不要换行。',
      '- 说清「讲了什么」＋「为什么值得读」，制造一点点好奇。',
      '- 不要剧透结局，不要用「本文」「这篇文章」开头，不要用引号包裹。',
      '- 只输出摘要本身，不要任何前后缀。',
      '',
      `标题：${title || '（无）'}`,
      '正文：',
      bodyText.slice(0, 8000),
    ].join('\n')
  }
  return [
    'Below is the title and body of an article. Write a summary for it.',
    '',
    'Requirements:',
    '- One paragraph, 120–180 characters, no line breaks.',
    '- Cover what the story is about and why it is worth reading; create a little curiosity.',
    '- Do not spoil the ending. Do not start with "This article". Do not wrap it in quotes.',
    '- Output the summary only, with no prefix or suffix.',
    '',
    `Title: ${title || '(none)'}`,
    'Body:',
    bodyText.slice(0, 8000),
  ].join('\n')
}

/* ============================================================
 * 输出解析与清洗
 * ============================================================ */

const SECTION_KEYS = ['TITLE', 'EXCERPT', 'GLOSSARY', 'BODY'] as const

/** 取 `<<<KEY>>>` 到下一个分隔符之间的内容 */
function pickSection(text: string, key: string) {
  const marker = `<<<${key}>>>`
  const start = text.indexOf(marker)
  if (start === -1) return ''
  const after = text.slice(start + marker.length)
  const next = after.search(/<<<[A-Z_]+>>>/)
  return (next === -1 ? after : after.slice(0, next)).trim()
}

/**
 * 解析三段（分批翻译时是四段）式输出。
 * 正文用「BODY 之后全部内容」兜底，这样即使模型把 EXCERPT 落下了也不会吃掉正文。
 * 完全没写分隔符时 → 整段当成正文，标题由调用处兜底。
 *
 * GLOSSARY 只在"分批翻译"的第一段出现：它是人名/地名对照表，要喂给后面几段，
 * 好让第 3 段里的同一个角色和第 1 段拼得上一模一样。它必须排在 BODY 之前
 * ——正文取的是「BODY 之后全部」，排在后面会被一起吞掉。
 */
export function parseDelimitedStory(raw: string): { title: string; excerpt: string; glossary: string; body: string } {
  const text = stripFences(String(raw || ''))
  if (!SECTION_KEYS.some((k) => text.includes(`<<<${k}>>>`))) {
    return { title: '', excerpt: '', glossary: '', body: text }
  }
  const bodyMarker = text.indexOf('<<<BODY>>>')
  const head = bodyMarker === -1 ? text : text.slice(0, bodyMarker)
  const body = bodyMarker === -1 ? '' : text.slice(bodyMarker + '<<<BODY>>>'.length).trim()
  const title = pickSection(head, 'TITLE')
  const excerpt = pickSection(head, 'EXCERPT')
  const glossary = pickSection(head, 'GLOSSARY')
  return { title, excerpt, glossary, body: body || pickSection(text, 'EXCERPT') }
}

const ALLOWED_TAGS = new Set(['p', 'h2', 'h3', 'blockquote', 'strong', 'em', 'ul', 'ol', 'li', 'br', 'hr'])
const VOID_TAGS = new Set(['br', 'hr'])
const DANGEROUS_TAGS = 'script|style|iframe|object|embed|form|input|button|svg|img|video|audio|link|meta|base|noscript'

const escapeHtml = (s: string) =>
  String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * 把模型吐出来的 HTML 洗成编辑器敢直接吃的样子。
 * 白名单以外的标签一律去掉外壳、保留文字；所有属性（style / class / on*）全部丢弃。
 * —— 模型偶尔会夹带 <script> 或 style 属性，直接塞进 Tiptap 是不安全的。
 */
export function sanitizeStoryHtml(input: string): string {
  let html = String(input || '')
  html = html.replace(/<!--[\s\S]*?-->/g, '')
  html = html.replace(new RegExp(`<\\s*(${DANGEROUS_TAGS})[^>]*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>`, 'gi'), '')
  html = html.replace(new RegExp(`<\\s*/?\\s*(${DANGEROUS_TAGS})[^>]*>`, 'gi'), '')
  html = html.replace(/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (_m, slash: string, tagRaw: string) => {
    let tag = String(tagRaw).toLowerCase()
    if (tag === 'b') tag = 'strong'
    else if (tag === 'i') tag = 'em'
    else if (tag === 'h1') tag = 'h2'
    else if (tag === 'h4' || tag === 'h5' || tag === 'h6') tag = 'h3'
    if (!ALLOWED_TAGS.has(tag)) return ''
    if (VOID_TAGS.has(tag)) return `<${tag}>`
    return `<${slash}${tag}>`
  })
  html = html.replace(/(<p>\s*<\/p>\s*)+/g, '')
  html = html.replace(/(<br>\s*){3,}/g, '<br><br>')
  return html.trim()
}

/** 模型返回纯文本 / Markdown 时的兜底：按空行切段，`## 小标题` 转成 h3 */
export function plainTextToHtml(text: string): string {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const heading = line.match(/^#{1,4}\s+(.+)$/)
    if (heading) {
      out.push(`<h3>${escapeHtml(heading[1].replace(/[#*`]/g, '').trim()).slice(0, 120)}</h3>`)
      continue
    }
    const boldLine = line.match(/^\*\*(.+)\*\*$/)
    out.push(`<p>${escapeHtml(boldLine ? boldLine[1] : line)}</p>`)
  }
  return out.join('\n')
}

/** 模型没给 HTML（或清洗后什么都不剩）时的统一出口 */
export function toStoryHtml(body: string): string {
  const cleaned = sanitizeStoryHtml(body)
  if (/<(p|h2|h3|blockquote|ul|ol)\b/i.test(cleaned)) return cleaned
  const fromPlain = plainTextToHtml(body)
  return fromPlain || `<p>${escapeHtml(body)}</p>`
}

/* ============================================================
 * 长度统计 & 网址 slug
 * ============================================================ */

/** 汉字个数（不含标点空格）—— 用来检查模型是不是偷偷写短了 */
export const countChineseChars = (text: string) =>
  (String(text || '').match(/[\u4e00-\u9fa5]/g) || []).length

/** 英文词数 */
export const countWords = (text: string) =>
  String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length

/**
 * 生成网址用的 slug（只保留 a-z0-9）。
 * 中文标题会得到空字符串 —— 这正是「中文标题生成 --x7k2p 这种垃圾网址」的根源。
 * 所以英文版翻译好之后，一定要用英文标题来生成 slug。
 */
export function slugify(input: string) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '')
}

/** 带随机尾巴的最终 slug；英文标题为空时返回 ''（调用处自己决定怎么兜底） */
export function buildArticleSlug(englishTitle: string) {
  const base = slugify(englishTitle)
  if (!base) return ''
  return `${base}-${Math.random().toString(36).substring(2, 7)}`
}

/** 现有 slug 是否是一条「能用」的网址（至少含一个字母或数字） */
export const isUsableSlug = (slug: string) => /[a-z0-9]/.test(String(slug || '').toLowerCase())

/**
 * 「接着写下去」的指令。
 * 模型写长文时有个常见毛病：写到八成突然收尾（偷工）。与其重写一整篇赌运气，
 * 不如把已经写好的结尾贴回去，让它从断掉的地方续上 —— 便宜、稳、可控。
 */
/** 续写的「铁律 + 输出格式」—— 稳定不变，放 system */
function buildContinueRules() {
  return [
    '【铁律】',
    '- 不要重述前文、不要重新开头、不要写「前情提要」。直接从下一句接着写。',
    '- 保持同一人称、同一时态、同一语气，人物名字不许变。',
    '- 不要在结尾总结人生、不要升华。该收就收，收在该收的地方。',
    '- 如果上一段的结尾其实已经像一个正常的 ending，那就顺着它往后多写一层：'
      + '补一段真正的收束与前因后果，不要另起一个故事。',
    '',
    '【输出格式】',
    '只输出下面这一段，不要写标题、不要写摘要、不要任何说明：',
    '<<<BODY>>>',
    '（续写内容，用 <p> 分段；继续沿用原文的写法与标点习惯）',
  ].join('\n')
}

const CONTINUE_ROLE = '你正在写一篇中文短篇故事，但上一段写得太短就收尾了。请从断掉的地方接着写完。'

/** 续写的「设定 + 构思 + 素材 + 还差多少字 + 上文尾巴」—— 每次都变，放 user */
function buildContinueBrief(input: {
  tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>>
  idea: string
  /** 参考素材 = 改编底本；续写也得带着，否则「接着写下去」会把故事带回模型默认的那一套 */
  materials?: string
  tailText: string
  remainingWords: number
}) {
  const { tagsByDimension, idea, tailText, remainingWords } = input
  const material = String(input.materials || '').trim().slice(0, 4000)
  const settings = DIMENSIONS.filter((d) => (tagsByDimension[d.key] || []).length)
    .map((d) => {
      const picked = tagsByDimension[d.key] || []
      return `【${d.label}】${picked.map((t) => t.name).join('＋')}：${picked.map((t) => t.summary).join('；')}`
    })
    .join('\n')

  const parts = [
    '【这篇的设定（保持不变）】',
    settings || '（保持与上文一致）',
    '',
    '【本篇构思】',
    idea.trim() || '（保持与上文一致）',
  ]

  if (material) {
    parts.push(
      '',
      '【改编底本（续写不许偏离它的情节）】',
      '接着写的那部分，仍然要沿着这份底本的情节主干往前推：素材里还没讲到的接着讲，已经讲过的不要再讲一遍。',
      material
    )
  }

  parts.push(
    '',
    `【还要补】${Math.max(200, remainingWords)} 字左右，把故事真正讲完整。`,
    '',
    '【上文最后一段（供你接续，不要重复输出它）】',
    tailText.slice(-1200)
  )

  return parts.join('\n')
}

/**
 * 续写的 system 提示词（角色 + 写法 + 世界设定 + 铁律 + 输出格式）
 * 写法要一并带上：续写必须和前半篇是同一支笔，
 * 否则「接着写下去」会把腔调拉回模型默认的那股 AI 味 —— 前面白写。
 * 世界设定也要带上：续写的后半篇不能突然从波特兰跳回中国小城。
 */
export function buildContinueSystemPrompt(skill?: StorySkill | null) {
  const parts: string[] = [CONTINUE_ROLE]
  if (skill) parts.push('', buildSkillBlock(skill))
  parts.push('', DEFAULT_WORLD_BRIEF)
  parts.push('', buildContinueRules())
  return parts.join('\n')
}

/** 续写的 user 提示词（设定 + 构思 + 素材 + 还差多少 + 上文尾巴） */
export function buildContinueUserPrompt(input: {
  tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>>
  idea: string
  /** 参考素材 = 改编底本（可选；不传则与旧版逐字节一致） */
  materials?: string
  tailText: string
  remainingWords: number
}) {
  return buildContinueBrief(input)
}

/** 兼容函数：把续写的两半拼成一整段（不带写法，与拆分前逐字节一致） */
export function buildContinuePrompt(input: {
  tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>>
  idea: string
  materials?: string
  tailText: string
  remainingWords: number
}) {
  return [CONTINUE_ROLE, '', buildContinueRules(), '', buildContinueBrief(input)].join('\n')
}




/* ============================================================
 * 分批翻译（长文章中译英）
 *
 * 背景：一篇 3000 字的中文，英文要 2000 词左右。整篇一次性翻会同时撞上
 * 「模型单次输出上限」和「路由 60 秒超时」两道墙 —— 站长的体感就是
 * 「文章一长就翻译不了」。改成切块轮流翻，每块单独一次请求，长文也能翻完。
 *
 * 分工：
 *   切块（splitTranslationChunks）放在客户端 —— 编辑器那边先知道一共几块，
 *   才能显示「正在翻译 2/5」，也才能一块失败只重试那一块。
 *   服务端只负责翻它收到的那一块（buildTranslateChunkPrompt）。
 * ============================================================ */

/** 一次翻译多少汉字。900 字中文约 600 词英文，单次请求稳稳落在一分钟预算里。 */
export const TRANSLATE_CHUNK_CHARS = 900

/**
 * 中文正文 → 分批翻译用的段块（纯函数、确定性：同样的输入永远得到同样的切法）。
 *
 * 原则：
 *   1. 先按段落切 —— 正文是 <p> 出来的，htmlToPlainText 会把每一段化成一行。
 *      尽量不把一个段落劈开，劈开容易让模型的语气在中途断掉。
 *   2. 段落本身超过上限时，再按句号 / 问号 / 叹号切；单句还超长才硬切。
 *   3. 最后贪心装箱：能塞进当前一块就塞，塞不下就开新的一块。
 */
export function splitTranslationChunks(text: string, maxChars = TRANSLATE_CHUNK_CHARS): string[] {
  const clean = String(text || '').replace(/\r\n?/g, '\n').trim()
  if (!clean) return ['']
  const limit = Math.max(200, Math.floor(maxChars) || TRANSLATE_CHUNK_CHARS)

  const paragraphs = clean
    .split(/\n\s*\n|\n/)
    .map((s) => s.trim())
    .filter(Boolean)

  const units: string[] = []
  for (const paragraph of paragraphs) {
    if (paragraph.length <= limit) {
      units.push(paragraph)
      continue
    }
    for (const sentence of paragraph.split(/(?<=[。！？；…!?;])/)) {
      const piece = sentence.trim()
      if (!piece) continue
      if (piece.length <= limit) {
        units.push(piece)
        continue
      }
      for (let i = 0; i < piece.length; i += limit) units.push(piece.slice(i, i + limit))
    }
  }

  const chunks: string[] = []
  let cur = ''
  for (const unit of units) {
    if (cur && cur.length + unit.length + 1 > limit) {
      chunks.push(cur)
      cur = ''
    }
    cur = cur ? `${cur}\n${unit}` : unit
  }
  if (cur) chunks.push(cur)
  return chunks.length ? chunks : [clean]
}


/**
 * 分批翻译时「第 k 段」的提示词。
 *
 * 分段翻译真正的难点是**前后对不上**：人名一会儿 Noah 一会儿 Noah Bennett、
 * 第 3 段又把故事重新开了个头、语气突然变了。所以这里比整篇翻译多给三样东西：
 *   glossary 名词对照表（第 1 段产出，后面每段都带着，人名地名不可能走样）
 *   prevTail 上一段英文的尾巴（让它从断掉的地方接上，而不是自己另起一段）
 *   位置说明 这是第几段 / 共几段（不是开头就别写开头，不是结尾就别急着收尾）
 *
 * 输出格式也跟着变：只有第 1 段输出 TITLE / EXCERPT / GLOSSARY，
 * 其余段只输出 BODY —— 少让模型说废话，也少给它跑偏的机会。
 */
export function buildTranslateChunkPrompt(input: {
  /** 第几段（1 起） */
  part: number
  /** 一共几段 */
  parts: number
  /** 这一段的中文原文 */
  zhText: string
  /** 全文中文（只有第 1 段需要：用来写标题、摘要和名词对照表） */
  zhFullText?: string
  zhTitle?: string
  zhExcerpt?: string
  /** 上一段英文的尾巴（第 2 段起） */
  prevTail?: string
  /** 名词对照表（第 1 段的产物） */
  glossary?: string
}): string {
  const { part, parts, zhText } = input
  const isFirst = part <= 1
  const isLast = part >= parts
  const glossary = String(input.glossary || '').trim()

  const blocks: string[] = []
  blocks.push(
    [
      'You are a native English-speaking fiction editor.',
      `You are translating PART ${part} OF ${parts} of a finished Chinese short story into English.`,
      'Rewrite it as an ORIGINAL ENGLISH short story — a reader must never feel it was translated.',
      '',
      '【不可越界的红线】',
      '1. 情节、人物、人物关系、情绪走向、结局指向、伏笔位置一律保持不变；不许增加情节、不许删减情节、不许新增角色、不许改结局。',
      '2. 不要解释文化背景，也不要加译注 —— 需要读者自己体会的地方就让它留白。',
      '',
      '【分段翻译特有的规矩（整篇翻译不会踩，分段最容易踩）】',
      `3. 你只翻第 ${part} 段 / 共 ${parts} 段：既不要把整篇重讲一遍，也不要跳过这一段的内容。`,
      isFirst
        ? '4. 这一段是全文开头 —— 照中文的开头写，不要自己发明一个更"漂亮"的开场。'
        : '4. 这不是开头 —— 绝对不要重新起头、不要写「前情提要」、不要复述上一段，直接从上一段停下的地方往下写。',
      isLast
        ? '5. 这一段是结尾 —— 把故事收在中文原文收住的地方，不要额外补一段总结。'
        : '5. 这不是结尾 —— 不要收尾、不要总结、不要升华，故事后面还要继续。',
      '6. 保持同一人称、同一时态、同一语气；人名、地名一律用下面【名词对照表】里的写法。',
      '7. 中文成语、俗语不要直译，换成英语读者熟悉的说法；句子顺序可以重组。',
      '8. Use straight, concrete prose. Show, do not tell. 引号用弯引号 “ ”，破折号用 —。',
    ].join('\n')
  )

  if (glossary) {
    blocks.push('', '【名词对照表（必须照用，一个字母都不许改）】', glossary)
  }
  if (!isFirst && input.prevTail?.trim()) {
    blocks.push('', '【上一段英文的结尾（供你接续，不要重复输出它）】', input.prevTail.trim().slice(-600))
  }
  if (isFirst) {
    const full = String(input.zhFullText || '').trim()
    if (full) {
      blocks.push(
        '',
        '【全文中文（只用来写标题、摘要、名词对照表 —— 正文只翻下面那一段，别把全文都翻了）】',
        full.slice(0, 12000)
      )
    }
    blocks.push(
      '',
      `【中文标题】${String(input.zhTitle || '').trim() || '（无）'}`,
      `【中文摘要】${String(input.zhExcerpt || '').trim() || '（无）'}`
    )
  }

  blocks.push('', `【第 ${part} 段的中文原文（只翻这一段）】`, zhText.trim())

  blocks.push(
    '',
    '【输出格式（严格照办，不要输出任何多余内容）】'
  )
  if (isFirst) {
    blocks.push(
      '<<<TITLE>>>',
      '(The English title, in Title Case.)',
      '<<<EXCERPT>>>',
      '(A 120–180 character English excerpt for the listing page. Do not spoil the ending.)',
      '<<<GLOSSARY>>>',
      '(Every proper noun in the WHOLE story with its fixed English spelling, one per line, in the form 中文 = English — all person and place names, no duplicates.)',
      '<<<BODY>>>',
      `(The English text of PART 1 only. Use <p> for paragraphs, <h3> for a section heading if needed, <strong> for emphasis, <blockquote> for quoted passages.)`
    )
  } else {
    blocks.push(
      '<<<BODY>>>',
      `(The English text of PART ${part} only. Use <p> for paragraphs. Do NOT output TITLE / EXCERPT / GLOSSARY.)`
    )
  }

  return blocks.join('\n')
}

