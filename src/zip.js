/**
 * 最小 ZIP 读写器：EPUB 解析与生成都靠它。
 * 只用 Node 内置 zlib，不引第三方依赖，避免插件包体积和原生编译问题。
 */
import { inflateRawSync, deflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

/**
 * 读 zip 中央目录，返回条目表。
 * @param {Buffer} buf zip 文件字节。
 * @returns {Array<{name:string, method:number, compressedSize:number, size:number, offset:number}>}
 */
function listEntries(buf) {
  // EOCD 在文件尾部，注释最长 65535，从后往前找
  let eocd = -1
  const start = Math.max(0, buf.length - 0xffff - 22)
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/epub：找不到中央目录结尾')
  const count = buf.readUInt16LE(eocd + 10)
  let ptr = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CEN_SIG) break
    const method = buf.readUInt16LE(ptr + 10)
    const compressedSize = buf.readUInt32LE(ptr + 20)
    const size = buf.readUInt32LE(ptr + 24)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const offset = buf.readUInt32LE(ptr + 42)
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen)
    entries.push({ name, method, compressedSize, size, offset })
    ptr += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/**
 * 解压单个条目。
 * @param {Buffer} buf zip 字节。
 * @param {{name:string, method:number, compressedSize:number, offset:number}} entry 条目。
 * @returns {Buffer}
 */
function readEntry(buf, entry) {
  const p = entry.offset
  if (buf.readUInt32LE(p) !== LOC_SIG) throw new Error(`zip 条目头损坏: ${entry.name}`)
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const dataStart = p + 30 + nameLen + extraLen
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) return inflateRawSync(raw)
  throw new Error(`不支持的 zip 压缩方法 ${entry.method}: ${entry.name}`)
}

/**
 * 把 zip 读成 Map<路径, Buffer>。
 * @param {Buffer} buf zip 字节。
 * @returns {Map<string, Buffer>}
 */
export function readZip(buf) {
  const out = new Map()
  for (const e of listEntries(buf)) {
    if (e.name.endsWith('/')) continue
    try { out.set(e.name, readEntry(buf, e)) } catch { /* 跳过损坏条目 */ }
  }
  return out
}

/**
 * 生成 zip。EPUB 要求 mimetype 作为第一个条目且不压缩。
 * @param {Array<{name:string, data:Buffer|string, store?:boolean}>} files 条目。
 * @returns {Buffer}
 */
export function writeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8')
    const crc = crc32(data)
    const store = f.store === true
    const payload = store ? data : deflateRawSync(data)
    const method = store ? 0 : 8

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOC_SIG, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)      // UTF-8 文件名
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)          // 时间
    local.writeUInt16LE(0, 12)          // 日期
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, payload)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(CEN_SIG, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE(0, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(payload.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    centrals.push(cen, nameBuf)

    offset += local.length + nameBuf.length + payload.length
  }
  const cenBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cenBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cenBuf, eocd])
}

let CRC_TABLE = null
/**
 * CRC32（zip 需要）。
 * @param {Buffer} buf 数据。
 * @returns {number}
 */
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[i] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}
