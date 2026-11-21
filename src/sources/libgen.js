/**
 * LibGen 书源（libgen 家族镜像）。
 *
 * 取书层三层兜底：
 *   1. 镜像池轮询——单个镜像挂掉不影响取书；
 *   2. 每个镜像内做启动重试，每次重新解析直链（镜像发的一次性 key 会过期）；
 *   3. 传输用 stall guard 而不是全局超时，慢速大文件不会被误杀。
 * 下完按 MD5 校验，对不上就丢弃，避免把错误内容当书收下。
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { getText, stripTags } from '../http.js'
import { discoverMirrors, MirrorPool, classifyStatus, rankByLatency } from '../fetch/mirrors.js'
import { downloadFile, sweepPartial } from '../fetch/downloader.js'

/** 镜像池按缓存目录复用，避免每次搜索都重新发现。 */
const pools = new Map()

/**
 * 取得（或初始化）镜像池。
 * @param {object} options 选项。
 * @param {string} options.cacheDir 缓存目录。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @param {(line:string)=>void} [options.log] 日志。
 * @returns {Promise<MirrorPool>}
 */
async function getPool(options = {}) {
  // 显式指定镜像时跳过发现，便于测试与「我知道哪个镜像我这边通」的场景
  if (Array.isArray(options.hosts) && options.hosts.length > 0) {
    return new MirrorPool(options.hosts)
  }
  const cacheDir = options.cacheDir ?? join(tmpdir(), 'dsh-ebook-cache')
  const key = cacheDir
  if (!pools.has(key)) {
    // 发现失败不要把失败的 Promise 留在池里：否则之后每次取书都拿到同一个 rejection
    const pending = discoverMirrors({ cacheDir, signal: options.signal, log: options.log })
      .then(hosts => new MirrorPool(hosts))
      .catch(error => {
        pools.delete(key)
        throw error
      })
    pools.set(key, pending)
  }
  return pools.get(key)
}

/**
 * 解析搜索结果表格行。
 * @param {string} html 搜索页 HTML。
 * @returns {Array<object>}
 */
function parseRows(html) {
  const start = html.indexOf('id="tablelibgen"')
  if (start < 0) return []
  const body = html.slice(start)
  const rows = body.match(/<tr>[\s\S]*?<\/tr>/g) ?? []
  const out = []
  for (const row of rows) {
    const md5 = /ads\.php\?md5=([0-9a-f]{32})/i.exec(row)?.[1]
    if (!md5) continue
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => stripTags(m[1]).trim())
    const title = stripTags(/href="edition\.php\?id=\d+">([\s\S]*?)<\/a>/i.exec(row)?.[1] ?? '').trim()
    if (!title) continue
    // 镜像列表：结果行里有其他站的直链，作为该镜像不可用时的备用入口
    const mirrors = [...row.matchAll(/href="(https?:\/\/[^"]*\/(?:book|md5)\/[0-9a-f]{32}[^"]*)"/gi)]
      .map(m => m[1])
    out.push({
      title,
      author: cells[1] ?? '',
      year: cells[3] ?? '',
      language: cells[4] ?? '',
      pages: cells[5] ?? '',
      size: cells[6] ?? '',
      extension: (cells[7] ?? '').toLowerCase(),
      md5,
      mirrors,
      source: 'libgen',
    })
  }
  return out
}

/**
 * 搜索书籍。镜像池里逐个试，首个成功的即返回。
 * @param {string} query 关键词。
 * @param {object} [options] 选项。
 * @returns {Promise<Array<object>>}
 */
