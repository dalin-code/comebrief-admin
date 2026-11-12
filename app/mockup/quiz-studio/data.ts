/**
 * 静态稿的假数据 + 一个真的能跑的打分引擎。
 *
 * 为什么「静态稿」里还要塞真引擎：
 *   权重矩阵那一屏如果只是画几排印好的数字，看不出「改一格会影响到谁」。
 *   这里的热力底色、列合计、命中占比、健康分，全部由
 *   8 题 × 4 选项 = 65,536 种答案组合**全枚举**算出来 —— 你在屏 2 点一格，
 *   屏 2 的列合计和屏 3 的检查项会立刻跟着变。评审时能直接问
 *   「如果这个原型没人能抽到会怎样」，当场就能看到。
 *
 * 接真数据时：这份文件整体丢掉，enumerate() / healthChecks() 搬进
 * lib/quiz-axes.ts（纯函数、无副作用、不读环境变量，和 lib/quizPack.ts
 * 同一套路子，可以直接被 scripts/ 里的断言脚本复用）。
 */

export type ArchId = "sarcastic" | "observer" | "mainchar" | "overload";

export type Archetype = {
  id: ArchId;
  /** 结果名（会印在票根 / 海报上，长名溢出检查就是量它） */
  name: string;
  /** 矩阵表头用的短名，避免表头把列撑爆 */
  short: string;
  /** 原型自身色调，仅用于矩阵表头与结果卡描边 */
  tint: string;
};

export const ARCHETYPES: Archetype[] = [
  {
    id: "sarcastic",
    name: "The Sarcastic Meme Curator",
    short: "Sarc",
    tint: "#FF6B3D",
  },
  {
    id: "observer",
    name: "The Calm Observer",
    short: "Obsv",
    tint: "#3B82F6",
  },
  {
    id: "mainchar",
    name: "The Main Character",
    short: "Main",
    tint: "#8B5CF6",
  },
  {
    // 故意写成 47 字：屏 3 的「长名在 360px 下 4 行」警告要由真实数据触发，
    // 而不是我手写一行假警告。
    id: "overload",
    name: "The Midnight Overload Machine (Final Boss Edition)",
    short: "Ovld",
    tint: "#10B981",
  },
];

/** 一格权重：0 表示这个选项不为该原型加分。上限 3。 */
export type Weights = Record<ArchId, number>;

export type QuizOption = { id: string; text: string; w: Weights };

export type QuizQuestion = {
  id: string;
  /** 场景标签，矩阵里每题一行分组标题 */
  scene: string;
  title: string;
  options: QuizOption[];
};

const ZERO: Weights = { sarcastic: 0, observer: 0, mainchar: 0, overload: 0 };

export function opt(id: string, text: string, w: Partial<Weights> = {}): QuizOption {
  return { id, text, w: { ...ZERO, ...w } };
}

/**
 * 8 道题的示范卷（英文，对齐海外站口吻）。
 *
 * 第 6 题的 B 选项**故意全 0** —— 屏 3 的「废选项」警告是算出来的，
 * 给它旁边任意一格加 1 分，警告会立刻消失。
 */
