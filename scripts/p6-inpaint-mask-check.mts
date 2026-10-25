#!/usr/bin/env node
/**
 * P6 inpainting mask 编码自检（纯函数，不花模型额度）。
 *
 * Cloudflare 的 inpainting 参数写着 `mask: number[]`，实际要的是 **PNG 文件字节**。
 * 这个脚本钉住 lib/inpaintMask.ts 的三条约定：
 *   1. canvas 的 RGBA / RGB 像素会被压成单通道灰度图，白色区域才是要重画的地方；
 *   2. 已经是 PNG 的输入原样透传，不重复编码；
 *   3. 尺寸读得出来、坏输入会返回 null（路由据此回 400，而不是让模型报看不懂的错）。
 *
 * 用法：node --import ./scripts/_ts-resolve.mts scripts/p6-inpaint-mask-check.mts
 */
import zlib from 'node:zlib'
import { encodeGrayscalePng, pngDimensions, toMaskPng } from '../lib/inpaintMask.ts'

let failed = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` —— ${extra}` : ''}`)
  if (!cond) failed += 1
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** 按 PNG 分块格式读出所有 chunk；只用来解自己刚编码出来的文件 */
const readPng = (buf: Buffer) => {
  const chunks: Array<{ type: string; data: Buffer }> = []
  let at = 8
  while (at + 12 <= buf.length) {
    const len = buf.readUInt32BE(at)
    const type = buf.toString('ascii', at + 4, at + 8)
    chunks.push({ type, data: buf.subarray(at + 8, at + 8 + len) })
    at += 12 + len
  }
  return chunks
}

/** filter 固定为 0，所以第一行字节就是像素本身 */
const grayPixels = (png: Buffer, width: number, height: number) => {
  const idat = readPng(png).filter((c) => c.type === 'IDAT').map((c) => c.data)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width + 1
  const out = Buffer.alloc(width * height)
  for (let y = 0; y < height; y++) raw.copy(out, y * width, y * stride + 1, (y + 1) * stride)
  return out
}

const W = 64
const H = 48

/* 1. canvas RGBA：白色方块（含 alpha）要落成 255 */
const rgba = Buffer.alloc(W * H * 4)
for (let y = 10; y < 40; y++) {
  for (let x = 20; x < 50; x++) {
    const at = (y * W + x) * 4
    rgba[at] = 255
    rgba[at + 1] = 255
    rgba[at + 2] = 255
    rgba[at + 3] = 255
  }
}
const fromRgba = toMaskPng(rgba, W, H)
check('1a RGBA 输入编码成 PNG', Boolean(fromRgba) && Buffer.from(fromRgba!).subarray(0, 8).equals(PNG_SIGNATURE))
const rgbaPng = Buffer.from(fromRgba!)
const rgbaDims = pngDimensions(rgbaPng)
check('1b 编码后宽高不变', rgbaDims?.width === W && rgbaDims?.height === H, JSON.stringify(rgbaDims))
check('1c 编码成 8 位灰度图（color type 0）', rgbaPng[24] === 8 && rgbaPng[25] === 0)
const rgbaGray = grayPixels(rgbaPng, W, H)
check('1d 方块内是白色', rgbaGray[20 * W + 30] === 255, String(rgbaGray[20 * W + 30]))
check('1e 方块外是黑色', rgbaGray[0] === 0, String(rgbaGray[0]))

/* 2. 单通道输入：不用再算通道，直接压成 PNG */
const single = Buffer.alloc(W * H)
single[5 * W + 5] = 255
const fromSingle = toMaskPng(single, W, H)
const singleGray = fromSingle ? grayPixels(Buffer.from(fromSingle), W, H) : null
check('2a 单通道输入可用', Boolean(singleGray))
check('2b 单通道像素原样保留', singleGray?.[5 * W + 5] === 255 && singleGray?.[0] === 0)

/* 3. 透明画布上的白色蒙版：RGB 是 255、alpha 是 0，也要算白色 */
const transparentWhite = Buffer.alloc(W * H * 4)
transparentWhite[(3 * W + 3) * 4] = 255 // RGB=255，alpha 保持 0
const fromTransparent = toMaskPng(transparentWhite, W, H)
const transparentGray = fromTransparent ? grayPixels(Buffer.from(fromTransparent), W, H) : null
check('3a alpha=0 但 RGB=255 仍被认成白色', transparentGray?.[3 * W + 3] === 255)

/* 4. 已经是 PNG：原样透传，不二次编码 */
const fromPng = toMaskPng(fromRgba, W, H)
check('4a PNG 输入原样透传', Boolean(fromPng) && Buffer.from(fromPng!).equals(rgbaPng))

/* 4b. Uint8ClampedArray 经 JSON 序列化后会变成数字键对象 —— 真实 fetch 就是这个形状 */
const jsonPixels = JSON.parse(JSON.stringify(new Uint8ClampedArray(rgba)))
const fromJson = toMaskPng(jsonPixels, W, H)
const jsonGray = fromJson ? grayPixels(Buffer.from(fromJson), W, H) : null
check('4b JSON 化的 typed array 也能识别', jsonGray?.[20 * W + 30] === 255 && jsonGray?.[0] === 0)
const fromWrapped = toMaskPng({ data: jsonPixels }, W, H)
check('4c { data: ... } 包装也能识别', Boolean(fromWrapped))

/* 5. 坏输入 / 尺寸识别 */
const broken = Buffer.alloc(W * H * 2)
check('5a 两通道像素数组被拒绝', toMaskPng(broken, W, H) === null)
check('5f 非数字键对象被拒绝', toMaskPng({ foo: 'bar' }, W, H) === null)
check('5b 空输入被拒绝', toMaskPng([], W, H) === null)
check('5c 截断的文件读不出尺寸', pngDimensions(rgbaPng.subarray(0, 20)) === null)
check('5d 非 PNG 读不出尺寸', pngDimensions(Buffer.from('not a png at all')) === null)
check('5e encodeGrayscalePng 每行都有 filter 字节', (() => {
  const png = encodeGrayscalePng(Buffer.alloc(8 * 8), 8, 8)
  const raw = zlib.inflateSync(readPng(png).filter((c) => c.type === 'IDAT').map((c) => c.data)[0])
  return raw.length === (8 + 1) * 8 && raw[0] === 0 && raw[9] === 0
})())

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
