/**
 * P4 表皮层（Surface）：同一个骨架，换一版就换人、换地点、换时间、换物件。
 *
 * 关键约束：这一层**完全确定性**——给定 seed + variantIndex，选出来的身份永远一样，
 * 所以「同 Seed 复现」靠的是存下来的 surface，而不是指望模型每次即兴发挥。
 * 模型只负责把这些人名/地点写进正文，不许自己另起名字。
 */
import {
  deriveSeeds,
  hashString,
  seededRandom,
  seededShuffle,
} from './storySelection'

export type SurfaceRole = {
  role: string
  name: string
  age: number
  occupation: string
  detail: string
}

export type StorySurface = {
  protagonistName: string
  antagonistName: string
  confidantName: string
  roles: SurfaceRole[]
  protagonistRole: string
  antagonistRole: string
  relationship: string
  city: string
  district: string
  place: string
  time: string
  season: string
  weather: string
  objects: string[]
  sensoryDetail: string
  backstoryHook: string
  fingerprint: string
}

/** 只依赖骨架里「角色功能」，不 import storyPlan，避免循环依赖 */
export type SurfaceSkeletonRef = {
  relationshipRoles?: string[]
  conflictType?: string
  endingImage?: string
}

/**
 * 表皮里「读者一眼会认成同一篇」的那几个字段。
 *
 * 批量生成时把它交给 /api/ai/story/plan，服务端会换掉撞车的人名/城市/地点/时间/物件。
 * 只带文本字段，不带 fingerprint —— 前端不需要知道指纹怎么算。
 */
export type SurfaceIdentity = {
  protagonistName: string
  antagonistName: string
  confidantName: string
  city: string
  place: string
  time: string
  objects: string[]
}

const identityText = (value: unknown) => String(value ?? '').trim().slice(0, 120)

/** 从一版表皮里抽出用于查重的身份字段 */
export function surfaceIdentity(input: {
  protagonistName?: unknown
  antagonistName?: unknown
  confidantName?: unknown
  city?: unknown
  place?: unknown
  time?: unknown
  objects?: unknown
}): SurfaceIdentity {
  return {
    protagonistName: identityText(input.protagonistName),
    antagonistName: identityText(input.antagonistName),
    confidantName: identityText(input.confidantName),
    city: identityText(input.city),
    place: identityText(input.place),
    time: identityText(input.time),
    objects: Array.isArray(input.objects)
      ? input.objects.map(identityText).filter(Boolean).slice(0, 8)
      : [],
  }
}

/** API 收到的禁用身份可能是脏数据：只留下真正能用的字段，并且封顶 12 条 */
export function normalizeSurfaceIdentities(input: unknown, max = 12): SurfaceIdentity[] {
  if (!Array.isArray(input)) return []
  const out: SurfaceIdentity[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const item = surfaceIdentity(raw as any)
    if (
      !item.protagonistName &&
      !item.antagonistName &&
      !item.confidantName &&
      !item.city &&
      !item.place &&
      !item.time &&
      !item.objects.length
    )
      continue
    out.push(item)
    if (out.length >= max) break
  }
  return out
}

const objectName = (value: string) => String(value || '').replace(/（关键物件）/g, '').trim()

/** 这一版表皮是否和「同批已生成的」撞了人名 / 地点 / 时间 / 关键物件 */
export function surfaceConflicts(
  surface: {
    protagonistName?: string
    antagonistName?: string
    confidantName?: string
    city?: string
    place?: string
    time?: string
    objects?: string[]
  },
  forbidden: SurfaceIdentity[]
) {
  if (!forbidden.length) return false
  const names = new Set(
    [surface.protagonistName, surface.antagonistName, surface.confidantName]
      .map((x) => String(x || '').trim())
      .filter(Boolean)
  )
  const objects = new Set((surface.objects || []).map(objectName).filter(Boolean))
  return forbidden.some((f) => {
    if ([f.protagonistName, f.antagonistName, f.confidantName].some((x) => x && names.has(x))) return true
    if (f.city && surface.city && f.city === surface.city) return true
    if (f.place && surface.place && f.place === surface.place) return true
    if (f.time && surface.time && f.time === surface.time) return true
    return (f.objects || []).some((x) => objects.has(objectName(x)))
  })
}

const NAMES = [
  '诺亚·班尼特', '格蕾丝·奥康奈尔', '伊莱亚斯·沃德', '玛莎·林德',
  '欧文·卡特', '莉亚·莫兰', '塞缪尔·贝克', '艾达·惠特克',
  '卢卡斯·梅森', '克莱尔·道森', '亨利·福斯特', '诺拉·奎因',
  '丹尼尔·霍洛韦', '露丝·卡拉汉', '亚瑟·彭罗斯', '米拉·辛克莱',
  '托马斯·里德', '艾琳·巴克利', '乔纳·菲尔德', '海伦·斯通',
  '奥斯卡·雷恩', '薇拉·古德温', '菲利普·哈特', '朱恩·埃利斯',
]