export const QUESTIONS: QuizQuestion[] = [
  {
    id: "q1",
    scene: "Stranger party",
    title: "A friend drags you to a party, then vanishes for ten minutes. Your hand goes to…",
    options: [
      opt("q1a", "My phone. I look extremely busy replying to absolutely nobody.", { observer: 3 }),
      opt("q1b", "The snack table, then the dog. Anything but a stranger's eye contact.", {
        sarcastic: 2,
        observer: 2,
        overload: 1,
      }),
      opt("q1c", "The other person standing alone. I open with a self-deprecating joke.", {
        mainchar: 3,
        observer: 1,
      }),
      opt("q1d", "The balcony. Four minutes of short-form video and I'm recharged.", {
        overload: 3,
        mainchar: 1,
      }),
    ],
  },
  {
    id: "q2",
    scene: "Being shut down",
    title: "Someone shuts down your point, hard, in front of everyone. First instinct:",
    options: [
      opt("q2a", "Smile, say “fair enough,” and file them under never-speak-again.", {
        sarcastic: 3,
        overload: 1,
      }),
      opt("q2b", "Go cold. Lay out 1, 2, 3 until their argument quietly dies.", {
        mainchar: 3,
        sarcastic: 1,
      }),
      opt("q2c", "Replay my own wording and wonder if I actually said it badly.", {
        overload: 3,
        observer: 1,
      }),
      opt("q2d", "Step back and watch. Interesting that they got this heated about it.", {
        observer: 3,
      }),
    ],
  },
  {
    id: "q3",
    scene: "The “ok” text",
    title: "A friend replies to your long message with just “ok.” You…",
    options: [
      opt("q3a", "Write a whole film in my head. Re-read three days of chat history.", {
        overload: 3,
      }),
      opt("q3b", "Reply with an even colder sticker. Or nothing at all.", {
        sarcastic: 3,
        observer: 1,
      }),
      opt("q3c", "Call them. “What's with the tone?”", { mainchar: 3 }),
      opt("q3d", "Note it. Next time, keep the same distance.", { observer: 3 }),
    ],
  },
  {
    id: "q4",
    scene: "Emotional reset",
    title: "Bad week. The thing that actually resets you is…",
    options: [
      opt("q4a", "Noise-cancelling headphones, a long walk, volume at 100%.", { mainchar: 3 }),
      opt("q4b", "Phone off, door closed, three films and twelve memes.", { sarcastic: 3 }),
      opt("q4c", "Two hours of unfiltered complaining to the one friend who gets it.", {
        overload: 3,
      }),
      opt("q4d", "Cleaning, lists, and a plan. Order restored by force.", { observer: 3 }),
    ],
  },
  {
    id: "q5",
    scene: "Group chat",
    title: "In a group chat of twelve, someone posts a take you find deeply wrong. You…",
    options: [
      opt("q5a", "Type it, delete it, type it, delete it. Screenshot it.", {
        overload: 2,
        sarcastic: 1,
      }),
      opt("q5b", "Drop one devastating one-liner and leave the chat to burn.", { sarcastic: 3 }),
      opt("q5c", "Ask a genuine question that quietly dismantles it.", {
        mainchar: 2,
        observer: 2,
      }),
      opt("q5d", "Mute for eight hours and check whether anyone died.", { observer: 3 }),
    ],
  },
  {
    id: "q6",
    scene: "A sincere compliment",
    title: "Someone compliments you, sincerely and in public.",
    options: [
      opt("q6a", "Deflect with a joke. Compliments are a trap.", { sarcastic: 3 }),
      // ⚠️ 全 0：静态稿里用来演示「废选项」检查，不是笔误。
      opt("q6b", "Say thanks, then immediately compliment them back."),
      opt("q6c", "Take it. Honestly, they're right.", { mainchar: 3 }),
      opt("q6d", "Nod, then spend twenty minutes wondering what they wanted.", {
        overload: 3,
      }),
    ],
  },
  {
    id: "q7",
    scene: "Plans cancelled",
    title: "Plans get cancelled an hour before. Your body's reaction:",
    options: [
      opt("q7a", "Relief so loud it's almost embarrassing.", { sarcastic: 3, observer: 1 }),
      opt("q7b", "Already texting three people to fill the slot.", { mainchar: 3 }),
      opt("q7c", "Re-planning the entire evening in ninety seconds.", { observer: 3 }),
      opt("q7d", "Mild spiral about whether it was about me.", { overload: 3 }),
    ],
  },
  {
    id: "q8",
    scene: "2 a.m.",
    title: "2 a.m., can't sleep. The tab that's still open is…",
    options: [
      opt("q8a", "A forty-tab research spiral about a person I met once.", { overload: 3 }),
      opt("q8b", "A comment section I have no intention of joining.", {
        observer: 3,
        sarcastic: 1,
      }),
      opt("q8c", "A notes app draft that would end careers.", { sarcastic: 3 }),
      opt("q8d", "A playlist and a plan for tomorrow that will not survive.", { mainchar: 3 }),
    ],
  },
];

