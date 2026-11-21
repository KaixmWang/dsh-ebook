/** 书源聚合：并发搜索、去重、按相关性排序。 */
import { join } from 'node:path'
import * as libgen from './libgen.js'
import * as archive from './archive.js'
import * as zlib from './zlib.js'

/**
 * 可用书源名。
 * @returns {string[]}
 */
export function sourceNames() {
  return ['libgen', 'archive', 'zlibrary']
}

/**
 * 候选格式的偏好分。
 * @param {string} ext 扩展名。
 * @returns {number}
 */
function formatScore(ext) {
  switch (String(ext).toLowerCase()) {
    case 'epub': return 40
    case 'azw3': return 25
    case 'mobi': return 15
    case 'txt': return 10
    case 'pdf': return 5
    default: return 0
  }
}

/**
 * 解析 "101 MB" / "920 kB" 这类体积描述为 MB。
 * @param {string} size 体积文本。
 * @returns {number} 兆字节；无法解析为 0。
 */
function sizeInMb(size) {
  const text = String(size ?? '').trim()
  const match = /([\d.]+)\s*([kmg]?)b/i.exec(text)
  if (!match) return 0
  const value = Number(match[1])
  if (!Number.isFinite(value)) return 0
  switch (match[2].toLowerCase()) {
    case 'k': return value / 1024
    case 'g': return value * 1024
    case 'm': return value
    default: return value / (1024 * 1024)
  }
}

/**
 * 体积惩罚：整本电子书正常在 20MB 以内，漫画/扫描合订本体积巨大且不便阅读。
 * @param {object} row 结果行。
 * @returns {number}
 */
function sizeScore(row) {
  const mb = sizeInMb(row.size)
  if (mb === 0) return 0
  if (mb <= 20) return 10
  if (mb <= 50) return 0
  if (mb <= 100) return -20
  return -40
}

/**
 * 中文查询时给中文结果加分。
 * @param {object} row 结果行。
 * @param {string} query 查询词。
 * @returns {number}
 */
function languageScore(row, query) {
  const zhQuery = /[\u4e00-\u9fa5]/.test(query)
  const language = String(row.language ?? '').toLowerCase()
  if (zhQuery && /chinese|zh|chi/.test(language)) return 20
  if (!zhQuery && /english|en|eng/.test(language)) return 15
  return 0
}

/**
 * 标题吻合度。
 * @param {object} row 结果行。
 * @param {string} query 查询词。
 * @returns {number}
 */
function titleScore(row, query) {
  const title = String(row.title ?? '').toLowerCase()
  const needle = String(query).toLowerCase().trim()
  if (!needle) return 0
  if (title === needle) return 60
  if (title.startsWith(needle)) return 35
  if (title.includes(needle)) return 25

  // 逐字重合度，缓解中英混排
  const chars = [...needle].filter(c => /[\u4e00-\u9fa5a-z0-9]/.test(c))
  if (chars.length === 0) return 0
  const hit = chars.filter(c => title.includes(c)).length
  const base = Math.round((hit / chars.length) * 20)

  // 长度惩罚：长标题常是「比《活着》更绝望」这类带货文案，
  // 关键词全命中却不是用户要的那本。短标题更可能是正主。
  const excess = Math.max(0, [...title].length - [...needle].length)
  return Math.max(0, base - Math.min(12, excess * 0.4))
}

/**
 * 派生作品降权：摘要、读书笔记、解析类常与原书同标题，
 * 用户要原书却拿到摘要时，往往读完才发现。
 * @param {object} row 结果行。
 * @returns {number}
 */
function derivativeScore(row) {
  const title = String(row.title ?? '').toLowerCase()
  return /summary of|study guide|book analysis|notes on|\bcompanion to\b|摘要|读书笔记|解读版|解析版/.test(title)
    ? -25
    : 0
}

/**
 * 聚合搜索。
 * @param {string} query 关键词。
 * @param {object} config 插件配置。
 * @param {object} [options] 选项。
 * @param {string[]} [options.sources] 指定书源。
 * @param {string} [options.format] 只保留格式。
 * @param {number} [options.limit] 返回条数。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @returns {Promise<{results:Array<object>, errors:Array<{source:string,message:string}>}>}
 */
