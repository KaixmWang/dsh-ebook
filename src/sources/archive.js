/**
 * Internet Archive 书源：公共领域全文与开放借阅书目。
 * 走官方 JSON 接口，无需凭证。
 */
import { request, getText } from '../http.js'

const SEARCH = 'https://archive.org/advancedsearch.php'
const META = 'https://archive.org/metadata'
const DOWNLOAD = 'https://archive.org/download'

/**
 * 搜索。
 * @param {string} query 关键词。
 * @param {object} [options] 选项。
 * @param {number} [options.limit] 条数。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @returns {Promise<Array<object>>}
 */
export async function search(query, options = {}) {
  const { limit = 20, signal } = options
  const params = new URLSearchParams()
  params.set('q', `${query} AND mediatype:texts`)
  for (const field of ['identifier', 'title', 'creator', 'language', 'year', 'downloads', 'format']) {
    params.append('fl[]', field)
  }
  params.set('rows', String(limit))
  params.set('page', '1')
  params.set('output', 'json')
  const text = await getText(`${SEARCH}?${params}`, { signal, retries: 2, timeout: 40000 })
  const data = JSON.parse(text)
  const docs = data?.response?.docs ?? []
  return docs.map(doc => ({
    title: String(doc.title ?? doc.identifier ?? ''),
    author: Array.isArray(doc.creator) ? doc.creator.join(', ') : String(doc.creator ?? ''),
    year: String(doc.year ?? ''),
    language: Array.isArray(doc.language) ? doc.language.join(',') : String(doc.language ?? ''),
    // 条目里可能同时有 EPUB 与 PDF，按实际格式标注，避免把 PDF 标成唯一可选项
    extension: pickExtension(doc.format),
    size: '',
    md5: String(doc.identifier ?? ''),
    source: 'archive',
    downloads: Number(doc.downloads ?? 0),
  }))
}

/**
 * 从 Internet Archive 的 format 字段里挑一个可读格式。
 * @param {string|string[]} formats 格式字段。
 * @returns {string}
 */
function pickExtension(formats) {
  const list = (Array.isArray(formats) ? formats : [formats])
    .filter(Boolean)
    .map(item => String(item).toLowerCase())
  if (list.some(item => item.includes('epub'))) return 'epub'
  if (list.some(item => item.includes('pdf'))) return 'pdf'
  return ''
}

/**
 * 取某条目的候选文件（优先 epub，其次 pdf）。
 * @param {string} identifier 条目 id。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<{url:string, filename:string, format:string}>}
 */
export async function resolveDownload(identifier, signal) {
  const text = await getText(`${META}/${encodeURIComponent(identifier)}`, { signal, retries: 2, timeout: 40000 })
  const data = JSON.parse(text)
  const files = Array.isArray(data?.files) ? data.files : []
  const ranked = ['EPUB', 'PDF', 'TEXT']
  for (const format of ranked) {
    const hit = files.find(file => String(file.format ?? '').toUpperCase() === format && file.name)
    if (hit) {
      return {
        url: `${DOWNLOAD}/${encodeURIComponent(identifier)}/${encodeURIComponent(hit.name)}`,
        filename: hit.name,
        format: format.toLowerCase(),
      }
    }
  }
  const anyText = files.find(file => /\.(epub|pdf)$/i.test(String(file.name ?? '')))
  if (anyText) {
    return {
      url: `${DOWNLOAD}/${encodeURIComponent(identifier)}/${encodeURIComponent(anyText.name)}`,
      filename: anyText.name,
      format: /\.epub$/i.test(anyText.name) ? 'epub' : 'pdf',
    }
  }
  throw new Error('该条目没有可下载的 epub/pdf 文件')
}

/**
 * 下载。
 * @param {string} identifier 条目 id。
 * @param {object} [options] 选项。
 * @param {number} [options.maxBytes] 体积上限。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @returns {Promise<{buffer:Buffer, url:string, format:string}>}
 */
export async function download(identifier, options = {}) {
  const { maxBytes = 300 * 1024 * 1024, signal } = options
  const target = await resolveDownload(identifier, signal)
  const response = await request(target.url, { signal, timeout: 180_000, retries: 1 })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${target.url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > maxBytes) throw new Error(`文件体积 ${buffer.length} 超过上限 ${maxBytes}`)
  return { buffer, url: target.url, format: target.format, filename: target.filename }
}