/* ============================================================================
   打分引擎（真跑，不是画出来的）
   ========================================================================== */

export type EnumResult = {
  /** 枚举到的答案组合总数 */
  total: number;
  hits: Record<ArchId, number>;
  hitPct: Record<ArchId, number>;
  ties: number;
  tiePct: number;
  /** 每列权重之和（矩阵底部那行「列合计」） */
  columnTotals: Record<ArchId, number>;
  /** 最高与最低命中占比之差，单位百分点 */
  spread: number;
  /** 一个原型都加不到的选项 = 废选项 */
  deadOptions: Array<{ questionId: string; optionId: string; label: string }>;
  /** 每题至少喂养了几个原型（< 2 说明这题的区分度不足） */
  thinQuestions: Array<{ questionId: string; label: string; fed: number }>;
};

const ARCH_IDS = ARCHETYPES.map((a) => a.id);

function zeroRecord(): Record<ArchId, number> {
  return ARCH_IDS.reduce((acc, id) => ({ ...acc, [id]: 0 }), {} as Record<ArchId, number>);
}

/**
 * 全枚举：8 题 × 4 选项 = 65,536 种组合，每次重算不到 10ms。
 *
 * 仲裁规则与真引擎一致（写进 docs 的那三条）：
 *   ① 总分最高者胜；② 平局按 ARCHETYPES 的声明顺序取靠前的一个（确定性），
 *   但**记一次 tie** —— 平局率过高说明题目区分度不够，是真问题。
 */
export function enumerate(questions: QuizQuestion[]): EnumResult {
  const hits = zeroRecord();
  const columnTotals = zeroRecord();
  const deadOptions: EnumResult["deadOptions"] = [];
  const thinQuestions: EnumResult["thinQuestions"] = [];

  questions.forEach((q, qi) => {
    const fed = new Set<ArchId>();
    q.options.forEach((o) => {
      let any = false;
      ARCH_IDS.forEach((id) => {
        const w = o.w[id] || 0;
        columnTotals[id] += w;
        if (w > 0) {
          any = true;
          fed.add(id);
        }
      });
      if (!any) {
        deadOptions.push({
          questionId: q.id,
          optionId: o.id,
          label: `Q${qi + 1} 选项 ${o.id.slice(-1).toUpperCase()}`,
        });
      }
    });
    if (fed.size < 2) {
      thinQuestions.push({ questionId: q.id, label: q.scene, fed: fed.size });
    }
  });

  let total = 0;
  let ties = 0;
  const scores = zeroRecord();

  const walk = (qi: number) => {
    if (qi === questions.length) {
      total += 1;
      let best = -Infinity;
      let winners: ArchId[] = [];
      ARCH_IDS.forEach((id) => {
        const s = scores[id];
        if (s > best) {
          best = s;
          winners = [id];
        } else if (s === best) {
          winners.push(id);
        }
      });
      if (winners.length > 1) ties += 1;
      hits[winners[0]] += 1;
      return;
    }
    const q = questions[qi];
    q.options.forEach((o) => {
      ARCH_IDS.forEach((id) => {
        scores[id] += o.w[id] || 0;
      });
      walk(qi + 1);
      ARCH_IDS.forEach((id) => {
        scores[id] -= o.w[id] || 0;
      });
    });
  };

  if (questions.length) walk(0);

  const hitPct = zeroRecord();
  ARCH_IDS.forEach((id) => {
    hitPct[id] = total ? (hits[id] / total) * 100 : 0;
  });
  const values = ARCH_IDS.map((id) => hitPct[id]);

  return {
    total,
    hits,
    hitPct,
    ties,
    tiePct: total ? (ties / total) * 100 : 0,
    columnTotals,
    spread: values.length ? Math.max(...values) - Math.min(...values) : 0,
    deadOptions,
    thinQuestions,
  };
}

/* ============================================================================
   发布前检查（屏 3 的 12 条，全部由数据推出）
   ========================================================================== */

export type CheckState = "ok" | "warn" | "fail";

