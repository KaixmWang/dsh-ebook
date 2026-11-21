/**
 * LibGen 镜像池：动态发现 + 冷却 + 回退。
 *
 * 借鉴 libgen-mcp 的做法：镜像列表从 shadowlibraries 目录拉取（缓存 24 小时），
 * 失败分两类处理——瞬时故障只冷却一会儿，确定性故障直接从池里摘掉。
 * 单一镜像挂掉不该让整次取书失败。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getText, httpFetch } from '../http.js'

/** shadowlibraries 维护的权威镜像目录。 */
const DIRECTORY = 'https://shadowlibraries.github.io/DirectDownloads/libgen/'

/** 目录拉不到时的兜底列表（按实测速度排序，libgen.li 最稳）。 */
export const FALLBACK_MIRRORS = ['libgen.li', 'libgen.bz', 'libgen.la', 'libgen.vg', 'libgen.gl']

/** 瞬时故障冷却时长；够服务器缓过来，又不至于错过整轮取书。 */
const TRANSIENT_COOLDOWN_MS = 45_000

/** 镜像列表缓存有效期。 */
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 从目录页解析镜像域名。
 * @param {string} html 目录页 HTML。
 * @returns {string[]}
 */
function parseDirectory(html) {
  const hosts = new Set()
  for (const match of html.matchAll(/https?:\/\/((?:www\.)?libgen\.[a-z]{2,4})\b/gi)) {
    hosts.add(match[1].toLowerCase().replace(/^www\./, ''))
  }
  return [...hosts]
}

/**
 * 发现镜像列表：磁盘缓存 → 实时拉取 → 过期缓存 → 硬编码兜底。
 * @param {object} options 选项。
 * @param {string} options.cacheDir 缓存目录。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @param {(line:string)=>void} [options.log] 日志。
 * @returns {Promise<string[]>}
 */
export async function discoverMirrors(options) {
  const { cacheDir, signal, log = () => {} } = options
  const cachePath = join(cacheDir, 'libgen-mirrors.json')

  let cached = null
  if (existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
      if (Array.isArray(parsed?.hosts) && parsed.hosts.length > 0) cached = parsed
    } catch { /* 缓存损坏就当没有 */ }
  }
  if (cached && Date.now() - Number(cached.fetchedAt ?? 0) < DISCOVERY_TTL_MS) {
    return cached.hosts
  }

  try {
    const html = await getText(DIRECTORY, { signal, timeout: 15_000, retries: 1 })
    const hosts = parseDirectory(html)
    if (hosts.length > 0) {
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), hosts }, null, 2), 'utf8')
      log(`镜像目录已更新：${hosts.join(', ')}`)
      return hosts
    }
  } catch (error) {
    log(`镜像目录拉取失败（用${cached ? '过期缓存' : '兜底列表'}）：${error.message}`)
  }

  if (cached) return cached.hosts
  // 兜底列表不落缓存，下次仍会尝试重新发现
  return [...FALLBACK_MIRRORS]
}

/**
 * 镜像池：按健康度轮转，带冷却。
 */
export class MirrorPool {
  /**
   * @param {string[]} hosts 镜像域名。
   */
  constructor(hosts) {
    this.all = [...new Set(hosts)]
    this.cooling = new Map()
    this.removed = new Set()
    this.preferred = null
  }

  /**
   * 把某个镜像提到最前。搜索刚成功过的镜像，下载时优先复用。
   * @param {string} host 域名。
   */
  prefer(host) {
    if (this.all.includes(host)) this.preferred = host
  }

  /**
   * 当前可用镜像，按优先级排序。
   * @returns {string[]}
   */
  available() {
    const now = Date.now()
    const alive = this.all.filter(host => {
      if (this.removed.has(host)) return false
      const until = this.cooling.get(host)
      return !until || until <= now
    })
    const list = alive.length > 0
      ? alive
      // 全在冷却：退回未摘除的全部（有总比没有强）
      : (this.all.filter(host => !this.removed.has(host)).length > 0
        ? this.all.filter(host => !this.removed.has(host))
        : [...this.all])

    if (this.preferred && list.includes(this.preferred)) {
      return [this.preferred, ...list.filter(host => host !== this.preferred)]
    }
    return list
  }

  /**
   * 标记一次瞬时故障：冷却一段时间。
   * @param {string} host 域名。
   */
  markTransient(host) {
    this.cooling.set(host, Date.now() + TRANSIENT_COOLDOWN_MS)
  }

  /**
   * 标记一次确定性故障：本轮摘除。
   * @param {string} host 域名。
   */
  markPermanent(host) {
    this.removed.add(host)
    this.cooling.delete(host)
  }

  /**
   * 标记成功：清除冷却。
   * @param {string} host 域名。
   */
  markSuccess(host) {
    this.cooling.delete(host)
  }
}

/**
 * 按 HTTP 状态码判断故障类别。
 * @param {number} status HTTP 状态。
 * @returns {'transient'|'permanent'}
 */
export function classifyStatus(status) {
  // 429/5xx 是服务器临时状态；其余 4xx 是确定性拒绝
  return status === 429 || status >= 500 ? 'transient' : 'permanent'
}

/**
 * 并发探测各镜像延迟，返回由快到慢的顺序。
 * 镜像之间延迟差异很大（同一本书可能 10 秒 vs 60 秒），盲试第一个代价太高。
 * 探测失败的排在最后但仍保留，避免因为一次抖动就放弃。
 * @param {string[]} hosts 候选镜像。
 * @param {object} options 选项。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @param {number} [options.budgetMs] 单个探测的超时。
 * @returns {Promise<string[]>}
 */
export async function rankByLatency(hosts, options = {}) {
  const { signal, budgetMs = 4_000 } = options
  if (hosts.length <= 1) return hosts

  const probes = hosts.map(async host => {
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('探测超时')), budgetMs)
    const onAbort = () => controller.abort(signal?.reason)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await httpFetch(`https://${host}/`, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: controller.signal,
        redirect: 'follow',
      })
      // 读完整个响应避免连接悬空
      await response.arrayBuffer().catch(() => {})
      return { host, ms: Date.now() - started, ok: response.ok || response.status === 206 }
    } catch {
      return { host, ms: Number.POSITIVE_INFINITY, ok: false }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  })

  const results = await Promise.all(probes)
  return results
    .sort((a, b) => {
      // 可达的按延迟排；不可达的垫底
      if (a.ok !== b.ok) return a.ok ? -1 : 1
      return a.ms - b.ms
    })
    .map(item => item.host)
}