const CITIES = [
  '波特兰', '布莱顿', '都柏林', '爱丁堡', '波士顿', '西雅图',
  '曼彻斯特', '哥本哈根', '阿姆斯特丹', '墨尔本', '温哥华', '格拉斯哥',
  '布里斯托', '汉堡', '里昂', '奥斯陆', '惠灵顿', '多伦多',
]

const DISTRICTS = [
  '老码头', '北区', '河湾', '东侧旧城', '火车站后面', '教堂街',
  '第七大道', '磨坊区', '海堤路', '大学城边缘', '南岸', '松林坡',
]

const PLACES = [
  '一间只有两张桌子的洗衣店', '深夜还亮着灯的加油站', '社区图书馆的地下室',
  '废弃的公交调度站', '一家关门半年的花店', '码头边上的仓库',
  '医院后面的员工通道', '旧火车站的天桥', '二十四小时自助洗衣房',
  '一间没有窗的录音棚', '郊区公路旁的汽车旅馆', '教堂对面的小餐馆',
  '一栋正在翻修的公寓楼', '河边的自行车修理铺', '市场尽头的冷库',
  '学校废弃的体育馆', '一家只收现金的当铺', '海边最后一排房子',
]

const OCCUPATIONS = [
  '夜班护士', '长途货车司机', '市政档案员', '面包房帮工', '保险调查员',
  '中学代课老师', '仓库盘点员', '电台剪辑师', '殡仪馆接待员', '电梯维修工',
  '社区律师', '旧书修复师', '游泳池救生员', '邮局分拣员', '花店临时工',
  '法院书记员', '兽医助理', '渡轮售票员',
]

const OBJECTS = [
  '一把齿口磨平的钥匙', '一只贴着两次胶带的纸箱', '一张没有寄出的明信片',
  '一枚停走的腕表', '半瓶标签被撕掉的药', '一件不属于主角的外套',
  '一张写错日期的收据', '一只装过咖啡的铁罐', '一把断了一根伞骨的伞',
  '一本被水泡过的通讯录', '一枚磨花的硬币', '一条太长的围巾',
  '一只只剩单边的耳环', '一张折了四次的火车票', '一盒过期的火柴',
  '一只没有配对的皮手套', '一个装着干土的玻璃瓶', '一张被反复擦写的便签',
]

const TIMES = [
  '清晨五点四十分', '午后两点', '傍晚六点一刻', '夜里十一点', '凌晨三点十七分',
  '超市关门前十分钟', '第一班公交发车前', '雨停后的半小时', '下班高峰刚过',
  '教堂钟响过三下之后',
]

const SEASONS = ['初春', '梅雨季', '盛夏', '初秋', '深秋', '第一场雪之后']
const WEATHERS = ['下着细雨', '起了薄雾', '风很大', '闷热无风', '刚下过雪', '天色一直没亮透']

const RELATIONSHIP_DETAILS = [
  '两人已经三年没有单独说过话', '一个人欠另一个人一个解释', '他们是彼此唯一还联系的旧识',
  '表面客气，实际上都在等对方先开口', '一个人手里握着另一个人的把柄',
  '他们曾经一起处理过一件谁都不愿再提的事',
]

const SENSORY_DETAILS = [
  '空气里有消毒水和冷掉的咖啡味', '地砖上有一层洗不掉的灰', '门外一直有水滴在铁皮上',
  '灯管每隔几秒闪一下', '墙上的钟走得比手机慢两分钟', '窗缝里灌进来的风带着土腥味',
  '柜台边缘被手肘磨得发亮', '远处有列车刹车的尖响',
]

const BACKSTORY_HOOKS = [
  '主角最近刚搬回来，旧邻居看他的眼神不太对', '主角在整理遗物时发现了一张不该存在的照片',
  '主角答应过一个人，再也不踏进这条街', '主角今天本来只是来取一件寄存的东西',
  '主角上周收到过一封没有署名的信', '主角已经连续三天在同一时间路过这里',
]

const pickAt = (list: string[], rng: () => number, offset: number) =>
  list[(Math.floor(rng() * list.length) + offset) % list.length]

const uniqueList = (list: string[], rng: () => number, count: number) =>
  seededShuffle(list, rng).slice(0, Math.min(count, list.length))

export function surfaceFingerprint(input: {
  protagonistName: string
  antagonistName: string
  confidantName: string
  city: string
  place: string
  time: string
  objects: string[]
}) {
  return hashString(
    [
      input.protagonistName,
      input.antagonistName,
      input.confidantName,
      input.city,
      input.place,
      input.time,
      ...input.objects,
    ].join('|')
  ).toString(36)
}

/**
 * 由 seed + variantIndex 生成一版表皮。
 * 同一组输入永远得到同一组输出；换 variantIndex 会换名字、城市、地点、时间、物件。
 */