export type Check = {
  id: string;
  state: CheckState;
  label: string;
  detail?: string;
  /** 触发时扣的分数 */
  penalty: number;
};

export function healthChecks(
  questions: QuizQuestion[],
  archetypes: Archetype[],
  result: EnumResult
): Check[] {
  const checks: Check[] = [];
  const minHit = Math.min(...archetypes.map((a) => result.hitPct[a.id]));
  const reachable = archetypes.every((a) => result.hitPct[a.id] > 0);
  const colValues = archetypes.map((a) => result.columnTotals[a.id]);
  const totalWeight = colValues.reduce((a, b) => a + b, 0);
  const colSpread = Math.max(...colValues) - Math.min(...colValues);
  const balanced = colSpread <= Math.max(4, totalWeight * 0.15);
  const longestName = archetypes.reduce(
    (max, a) => (a.name.length > max.name.length ? a : max),
    archetypes[0]
  );

  checks.push({
    id: "reachable",
    state: reachable ? "ok" : "fail",
    label: reachable
      ? `${result.total.toLocaleString()} 种答案组合，${archetypes.length} 个原型全部可达`
      : "有原型一种组合都抽不到（死区）",
    detail: reachable
      ? undefined
      : archetypes.filter((a) => result.hitPct[a.id] === 0).map((a) => a.name).join("、"),
    penalty: 40,
  });

  checks.push({
    id: "minhit",
    state: minHit >= 12 ? "ok" : "warn",
    label: `最低命中率 ${minHit.toFixed(1)}%（下限 12%）`,
    detail: minHit >= 12 ? undefined : "某个原型过于难抽，用户会觉得答案总是那几个",
    penalty: 8,
  });

  checks.push({
    id: "tie",
    state: result.tiePct <= 12 ? "ok" : "warn",
    label: `平局率 ${result.tiePct.toFixed(1)}%（上限 12%）`,
    detail: result.tiePct <= 12 ? undefined : "题目区分度不够，相邻两档会互相稀释",
    penalty: 10,
  });

  checks.push({
    id: "balance",
    state: balanced ? "ok" : "warn",
    label: `权重均衡度：列合计极差 ${colSpread}（总和 ${totalWeight}）`,
    detail: balanced ? undefined : "某列明显偏轻，实际作答时会整片落进另一档",
    penalty: 6,
  });

  if (result.deadOptions.length) {
    checks.push({
      id: "deadopt",
      state: "warn",
      label: `${result.deadOptions.length} 个选项不给任何原型加分`,
      detail: result.deadOptions.map((d) => `${d.label}`).join("、"),
      penalty: 4 * result.deadOptions.length,
    });
  } else {
    checks.push({
      id: "deadopt",
      state: "ok",
      label: "无废选项：每个选项至少喂养 1 个原型",
      penalty: 4,
    });
  }

  checks.push({
    id: "thin",
    state: result.thinQuestions.length === 0 ? "ok" : "warn",
    label:
      result.thinQuestions.length === 0
        ? "每题至少喂养 2 个原型（区分度够）"
        : `${result.thinQuestions.length} 道题只喂养 1 个原型`,
    detail: result.thinQuestions.length
      ? result.thinQuestions.map((t) => `${t.label}（${t.fed} 个）`).join("、")
      : undefined,
    penalty: 6,
  });

  checks.push({
    id: "name",
    state: longestName.name.length <= 40 ? "ok" : "warn",
    label:
      longestName.name.length <= 40
        ? `最长结果名 ${longestName.name.length} 字，360px 下 3 行内`
        : `「${longestName.name.slice(0, 26)}…」${longestName.name.length} 字，360px 下要 4 行`,
    detail:
      longestName.name.length <= 40
        ? undefined
        : "海报 / 票根会截断名字（上一版丢过半个括号），建议压到 40 字内",
    penalty: 5,
  });

  checks.push({
    id: "shape",
    state:
      questions.length >= 6 &&
      questions.length <= 10 &&
      questions.every((q) => q.options.length === 4)
        ? "ok"
        : "warn",
    label: `${questions.length} 题 × 4 选项（建议范围 6–10 题）`,
    detail:
      questions.length >= 6 && questions.length <= 10
        ? undefined
        : "题量过少会让 4 个原型互相抢票，过多则完成率掉到 40% 以下",
    penalty: 5,
  });

  // 下面四条在静态稿里没有真实数据源，状态固定为通过；接真数据时再算。
  checks.push({ id: "stats", state: "ok", label: "4 个原型都有 headline / quote / 3 条 stats", penalty: 4 });
  checks.push({ id: "pills", state: "ok", label: "pill tags ≤ 4 个、每个 ≤ 18 字", penalty: 3 });
  checks.push({ id: "poster", state: "ok", label: "海报导出 1080×1350，齿孔与圆戳完整", penalty: 5 });
  checks.push({ id: "jsonld", state: "ok", label: "Quiz JSON-LD 通过 Rich Results 校验", penalty: 3 });

  return checks;
}