export async function search(query, options = {}) {
  const { limit = 20, format, signal, cacheDir, log = () => {}, hosts } = options
  const pool = await getPool({ cacheDir, signal, log, hosts })
  const errors = []

  for (const host of pool.available()) {
    const url = `https://${host}/index.php?req=${encodeURIComponent(query)}&res=${Math.min(100, Math.max(10, limit * 3))}`
    try {
      const html = await getText(url, { signal, retries: 0, timeout: 25_000 })
      const rows = parseRows(html)
      if (rows.length === 0 && !/tablelibgen/.test(html)) {
        // 页面结构不对，多半是镜像异常，换下一个
        throw new Error('返回页面结构异常')
      }
      pool.markSuccess(host)
      // 刚验证过这个镜像是活的，下载优先复用它，省掉一次盲试
      pool.prefer(host)
      let filtered = rows
      if (format) filtered = filtered.filter(r => r.extension === format.toLowerCase())
      return filtered.slice(0, limit)
    } catch (error) {
      const status = Number(/HTTP (\d+)/.exec(error.message)?.[1] ?? 0)
      if (status && classifyStatus(status) === 'permanent') pool.markPermanent(host)
      else pool.markTransient(host)
      errors.push(`${host}: ${error.message}`)
    }
  }
  throw new Error(`所有镜像都无法完成搜索：${errors.join(' | ')}`)
}

/**
 * 从指定镜像取真实下载地址。
 * @param {string} host 镜像域名。
 * @param {string} md5 文件 md5。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<string>}
 */
async function resolveOnMirror(host, md5, signal) {
  const ads = await getText(`https://${host}/ads.php?md5=${md5}`, { signal, retries: 0, timeout: 20_000 })
  const rel = /(get\.php\?md5=[0-9a-f]{32}&key=[A-Za-z0-9]+)/i.exec(ads)?.[1]
  if (!rel) {
    const hint = /返回的是网页|Just a moment|challenge-platform/i.test(ads) ? '（Cloudflare 挑战）' : ''
    throw new Error(`未给出下载链接${hint}`)
  }
  return `https://${host}/${rel}`
}

/**
 * 下载书籍字节。镜像池逐个尝试，任一成功即返回。
 * @param {string} md5 文件 md5。
 * @param {object} [options] 选项。
 * @returns {Promise<{buffer:Buffer, url:string, mirror:string, verified:boolean, resumed:boolean}>}
 */
export async function download(md5, options = {}) {
  const { maxBytes = 300 * 1024 * 1024, signal, cacheDir, log = () => {}, hosts } = options
  const pool = await getPool({ cacheDir, signal, log, hosts })
  const workDir = join(tmpdir(), 'dsh-ebook-downloads')
  mkdirSync(workDir, { recursive: true })
  const destPath = join(workDir, `${md5}-${randomUUID().slice(0, 8)}.bin`)

  const errors = []
  // 镜像之间速度差异很大，先并发探一遍再按延迟逐个试
  const ranked = await rankByLatency(pool.available(), { signal })
  log(`镜像延迟排序：${ranked.join(' → ')}`)
  for (const host of ranked) {
    if (signal?.aborted) throw signal.reason ?? new Error('已取消')
    try {
      log(`尝试镜像 ${host}`)
      let loggedMb = 0
      const result = await downloadFile({
        // 每个镜像固定自己的解析器：downloadFile 重试时会重新解析以刷新 key
        resolve: async () => ({ url: await resolveOnMirror(host, md5, signal) }),
        destPath,
        expectedMd5: md5,
        maxBytes,
        signal,
        log,
        onProgress: ({ received, total }) => {
          const mb = received / 1024 / 1024
          if (mb - loggedMb >= 1) {
            loggedMb = mb
            log(`  ${host} ${mb.toFixed(1)}${total > 0 ? `/${(total / 1024 / 1024).toFixed(1)}` : ''} MB`)
          }
        },
      })
      pool.markSuccess(host)
      const buffer = readFileSync(result.path)
      rmSync(result.path, { force: true })
      return {
        buffer,
        url: host,
        mirror: host,
        verified: result.verified,
        resumed: result.resumed,
        filename: result.filename,
      }
    } catch (error) {
      const status = Number(/HTTP (\d+)/.exec(error.message)?.[1] ?? 0)
      if (status && classifyStatus(status) === 'permanent') pool.markPermanent(host)
      else pool.markTransient(host)
      errors.push(`${host}: ${error.message}`)
      log(`镜像 ${host} 失败：${error.message}`)
    }
  }

  sweepPartial(destPath)
  throw new Error(`所有镜像都未能完成下载：${errors.join(' | ')}`)
}