export function surfaceFromSeed(input: {
  seed: string
  variantIndex: number
  skeleton?: SurfaceSkeletonRef | null
  /** 同批已经生成过的表皮；撞了的人名/城市/地点/时间/物件会被换掉 */
  forbiddenIdentities?: SurfaceIdentity[]
}): StorySurface {
  const { variantIndex } = input
  const seeds = deriveSeeds(input.seed, variantIndex)
  const rng = seededRandom(seeds.surfaceSeed)
  // 用 variant 做偏移，保证相邻变体不会因为随机流巧合选中同一组
  const offset = variantIndex * 3
  const forbidden = input.forbiddenIdentities || []
  const forbiddenNames = new Set(
    forbidden.flatMap((x) => [x.protagonistName, x.antagonistName, x.confidantName]).filter(Boolean)
  )
  const forbiddenCities = new Set(forbidden.map((x) => x.city).filter(Boolean))
  const forbiddenPlaces = new Set(forbidden.map((x) => x.place).filter(Boolean))
  const forbiddenTimes = new Set(forbidden.map((x) => x.time).filter(Boolean))
  const forbiddenObjects = new Set(forbidden.flatMap((x) => x.objects || []).map(objectName).filter(Boolean))

  const pickAvoiding = (list: string[], blocked: Set<string>, shift = 0) => {
    const pool = blocked.size ? list.filter((x) => !blocked.has(x)) : list
    return pickAt(pool.length ? pool : list, rng, offset + shift)
  }

  const names = uniqueList(
    forbiddenNames.size ? NAMES.filter((x) => !forbiddenNames.has(x)) : NAMES,
    rng,
    4
  )
  const rolesFromSkeleton = (input.skeleton?.relationshipRoles || [])
    .map((x) => String(x || '').trim())
    .filter(Boolean)
  const roleNames = rolesFromSkeleton.length
    ? rolesFromSkeleton.slice(0, 4)
    : ['主角', '对手', '关键关系人']

  const occupations = uniqueList(OCCUPATIONS, rng, Math.max(3, roleNames.length))
  const ages = [27, 31, 34, 38, 42, 46, 51]
  const roles: SurfaceRole[] = roleNames.map((role, i) => ({
    role,
    name: names[i % names.length],
    age: ages[(Math.floor(rng() * ages.length) + offset + i) % ages.length],
    occupation: occupations[i % occupations.length],
    detail: RELATIONSHIP_DETAILS[(i + offset) % RELATIONSHIP_DETAILS.length],
  }))

  const city = pickAvoiding(CITIES, forbiddenCities)
  const district = pickAt(DISTRICTS, rng, offset + 1)
  const place = pickAvoiding(PLACES, forbiddenPlaces, 2)
  const time = pickAvoiding(TIMES, forbiddenTimes, 3)
  const season = pickAt(SEASONS, rng, offset + 4)
  const weather = pickAt(WEATHERS, rng, offset + 5)
  const objectPool = forbiddenObjects.size ? OBJECTS.filter((x) => !forbiddenObjects.has(x)) : OBJECTS
  const objects = uniqueList(objectPool.length >= 3 ? objectPool : OBJECTS, rng, 3).map(
    (obj, i) => `${obj}${i === 0 ? '（关键物件）' : ''}`
  )
  const sensoryDetail = pickAt(SENSORY_DETAILS, rng, offset + 6)
  const backstoryHook = pickAt(BACKSTORY_HOOKS, rng, offset + 7)

  const surface: StorySurface = {
    protagonistName: roles[0]?.name || names[0],
    antagonistName: roles[1]?.name || names[1],
    confidantName: roles[2]?.name || names[2],
    roles,
    protagonistRole: roles[0]?.role || '主角',
    antagonistRole: roles[1]?.role || '对手',
    relationship: input.skeleton?.conflictType || '两个人被同一件旧事拴在一起',
    city,
    district,
    place,
    time,
    season,
    weather,
    objects,
    sensoryDetail,
    backstoryHook,
    fingerprint: '',
  }
  surface.fingerprint = surfaceFingerprint(surface)
  return surface
}

/** API 收到的 surface 可能是旧数据 / 被截断的 JSON：不完整就按 seed 重新生成 */
export function isUsableSurface(input: unknown): input is StorySurface {
  const s = input as any
  return Boolean(
    s &&
      typeof s === 'object' &&
      String(s.protagonistName || '').trim() &&
      String(s.city || '').trim() &&
      String(s.place || '').trim() &&
      Array.isArray(s.objects) &&
      s.objects.length > 0 &&
      Array.isArray(s.roles)
  )
}

export function coerceSurface(input: unknown, fallback: { seed: string; variantIndex: number; skeleton?: SurfaceSkeletonRef | null }) {
  return isUsableSurface(input) ? input : surfaceFromSeed(fallback)
}

/** 骨架里一旦出现这些具体专名，就说明「同 Seed 换人物」不成立 */
export function findIdentityLeaks(text: string) {
  const s = String(text || '')
  const hits: string[] = []
  for (const name of NAMES) if (s.includes(name)) hits.push(name)
  for (const city of CITIES) if (s.includes(city)) hits.push(city)
  return Array.from(new Set(hits))
}

/** 粗略的情节相似度（二字组 Jaccard），用于同 Seed 不同变体 / 往期查重 */
export function premiseSimilarity(a: string, b: string) {
  const bigrams = (text: string) => {
    const s = String(text || '').replace(/[\s\p{P}]/gu, '')
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const x of A) if (B.has(x)) hit += 1
  return hit / (A.size + B.size - hit)
}

