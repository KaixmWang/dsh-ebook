/**
 * 检查更新：问 GitHub Releases 有没有比当前版本更新的版本。
 *
 * 只做「查询 + 提示」，不自动下载安装——插件装在 profile 里，升级该由用户
 * 用 pnpm / 插件管理完成。结果缓存在内存里（默认 6 小时），失败不打扰用户。
 */
import { readFileSync } from 'node:fs'
import { getText } from './http.js'

/** 仓库地址（Releases 页面对用户最有用）。 */
export const REPO = 'KaixmWang/dsh-ebook'

/** GitHub 最新 release 接口。 */
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`

/** 缓存有效期。 */
const DEFAULT_TTL = 6 * 60 * 60 * 1000

/**
 * 读插件自己的版本号。
 * @returns {string}
 */
export function currentVersion() {
  try {
    return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '')
  } catch {
    return ''
  }
}

/**
 * 把 `v0.6.0` / `0.6.0-beta.1` 解析成数字数组。
 * @param {string} value 版本字符串。
 * @returns {number[]}
 */
export function parseVersion(value) {
  const text = String(value ?? '').trim().replace(/^v/i, '')
  const core = text.split(/[-+]/)[0]
  const parts = core.split('.').map(part => Number.parseInt(part, 10))
  return parts.every(Number.isFinite) && parts.length > 0 ? parts : []
}

/**
 * 比较两个版本：a 比 b 新返回 1，旧返回 -1，相同返回 0。
 * @param {string} a 版本 A。
 * @param {string} b 版本 B。
 * @returns {number}
 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left.length === 0 || right.length === 0) return 0
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const x = left[i] ?? 0
    const y = right[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

/**
 * 取 GitHub 上最新的 release。
 * @param {object} [options] 选项。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @returns {Promise<{version:string, tag:string, url:string, notes:string, publishedAt:string, name:string}>}
 */
export async function fetchLatestRelease(options = {}) {
  const { signal } = options
  const text = await getText(LATEST_API, {
    signal,
    timeout: 15_000,
    retries: 1,
    maxRedirects: 3,
    headers: { Accept: 'application/vnd.github+json' },
  })
  const data = JSON.parse(text)
  const tag = String(data?.tag_name ?? '')
  const version = tag.replace(/^v/i, '')
  if (!version) throw new Error('GitHub 没有返回有效的版本号')
  return {
    version,
    tag,
    url: String(data?.html_url ?? `https://github.com/${REPO}/releases`),
    notes: String(data?.body ?? '').slice(0, 4000),
    publishedAt: String(data?.published_at ?? ''),
    name: String(data?.name ?? tag),
  }
}

/**
 * 版本检查器：带缓存，失败保留上一次的结果。
 */
export class ReleaseChecker {
  /**
   * @param {object} [options] 选项。
   * @param {string} [options.version] 当前版本，默认读 package.json。
   * @param {number} [options.ttl] 缓存时长（毫秒）。
   * @param {(line:string)=>void} [options.log] 日志。
   * @param {() => Promise<object>} [options.fetchLatest] 取最新版本的实现（测试可替换）。
   */
  constructor(options = {}) {
    this.version = options.version ?? currentVersion()
    this.ttl = options.ttl ?? DEFAULT_TTL
    this.log = options.log ?? (() => {})
    this.fetchLatest = options.fetchLatest ?? (() => fetchLatestRelease())
    this.cache = null
    this.checking = null
  }

  /**
   * 缓存是否还有效。
   * @returns {boolean}
   */
  get fresh() {
    return Boolean(this.cache && Date.now() - this.cache.checkedAt < this.ttl)
  }

  /**
   * 当前状态（不触发网络）。
   * @returns {object}
   */
  status() {
    return {
      current: this.version,
      repo: REPO,
      releasesUrl: `https://github.com/${REPO}/releases`,
      ...(this.cache ?? {}),
      checking: Boolean(this.checking),
      hasUpdate: this.cache ? this.cache.hasUpdate : false,
    }
  }

  /**
   * 检查更新；同一时间只会有一个请求在跑。
   * @param {object} [options] 选项。
   * @param {boolean} [options.force] 忽略缓存。
   * @param {AbortSignal} [options.signal] 取消信号。
   * @returns {Promise<object>} 状态快照。
   */
  async check(options = {}) {
    const { force = false, signal } = options
    if (!force && this.fresh) return this.status()
    if (this.checking) return this.checking

    this.checking = (async () => {
      try {
        const latest = await this.fetchLatest({ signal })
        this.cache = {
          latest: latest.version,
          tag: latest.tag,
          url: latest.url,
          notes: latest.notes,
          name: latest.name,
          publishedAt: latest.publishedAt,
          checkedAt: Date.now(),
          hasUpdate: compareVersions(latest.version, this.version) > 0,
          error: '',
        }
        if (this.cache.hasUpdate) this.log(`发现新版本 ${latest.version}（当前 ${this.version}）`)
      } catch (error) {
        // 检查失败不清掉上次结果，只记录错误
        this.cache = {
          ...(this.cache ?? {}),
          checkedAt: this.cache?.checkedAt ?? 0,
          hasUpdate: this.cache?.hasUpdate ?? false,
          error: error.message,
        }
      } finally {
        this.checking = null
      }
      return this.status()
    })()

    return this.checking
  }

  /**
   * 后台检查（不阻塞调用方，供 GET 接口触发）。
   * @returns {void}
   */
  checkInBackground() {
    if (this.checking || this.fresh) return
    this.check().catch(() => {})
  }
}
