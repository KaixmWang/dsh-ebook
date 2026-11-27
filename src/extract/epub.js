/** EPUB 解析：元数据 + 按阅读顺序抽取章节正文。 */
import { readZip } from '../zip.js'
import { normalizeText, stripTags } from '../http.js'

/**
 * 判断字节是否为 zip/epub。
 * @param {Buffer} buf 字节。
 * @returns {boolean}
 */
export function isEpub(buf) {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b
}

/**
 * 解出元数据与章节。
 * @param {Buffer} buf epub 字节。
 * @returns {{title:string, creator:string, language:string, chapters:Array<{href:string,title:string,text:string}>}}
 */
export function extractEpub(buf) {
  const files = readZip(buf)
  const container = files.get('META-INF/container.xml')?.toString('utf8') ?? ''
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1]
  const opf = opfPath ? files.get(opfPath)?.toString('utf8') ?? '' : ''
  const baseDir = opfPath && opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''

  const title = pick(opf, 'dc:title')
  const creator = pick(opf, 'dc:creator')
  const language = pick(opf, 'dc:language')
  // 简介：EPUB 里通常放在 dc:description，可能带简单 HTML
  const description = stripTags(pick(opf, 'dc:description')).replace(/\s+/g, ' ').trim()

  // manifest: id -> {href, mediaType}
  const manifest = new Map()
  for (const item of opf.matchAll(/<item\s[^>]*>/g)) {
    const tag = item[0]
    const id = /id="([^"]*)"/.exec(tag)?.[1]
    const href = /href="([^"]*)"/.exec(tag)?.[1]
    const type = /media-type="([^"]*)"/.exec(tag)?.[1]
    if (id && href) manifest.set(id, { href, type })
  }

  // spine 顺序即阅读顺序
  const order = []
  for (const ref of opf.matchAll(/<itemref\s[^>]*idref="([^"]*)"/g)) {
    const item = manifest.get(ref[1])
    if (item) order.push(item)
  }
  // 无 spine 时退回 manifest 顺序
  const docs = order.length > 0
    ? order
    : [...manifest.values()].filter(i => i.type === 'application/xhtml+xml')

  const chapters = []
  for (const item of docs) {
    if (item.type && !/xhtml|html/.test(item.type)) continue
    const path = baseDir + decodeURIComponent(item.href)
    const raw = files.get(path)
    if (!raw) continue
    const html = raw.toString('utf8')
    const text = normalizeText(htmlToText(html))
    if (text.length < 2) continue
    chapters.push({
      href: item.href,
      title: guessTitle(html, text),
      text,
    })
  }
  return { title, creator, language, description, chapters }
}

/**
 * 猜章节标题：优先 h 标签，其次 <title>，最后取正文首个短行。
 * @param {string} html XHTML 原文。
 * @param {string} text 已抽出的纯文本。
 * @returns {string}
 */
function guessTitle(html, text) {
  const heading = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(html)
  const fromHeading = heading ? stripTags(heading[1]).replace(/\s+/g, ' ').trim() : ''
  if (fromHeading) return fromHeading

  const fromTitleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''
  const cleanedTitleTag = stripTags(fromTitleTag).replace(/\s+/g, ' ').trim()

  const firstLine = text.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? ''
  if (firstLine && firstLine.length <= 40 && !/[。！？，、；：]$/.test(firstLine)) return firstLine

  if (cleanedTitleTag && cleanedTitleTag.length <= 40) return cleanedTitleTag
  return ''
}

/**
 * 从 EPUB 里取出封面图。
 *
 * 封面有三条常见线索，按可靠性依次尝试：
 *   1. OPF 的 `<meta name="cover" content="id">` 指向的 manifest 项
 *   2. manifest 里 `properties="cover-image"` 的项（EPUB3 标准写法）
 *   3. guide 的 `<reference type="cover">`
 *
 * @param {Buffer} buf epub 字节。
 * @returns {{data:Buffer, mediaType:string}|null} 封面字节与类型，找不到为 null。
 */
export function extractCover(buf) {
  let files
  try {
    files = readZip(buf)
  } catch {
    return null
  }

  const container = files.get('META-INF/container.xml')?.toString('utf8') ?? ''
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1]
  if (!opfPath) return null
  const opf = files.get(opfPath)?.toString('utf8') ?? ''
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''

  /** manifest: id -> {href, type, properties} */
  const items = new Map()
  for (const match of opf.matchAll(/<item\s[^>]*>/g)) {
    const tag = match[0]
    const id = /id="([^"]*)"/.exec(tag)?.[1]
    const href = /href="([^"]*)"/.exec(tag)?.[1]
    const type = /media-type="([^"]*)"/.exec(tag)?.[1] ?? ''
    const properties = /properties="([^"]*)"/.exec(tag)?.[1] ?? ''
    if (id && href && /^image\//.test(type)) items.set(id, { href, type, properties })
  }

  const candidates = []
  // 1. meta name="cover"
  const metaCoverId = /<meta[^>]*name="cover"[^>]*content="([^"]*)"/i.exec(opf)?.[1]
  if (metaCoverId && items.has(metaCoverId)) candidates.push(items.get(metaCoverId))
  // 2. properties="cover-image"
  for (const item of items.values()) {
    if (/\bcover-image\b/.test(item.properties)) candidates.push(item)
  }
  // 3. guide reference
  const guideHref = /<reference[^>]*type="cover"[^>]*href="([^"]*)"/i.exec(opf)?.[1]
  if (guideHref) {
    for (const item of items.values()) {
      if (item.href === guideHref) candidates.push(item)
    }
  }
  // 4. 文件名里带 cover 的图片兜底
  for (const item of items.values()) {
    if (/cover/i.test(item.href)) candidates.push(item)
  }

  for (const item of candidates) {
    const path = baseDir + decodeURIComponent(item.href)
    const data = files.get(path)
    if (data && data.length > 0) return { data, mediaType: item.type }
  }
  return null
}

/**
 * 从 OPF 取一个 dc 字段。
 * @param {string} opf OPF 文本。
 * @param {string} tag 标签名。
 * @returns {string}
 */
function pick(opf, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  return stripTags(re.exec(opf)?.[1] ?? '').trim()
}

/**
 * XHTML 转纯文本，保留段落换行。
 * @param {string} html XHTML。
 * @returns {string}
 */
function htmlToText(html) {
  return html
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCharCode(parseInt(c, 16)))
}
