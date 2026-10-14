/**
 * 发布身份（编辑名 + 头像）—— 20 组，欧美名字、欧美画风的头像。
 *
 * 为什么要单独一个文件：
 *   以前趋势列表页（趋势调研生成）和趋势编辑页各写了一份身份表，改了一边另一边就忘了，
 *   同一个名字在两页里长得不一样。现在两处都 import 这一份。
 *
 * 头像为什么用 DiceBear 的 lorelei：
 *   - 手绘插画、半身像、成人向、低饱和配色 —— 是「一个有名字的编辑」，不是卡通小人或机器人；
 *   - 前台的文章署名处只有 24px 的圆形位（ComeBrief 的 briefs/[slug]），
 *     lorelei 的构图是头肩特写，缩到 24px 还看得清脸；notionists 那种半身拿道具的会糊成一团；
 *   - CC0 授权，商用无风险，且 URL 永远可用（后台只存链接，前台 <img> 直接读）。
 *
 * 想整体换画风：只改下面 AVATAR_STYLE 一行即可 ——
 *   notionists（手绘黑线、拿咖啡杯，最像"写字的人"）/ personas / micah / avataaars 都能直接用。
 */

export type EditorPersona = {
  /** 前台署名（写进 articles.author_name） */
  name: string
  /** 后台显示的一句话头衔；前台不读，但写稿的人该知道自己是谁 */
  role: string
  /** 头像链接（写进 articles.author_avatar） */
  avatar: string
}

/** 画风。换风格只改这里，20 组头像会一起换。 */
const AVATAR_STYLE = 'lorelei'
/** DiceBear 的版本号。7.x 是本项目一直在用的版本，稳定可用。 */
const AVATAR_VERSION = '7.x'

/**
 * 头像背景色板（DiceBear 要的是不带 # 的十六进制）。
 * 取的都是浅、灰调的颜色：衬手绘黑线好看，裁成圆形之后也不会有一圈扎眼的色块。
 */
const AVATAR_BACKGROUNDS: string[] = [
  'b6e3f4', 'ffd5dc', 'c0aede', 'ffe0a3', '9bd1d9',
  'f5b7a8', 'd8ead8', 'e3d5f4', 'ffd8b0', 'cfe4f7',
  'f7d9e3', 'd9e6c8', 'e8dcc8', 'cfe0dc', 'f3d9c8',
  'dcd9f3', 'e6f0d4', 'fbe4d5', 'd5e3f0', 'e9d8e8',
]

/** 一个身份的种子 → 头像链接。同名同色永远得到同一张脸（不会每次刷新都换人）。 */
const avatarFor = (seed: string, background: string) =>
  `https://api.dicebear.com/${AVATAR_VERSION}/${AVATAR_STYLE}/svg?seed=${encodeURIComponent(seed)}&backgroundColor=${background}`

/** 名册：名字用欧美常见姓名的组合，头衔用编辑部真实存在的岗位 */
const ROSTER: Array<{ name: string; role: string; seed: string }> = [
  { name: 'Olivia Bennett', role: 'Senior Editor', seed: 'OliviaBennett' },
  { name: 'Ethan Caldwell', role: 'Features Writer', seed: 'EthanCaldwell' },
  { name: 'Sophia Marlowe', role: 'Contributing Editor', seed: 'SophiaMarlowe' },
  { name: 'Liam Hartley', role: 'Staff Writer', seed: 'LiamHartley' },
  { name: 'Ava Sinclair', role: 'Columnist', seed: 'AvaSinclair' },
  { name: 'Noah Whitfield', role: 'Senior Correspondent', seed: 'NoahWhitfield' },
  { name: 'Isabella Rowe', role: 'Culture Editor', seed: 'IsabellaRowe' },
  { name: 'Mason Ellison', role: 'Investigative Reporter', seed: 'MasonEllison' },
  { name: 'Charlotte Vance', role: 'Essays Editor', seed: 'CharlotteVance' },
  { name: 'Henry Dalton', role: 'Long-form Writer', seed: 'HenryDalton' },
  { name: 'Amelia Frost', role: 'Books Editor', seed: 'AmeliaFrost' },
  { name: 'Owen Radcliffe', role: 'Technology Writer', seed: 'OwenRadcliffe' },
  { name: 'Harper Callahan', role: 'Associate Editor', seed: 'HarperCallahan' },
  { name: 'Lucas Grayson', role: 'Science Correspondent', seed: 'LucasGrayson' },
  { name: 'Evelyn Marsh', role: 'Deputy Editor', seed: 'EvelynMarsh' },
  { name: 'Jack Pembroke', role: 'Sports Columnist', seed: 'JackPembroke' },
  { name: 'Nora Ashford', role: 'Travel Writer', seed: 'NoraAshford' },
  { name: 'Samuel Barrett', role: 'Business Editor', seed: 'SamuelBarrett' },
  { name: 'Mia Delacroix', role: 'Style Writer', seed: 'MiaDelacroix' },
  { name: 'Leo Fitzgerald', role: 'Managing Editor', seed: 'LeoFitzgerald' },
]

export const EDITOR_PERSONAS: EditorPersona[] = ROSTER.map((p, i) => ({
  name: p.name,
  role: p.role,
  avatar: avatarFor(p.seed, AVATAR_BACKGROUNDS[i % AVATAR_BACKGROUNDS.length]),
}))

/** 后台没登录态时的兜底身份（也是新文章「发布身份」的初始值） */
export const DEFAULT_EDITOR_PERSONA: EditorPersona = EDITOR_PERSONAS[0]

/** 随机抽一个身份 —— 「骰子」按钮用。传 except 可以避免连抽两次抽到同一个人。 */
export function randomEditorPersona(except?: string): EditorPersona {
  const pool = except ? EDITOR_PERSONAS.filter((p) => p.name !== except) : EDITOR_PERSONAS
  const list = pool.length ? pool : EDITOR_PERSONAS
  return list[Math.floor(Math.random() * list.length)]
}

/** 按名字找身份（用来把库里存着的头衔显示出来；找不到返回 null） */
export function findEditorPersona(name?: string | null): EditorPersona | null {
  const key = String(name || '').trim().toLowerCase()
  if (!key) return null
  return EDITOR_PERSONAS.find((p) => p.name.toLowerCase() === key) || null
}