export function healthScore(checks: Check[]): number {
  const score = checks.reduce((acc, c) => {
    if (c.state === "fail" || c.state === "warn") return acc - c.penalty;
    return acc;
  }, 100);
  return Math.max(0, Math.min(100, score));
}

/* ============================================================================
   其余各屏的假数据
   ========================================================================== */

export const SCREENS = [
  { id: "list", label: "01 测验列表", sub: "Admin · /admin/quizzes" },
  { id: "matrix", label: "02 权重矩阵", sub: "Admin · 编辑器 Logic" },
  { id: "checks", label: "03 发布前检查", sub: "Admin · 编辑器右栏" },
  { id: "taxonomy", label: "04 分类矩阵", sub: "Admin · /admin/taxonomy" },
  { id: "autopilot", label: "05 自动出题", sub: "Admin · /admin/autopilot" },
  { id: "front", label: "06 前台列表", sub: "Site · /quizzes" },
] as const;

export type ScreenId = (typeof SCREENS)[number]["id"];

export type QuizRow = {
  id: string;
  title: string;
  topic: string;
  format: string;
  health: number;
  q: number;
  r: number;
  views: string;
  share: string;
  status: "published" | "draft" | "scheduled";
  note?: string;
  source?: "manual" | "autopilot";
  cover: string;
};

export const QUIZ_ROWS: QuizRow[] = [
  {
    id: "q-sheep",
    title: "Are You a Corporate Sheep?",
    topic: "Career",
    format: "Personality",
    health: 100,
    q: 8,
    r: 4,
    views: "12.4k",
    share: "19%",
    status: "published",
    cover: "from-[#0E2A3A] to-[#1f4a63]",
  },
  {
    id: "q-kpop",
    title: "K-Pop Bias Archetype",
    topic: "Pop Culture",
    format: "Which X",
    health: 97,
    q: 8,
    r: 4,
    views: "11.8k",
    share: "23%",
    status: "published",
    cover: "from-[#FF6B3D] to-[#ffb199]",
  },
  {
    id: "q-sports",
    title: "What's Your Actual 2026 Cyber Sports Persona",
    topic: "Sports",
    format: "Personality",
    health: 62,
    q: 8,
    r: 4,
    views: "8.1k",
    share: "11%",
    status: "published",
    note: "结果区间覆盖不到满分（可达 24，最高档只到 20）",
    cover: "from-[#0E3B2E] to-[#1c5c46]",
  },
  {
    id: "q-social",
    title: "Social Defense Archetype",
    topic: "Social",
    format: "Personality",
    health: 96,
    q: 8,
    r: 4,
    views: "3.2k",
    share: "21%",
    status: "draft",
    source: "autopilot",
    cover: "from-[#CDBBFF] to-[#9f86e0]",
  },
  {
    id: "q-y2k",
    title: "Which Y2K Aesthetic Are You?",
    topic: "Lifestyle",
    format: "Which X",
    health: 88,
    q: 7,
    r: 4,
    views: "21.7k",
    share: "24%",
    status: "published",
    cover: "from-[#FF6B3D] to-[#ffa07a]",
  },
  {
    id: "q-delulu",
    title: "The Delulu Scale",
    topic: "Social",
    format: "How X",
    health: 79,
    q: 6,
    r: 4,
    views: "6.6k",
    share: "17%",
    status: "published",
    note: "平局率 14%，超过 12% 上限",
    cover: "from-[#F5C84C] to-[#f7dc8f]",
  },
  {
    id: "q-okay",
    title: "Are You Actually Okay?",
    topic: "Personality",
    format: "Trivia",
    health: 94,
    q: 10,
    r: 5,
    views: "0",
    share: "—",
    status: "scheduled",
    cover: "from-[#0B0A12] to-[#2b2740]",
  },
];

