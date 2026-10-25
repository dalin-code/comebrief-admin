/**
 * Cloudflare inpainting 的 mask 编码。
 *
 * 模型参数里写的是 `mask: number[]`，但它实际要的是 **PNG 文件字节**（不是裸像素）。
 * 直接传 canvas 的 RGBA 数组会让模型内部的 PIL 报 UnidentifiedImageError。
 * 这里统一收口：能识别 PNG 就透传，裸像素则压成单通道再编码成灰度 PNG。
 */
import zlib from 'zlib'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAX_MASK_BYTES = 2048 * 2048 * 4

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

const crc32 = (buf: Buffer) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const pngChunk = (type: string, data: Buffer) => {
  const typeBuf = Buffer.from(type, 'ascii')
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  typeBuf.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** 把 0–255 的单通道像素压成 PNG */
export const encodeGrayscalePng = (pixels: Buffer, width: number, height: number) => {
  const stride = width + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    // 每行第一个字节是 filter type（0 = None）
    pixels.copy(raw, y * stride + 1, y * width, (y + 1) * width)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type: grayscale
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const base64ToBuffer = (b64: string) => {
  const s = String(b64 || '').trim()
  if (!s) return Buffer.alloc(0)
  return Buffer.from(s.replace(/^data:[a-zA-Z0-9./+-]+;base64,/, ''), 'base64')
}

const bytesOf = (input: any, length: number): Buffer => {
  const len = Math.min(length, MAX_MASK_BYTES)
  const buf = Buffer.alloc(len)
  for (let i = 0; i < len; i++) {
    const n = Math.trunc(Number(input[i]))
    buf[i] = Number.isFinite(n) ? Math.max(0, Math.min(255, n)) : 0
  }
  return buf
}

const maskInputToBuffer = (input: unknown): Buffer | null => {
  const raw = input as any
  if (typeof raw === 'string') return raw.trim() ? base64ToBuffer(raw) : null
  if (Array.isArray(raw) || ArrayBuffer.isView(raw)) {
    return bytesOf(raw, Number((raw as any).length ?? (raw as any).byteLength) || 0)
  }

  // fetch(JSON.stringify(Uint8ClampedArray)) 会变成 {'0': 255, '1': 0, ...}：
  // 没有 length，只有数字键。前端图省事直接塞 imageData.data 时就是这个形状。
  const candidate = raw?.data ?? raw
  if (!candidate || typeof candidate !== 'object') return null
  if (Array.isArray(candidate) || ArrayBuffer.isView(candidate)) {
    return bytesOf(candidate, Number((candidate as any).length ?? (candidate as any).byteLength) || 0)
  }
  const keys = Object.keys(candidate)
  if (!keys.length || keys.some((k) => !/^\d+$/.test(k))) return null
  return bytesOf(candidate, keys.length)
}

/**
 * 同时接受：
 *   · PNG 字节（number[] / Uint8Array / base64 字符串）—— 直接透传
 *   · canvas 的原始像素（RGBA / RGB / 单通道）—— 按通道压成单通道后再编码成 PNG
 */
export const toMaskPng = (input: unknown, width: number, height: number): number[] | null => {
  const buf = maskInputToBuffer(input)
  if (!buf?.length) return null
  if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) return Array.from(buf)

  const pixels = width * height
  let gray: Buffer
  if (buf.length === pixels) {
    gray = buf
  } else {
    const channels = buf.length / pixels
    if (channels !== 3 && channels !== 4) return null
    gray = Buffer.alloc(pixels)
    for (let i = 0; i < pixels; i++) {
      const at = i * channels
      // 透明画布上的白色蒙版：RGB 可能是 0，alpha 才是 255，所以取通道最大值最稳。
      gray[i] = Math.max(buf[at], buf[at + 1], buf[at + 2], channels === 4 ? buf[at + 3] : 0)
    }
  }
  return Array.from(encodeGrayscalePng(gray, width, height))
}

/** PNG 的 IHDR 一定在最前面：读宽高，省得前端漏传时被默认成 512。 */
export const pngDimensions = (buf: Buffer): { width: number; height: number } | null => {
  if (buf.length < 24) return null
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (!width || !height) return null
  return { width, height }
}