export async function searchAll(query, config, options = {}) {
  const { sources = sourceNames(), format, limit = 15, signal, log = () => {} } = options
  // 缓存放插件数据目录，不要放书库根：`.cache` 会被当成一本书
  const cacheDir = options.cacheDir ?? config.cacheDir ?? join(config.libraryDir ?? '.', '.cache')
  const tasks = []
  const errors = []

  if (sources.includes('libgen')) {
    tasks.push(
      libgen.search(query, { limit: limit * 2, signal, cacheDir, log })
        .then(rows => rows.map(r => ({ ...r, source: 'libgen' })))
        .catch(error => { errors.push({ source: 'libgen', message: error.message }); return [] }),
    )
  }
  if (sources.includes('archive')) {
    tasks.push(
      archive.search(query, { limit, signal })
        .catch(error => { errors.push({ source: 'archive', message: error.message }); return [] }),
    )
  }
  // Z-Library 走 eAPI，必须先登录（cookie）；域名可留空用默认站点
  if (sources.includes('zlibrary') && config.zlib?.cookie) {
    tasks.push(
      zlib.search(query, {
        domain: config.zlib.domain,
        cookie: config.zlib.cookie,
        limit,
        signal,
      })
        .catch(error => { errors.push({ source: 'zlibrary', message: error.message }); return [] }),
    )
  }

  const settled = await Promise.all(tasks)
  let rows = settled.flat()

  // 去重：同一书源里「标题 + 体积 + 格式」相同的条目通常是同一文件的多份上传，
  // 只保留第一个，避免整页都是同一条结果的副本。
  const seen = new Set()
  rows = rows.filter(row => {
    const normalizedTitle = String(row.title ?? '')
      .toLowerCase()
      .replace(/[\s:：,，.。\-—_()（）【】\[\]]+/g, '')
      .slice(0, 30)
    const key = `${row.source}|${normalizedTitle}|${String(row.size ?? '')}|${String(row.extension ?? '').toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  if (format) rows = rows.filter(row => String(row.extension).toLowerCase() === format.toLowerCase())

  // 相关性闸门：LibGen 的全文匹配会带出同页的无关条目（搜「人类简史」混进医学论文）。
  // 中文查询要求标题至少命中一半字符，英文查询放宽到包含任一关键词。
  const minTitle = /[\u4e00-\u9fa5]/.test(query) ? 10 : 5
  const relevant = rows.filter(row => titleScore(row, query) >= minTitle)
  if (relevant.length > 0) rows = relevant

  rows.sort((a, b) => {
    const scoreA = formatScore(a.extension) + languageScore(a, query) + titleScore(a, query) + sizeScore(a) + derivativeScore(a)
    const scoreB = formatScore(b.extension) + languageScore(b, query) + titleScore(b, query) + sizeScore(b) + derivativeScore(b)
    return scoreB - scoreA
  })

  return { results: rows.slice(0, limit), errors }
}

/**
 * 按来源下载。
 * @param {object} row 搜索结果行。
 * @param {object} config 插件配置。
 * @param {object} [options] 选项。
 * @param {number} [options.maxBytes] 体积上限。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @param {(line:string)=>void} [options.log] 日志。
 * @returns {Promise<{buffer:Buffer, url:string, format:string}>}
 */
export async function downloadRow(row, config, options = {}) {
  const { maxBytes, signal, log = () => {} } = options
  const cacheDir = options.cacheDir ?? config.cacheDir ?? join(config.libraryDir ?? '.', '.cache')
  switch (row.source) {
    case 'libgen': {
      const { buffer, url, filename } = await libgen.download(row.md5, { maxBytes, signal, cacheDir, log })
      return { buffer, url, filename, format: String(row.extension || '').toLowerCase() }
    }
    case 'archive': {
      const { buffer, url, format, filename } = await archive.download(row.md5, { maxBytes, signal })
      return { buffer, url, filename, format }
    }
    case 'zlibrary': {
      // 下载前读一次配额：eAPI 会给出今日已用/上限，额度为 0 时给明确提示，
      // 免得用户以为书源坏了。查询失败不阻断下载，只在明确超额时才拦。
      const profile = await zlib.fetchProfile({
        host: config.zlib.domain,
        cookie: config.zlib.cookie,
        signal,
      })
      if (profile.ok && profile.remaining <= 0) {
        throw new Error(
          `Z-Library 今日额度已用完（${profile.downloadsToday}/${profile.downloadsLimit}）。`
          + '换用 LibGen 等无限制书源，或明天再试；也可以再添加一个账号分散额度。',
        )
      }
      const { buffer, url, filename } = await zlib.download(row.bookPath ?? row.md5, {
        domain: config.zlib.domain,
        cookie: config.zlib.cookie,
        signal,
        maxBytes,
      })
      return { buffer, url, filename, format: String(row.extension || '').toLowerCase() }
    }
    default:
      throw new Error(`未知书源 ${row.source}`)
  }
}