export type Topic = {
  id: string;
  label: string;
  zh: string;
  slug: string;
  color: string;
  count: number;
  blurb: string;
};

export const TOPICS: Topic[] = [
  {
    id: "personality",
    label: "Personality & Psychology",
    zh: "性格与心理",
    slug: "/quizzes/topic/personality",
    color: "#F5C84C",
    count: 8,
    blurb: "Archetypes, attachment styles, and the parts of you that answer before you do.",
  },
  {
    id: "pop-culture",
    label: "Pop Culture & Entertainment",
    zh: "流行文化与娱乐",
    slug: "/quizzes/topic/pop-culture",
    color: "#FF6B3D",
    count: 6,
    blurb: "K-Pop, anime, film, and the internet's current obsession.",
  },
  {
    id: "love",
    label: "Love & Relationships",
    zh: "情感与社交",
    slug: "/quizzes/topic/love",
    color: "#CDBBFF",
    count: 3,
    blurb: "Green flags, red flags, and the group chat you call a support system.",
  },
  {
    id: "career",
    label: "Career & Workstyle",
    zh: "职场与工作",
    slug: "/quizzes/topic/career",
    color: "#0E2A3A",
    count: 3,
    blurb: "What your Sunday night dread is trying to tell you.",
  },
  {
    id: "lifestyle",
    label: "Lifestyle & Aesthetics",
    zh: "生活方式与美学",
    slug: "/quizzes/topic/lifestyle",
    color: "#E8E0D0",
    count: 1,
    blurb: "Cottagecore, Y2K, or one clean line of minimalism.",
  },
  {
    id: "trivia",
    label: "Trivia & Knowledge",
    zh: "知识问答",
    slug: "/quizzes/topic/trivia",
    color: "#0B0A12",
    count: 1,
    blurb: "For the people who answer before reading the options.",
  },
];

export const SIGNALS = [
  { id: "k-pop", label: "K-Pop", count: 7 },
  { id: "anime", label: "Anime & Manga", count: 5 },
  { id: "gaming", label: "Gaming", count: 4 },
  { id: "mbti", label: "MBTI / Archetypes", count: 4 },
  { id: "attachment", label: "Attachment Style", count: 3 },
  { id: "booktok", label: "BookTok", count: 2 },
  { id: "flags", label: "Green / Red Flags", count: 2 },
  { id: "internet-lore", label: "Internet Lore", count: 1 },
];

export const FORMATS = [
  { id: "personality", label: "🧠 Personality", count: 14, note: "没有对错，只算倾向" },
  { id: "which", label: "🎭 Which X", count: 5, note: "角色 / 原型匹配" },
  { id: "trivia", label: "🎯 Trivia", count: 2, note: "有标准答案" },
  { id: "picture", label: "🖼 Picture", count: 1, note: "看图凭直觉选" },
];

export const AESTHETICS = [
  { id: "y2k", label: "Y2K", count: 3 },
  { id: "cyberpunk", label: "Cyberpunk", count: 2 },
  { id: "dark-academia", label: "Dark Academia", count: 1 },
  { id: "cottagecore", label: "Cottagecore", count: 1 },
];

export type Candidate = {
  id: string;
  source: "reddit" | "youtube" | "wikipedia" | "gtrends";
  where: string;
  delta: string;
  volume: string;
  quote: string;
  cross: number;
  state: "open" | "queued" | "ignored";
};

export const CANDIDATES: Candidate[] = [
  {
    id: "c1",
    source: "reddit",
    where: "r/popculturechat",
    delta: "↑312%",
    volume: "1.2k",
    quote: "the album rollout is genuinely unhinged and I'm sat",
    cross: 3,
    state: "queued",
  },
  {
    id: "c2",
    source: "youtube",
    where: "US #2 · Music",
    delta: "2.1M plays",
    volume: "24h",
    quote: "Official video · most popular US",
    cross: 2,
    state: "open",
  },
  {
    id: "c3",
    source: "wikipedia",
    where: "pageviews ↑640%",
    delta: "brat summer",
    volume: "88k",
    quote: "Rising article traffic, en.wikipedia",
    cross: 2,
    state: "open",
  },
  {
    id: "c4",
    source: "gtrends",
    where: "US #14",
    delta: "brat autumn",
    volume: "breakout",
    quote: "Trending searches · geo=US",
    cross: 1,
    state: "open",
  },
];

export type GenItem = {
  id: string;
  title: string;
  recipe: string;
  spec: string;
  health: number;
  issue?: string;
  state: "review" | "published" | "regenerating" | "dropped";
};

export const GEN_QUEUE: GenItem[] = [
  {
    id: "g1",
    title: "Which Album Rollout Are You?",
    recipe: "审美人格 · Aesthetic persona",
    spec: "8 Q / 4 R · en",
    health: 96,
    state: "review",
  },
  {
    id: "g2",
    title: "How Delulu Are You, Really?",
    recipe: "程度百分比 · How X",
    spec: "6 Q / 4 R · en",
    health: 62,
    issue: "Q4 的权重全 0 → 有死区风险",
    state: "review",
  },
  {
    id: "g3",
    title: "Which Brat Era Are You?",
    recipe: "角色匹配 · Which X",
    spec: "8 Q / 4 R · en",
    health: 91,
    state: "review",
  },
];

export type FeedCard = {
  id: string;
  title: string;
  topic: string;
  badge: { label: string; tone: string } | null;
  meta: string;
  cover: string;
};

export const FEED: FeedCard[] = [
  {
    id: "f1",
    title: "K-Pop Bias Archetype",
    topic: "Pop Culture",
    badge: { label: "✨ NEW", tone: "bg-[#F5C84C] text-[#0B0A12]" },
    meta: "8 Q · 3 min",
    cover: "from-[#FF6B3D] to-[#ffb199]",
  },
  {
    id: "f2",
    title: "Social Defense Archetype",
    topic: "Personality",
    badge: { label: "🔥 TRENDING", tone: "bg-[#FF6B3D] text-white" },
    meta: "8 Q · 4 min",
    cover: "from-[#CDBBFF] to-[#8f78d6]",
  },
  {
    id: "f3",
    title: "Are You a Corporate Sheep?",
    topic: "Career",
    badge: { label: "👑 EDITOR'S PICK", tone: "bg-[#0B0A12] text-[#F5C84C]" },
    meta: "8 Q · 3 min",
    cover: "from-[#0E2A3A] to-[#2c5a78]",
  },
  {
    id: "f4",
    title: "Which Y2K Aesthetic Are You?",
    topic: "Lifestyle",
    badge: { label: "⚡ 2 MIN", tone: "bg-white text-[#0B0A12]" },
    meta: "6 Q · 2 min",
    cover: "from-[#9AE6C8] to-[#4ec9a0]",
  },
  {
    id: "f5",
    title: "The Delulu Scale",
    topic: "Love",
    badge: null,
    meta: "6 Q · 2 min",
    cover: "from-[#F5C84C] to-[#ff9f1c]",
  },
  {
    id: "f6",
    title: "Are You Actually Okay?",
    topic: "Personality",
    badge: null,
    meta: "10 Q · 5 min",
    cover: "from-[#0B0A12] to-[#3a3358]",
  },
];

export const FEED_FILTERS = [
  "All",
  "Personality",
  "Pop Culture",
  "Love",
  "Career",
  "Lifestyle",
  "Trivia",
];
