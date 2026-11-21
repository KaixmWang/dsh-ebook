/** 统一 HTTP 访问：代理支持、UA、超时、重试、中文编码。 */
import { execFileSync } from 'node:child_process'
import { fetch as undiciFetch, ProxyAgent, Agent } from 'undici'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const DEFAULT_TIMEOUT = 30_000

/**
 * 进程内的简易 cookie 罐：按主机名记住站点下发的 cookie。
 * 只为跨重定向和后续请求服务，不落盘、不跨会话。
 * z-library 的 __diamwall、部分站点的会话标记都靠它才能过。
 * @type {Map<string, Map<string, string>>}
 */
const cookieJar = new Map()

/** cookie 罐最多记住多少个站点，防止长期运行无限增长。 */
const MAX_COOKIE_HOSTS = 64

/**
 * 取 URL 的主机名。
 * @param {string} url 地址。
 * @returns {string}
 */
function hostOf(url) {
  try { return new URL(url).hostname } catch { return '' }
}

/**
 * 记住响应下发的 cookie。
 * @param {string} url 请求地址。
 * @param {any} headers 响应头。
 */
function rememberCookies(url, headers) {
  let list = []
  try {
    if (typeof headers.getSetCookie === 'function') list = headers.getSetCookie()
    else {
      const raw = headers.get('set-cookie')
      if (raw) list = raw.split(/,(?=\s*[^;,=\s]+=)/)
    }
  } catch {
    return
  }
  if (!Array.isArray(list) || list.length === 0) return
  const host = hostOf(url)
  if (!host) return

  let jar = cookieJar.get(host)
  if (!jar) {
    // 罐子只增不减会一直占内存：站点数超过上限就丢掉最早的一个
    if (cookieJar.size >= MAX_COOKIE_HOSTS) {
      const oldest = cookieJar.keys().next().value
      if (oldest) cookieJar.delete(oldest)
    }
    jar = new Map()
    cookieJar.set(host, jar)
  }
  for (const raw of list) {
    const first = String(raw).split(';')[0]
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    // 过期即删除
    if (value === '' || /max-age=0\b|expires=thu,?\s*01\s*jan\s*1970/i.test(String(raw))) jar.delete(name)
    else jar.set(name, value)
  }
}

/**
 * 拼出该主机当前应带的 cookie 头。
 * @param {string} url 目标地址。
 * @returns {string}
 */
function cookieHeader(url) {
  const jar = cookieJar.get(hostOf(url))
  if (!jar || jar.size === 0) return ''
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
}

/** 当前 dispatcher；undefined 表示直连。 */
let dispatcher
let proxyUrl = ''

/**
 * 探测 Windows 系统代理（Clash/V2Ray 等设置的 HTTP 代理）。
 * @returns {string} 形如 http://127.0.0.1:7897，没有则空串。
 */
export function detectSystemProxy() {
  const fromEnv = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (fromEnv) return fromEnv
  if (process.platform !== 'win32') return ''
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const enabled = execFileSync('reg', ['query', key, '/v', 'ProxyEnable'], { encoding: 'utf8', windowsHide: true })
    if (!/0x1\b/.test(enabled)) return ''
    const serverOut = execFileSync('reg', ['query', key, '/v', 'ProxyServer'], { encoding: 'utf8', windowsHide: true })
    const match = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(serverOut)
    const server = match?.[1]?.trim()
    if (!server) return ''
    // ProxyServer 可能是 "http=host:port;https=host:port" 或单个 host:port
    const part = server.includes('=')
      ? (/https?=([^;]+)/.exec(server)?.[1] ?? server.split(';')[0].split('=')[1] ?? '')
      : server
    const hostPort = part.trim()
    if (!hostPort) return ''
    return hostPort.startsWith('http') ? hostPort : `http://${hostPort}`
  } catch {
    return ''
  }
}

/** 建连超时。undici 默认只有 10 秒，经代理连境外站常常不够，会导致误判「站点挂了」。 */
const CONNECT_TIMEOUT_MS = 40_000

/**
 * 配置网络代理。传入 'auto' 读系统代理，空串直连。
 * @param {string} [setting] 'auto' | '' | 'http://host:port'
 * @returns {{proxy:string, mode:string}}
 */
export function configureNetwork(setting = 'auto') {
  let url = ''
  if (setting === 'auto') url = detectSystemProxy()
  else if (setting) url = setting
  proxyUrl = url
  if (url) {
    try {
      dispatcher = new ProxyAgent({ uri: url, connect: { timeout: CONNECT_TIMEOUT_MS } })
      return { proxy: url, mode: 'proxy' }
    } catch (error) {
      dispatcher = new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS } })
      return { proxy: '', mode: `proxy-invalid: ${error.message}` }
    }
  }
  dispatcher = new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS } })
  return { proxy: '', mode: 'direct' }
}

/**
 * 当前代理地址。
 * @returns {string}
 */
export function currentProxy() {
  return proxyUrl
}

/**
 * 统一出口的 fetch（自动带上 dispatcher）。
 * @param {string} url 地址。
 * @param {object} [init] fetch 选项。
 * @returns {Promise<Response>}
 */
export function httpFetch(url, init = {}) {
  return undiciFetch(url, dispatcher ? { ...init, dispatcher } : init)
}

/**
 * 带超时、重试、自动跟随重定向与 cookie 维持的请求。
 *
 * 为什么要自己跟随重定向：不少站点用「307 跳回自身 + Set-Cookie」做校验墙
 * （z-library 的 __diamwall 就是这种）。fetch 不保存 cookie，自动跟随只会原地打转。
 * 这里手动逐跳跟随，把每跳下发的 cookie 记下来再带过去，跳几次就通了。
 *
 * @param {string} url 地址。
 * @param {object} [options] 请求选项。
 * @returns {Promise<Response>}
 */
export async function request(url, options = {}) {
  const {
    timeout = DEFAULT_TIMEOUT,
    retries = 1,
    signal,
    headers = {},
    maxRedirects = 10,
    ...rest
  } = options

  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeout)
    const onAbort = () => controller.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); throw signal.reason ?? new Error('已取消') }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      let currentUrl = url
      const visited = new Map()

      for (let hop = 0; hop <= maxRedirects; hop++) {
        const requested = { ...headers }
        // 带上这个站点之前下发过的 cookie
        const stored = cookieHeader(currentUrl)
        if (stored) requested.Cookie = requested.Cookie ? `${requested.Cookie}; ${stored}` : stored

        const response = await httpFetch(currentUrl, {
          ...rest,
          headers: { 'User-Agent': UA, Accept: '*/*', ...requested },
          signal: controller.signal,
          redirect: 'manual',
        })

        rememberCookies(currentUrl, response.headers)

        if (![301, 302, 303, 307, 308].includes(response.status)) {
          if (response.status >= 500 && attempt < retries) {
            lastError = new Error(`HTTP ${response.status}`)
            // 丢掉响应体，否则连接不会还回连接池
            await response.body?.cancel?.().catch(() => {})
            break
          }
          return response
        }

        const location = response.headers.get('location')
        if (!location) return response
        await response.body?.cancel?.().catch(() => {})

        const next = new URL(location, currentUrl).toString()
        const seen = (visited.get(next) ?? 0) + 1
        visited.set(next, seen)
        // 同一地址反复跳说明 cookie 没起作用，继续跟只会打转
        if (seen > 2) {
          throw new Error(
            `重定向循环（${next} 已访问 ${seen} 次）：站点在要求浏览器 cookie，` +
            '请在浏览器打开该站登录后，把 Cookie 粘到设置里',
          )
        }
        currentUrl = next
      }

      // 跳满 maxRedirects 仍未结束
      if (!lastError) {
        throw new Error(`重定向超过 ${maxRedirects} 次仍未结束：${url}`)
      }
    } catch (error) {
      lastError = error
      if (signal?.aborted) throw signal.reason ?? lastError
      if (attempt >= retries) throw lastError
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  throw lastError ?? new Error('请求失败')
}

/**
 * 取文本。
 * @param {string} url 地址。
 * @param {object} [options] 同 request。
 * @returns {Promise<string>}
 */
export async function getText(url, options) {
  const response = await request(url, options)
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`)
  const buf = Buffer.from(await response.arrayBuffer())
  return decodeBody(buf, response.headers.get('content-type') ?? '')
}

/**
 * 取字节。
 * 响应体读取也必须纳入重试：镜像经常在传完响应头后主动断开（UND_ERR_SOCKET / terminated），
 * 这种失败发生在 arrayBuffer() 阶段，只重试 fetch 抓不到。
 * @param {string} url 地址。
 * @param {object} [options] 同 request。
 * @returns {Promise<{buffer:Buffer, headers:any, status:number}>}
 */
export async function getBuffer(url, options = {}) {
  const { timeout, retries = 2, signal, ...rest } = options
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await request(url, { ...rest, timeout, retries: 0, signal })
      if (!response.ok) {
        // 4xx 是确定性结果，重试没有意义
        if (response.status < 500) throw new Error(`HTTP ${response.status} ${url}`)
        lastError = new Error(`HTTP ${response.status} ${url}`)
        continue
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      return { buffer, headers: response.headers, status: response.status }
    } catch (error) {
      lastError = error
      if (signal?.aborted) throw signal.reason ?? error
      const retriable = /HTTP 5\d\d|UND_ERR|terminated|socket|ECONNRESET|ETIMEDOUT|aborted/i.test(
        `${error.message} ${error.cause?.code ?? ''} ${error.cause?.message ?? ''}`,
      )
      if (!retriable || attempt >= retries) throw error
      // 断连后退避一下再试，避免立刻撞同一个连接池
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)))
    }
  }
  throw lastError ?? new Error('下载失败')
}

/**
 * 从 Content-Disposition 里取文件名。
 *
 * 两种写法都要认：
 *   filename="书名.pdf"                       （原始字节，服务器常直接塞 UTF-8 字节）
 *   filename*=UTF-8''%E4%B9%A6%E5%90%8D.pdf   （RFC 5987，百分号编码）
 *
 * 前者经常出现「UTF-8 字节被当 latin1 输出」的情况，按 latin1 取回再解 UTF-8 能还原。
 *
 * @param {Headers|any} headers 响应头。
 * @param {string} [fallback] 取不到时的回退名。
 * @returns {string}
 */
export function filenameFromHeaders(headers, fallback = '') {
  let disposition = ''
  try {
    disposition = headers?.get?.('content-disposition') ?? ''
  } catch {
    return fallback
  }
  if (!disposition) return fallback

  // RFC 5987 优先
  const extended = /filename\*\s*=\s*([^']*)''([^;]*)/i.exec(disposition)
  if (extended) {
    const encoded = extended[2].trim()
    const charset = (extended[1] || 'utf-8').trim() || 'utf-8'
    try {
      if (/utf-?8/i.test(charset)) return decodeURIComponent(encoded)
      return decodeBody(Buffer.from(decodeURIComponent(encoded), 'latin1'), `charset=${charset}`)
    } catch { /* 落到普通 filename */ }
  }

  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)
  if (plain) {
    let name = plain[1].trim()
    // 服务器把 UTF-8 字节按 latin1 输出时的还原
    if (/[\u0080-\u00ff]/.test(name)) {
      try {
        const restored = Buffer.from(name, 'latin1').toString('utf8')
        if (!restored.includes('\ufffd')) name = restored
      } catch { /* 保持原样 */ }
    }
    if (name) return name
  }
  return fallback
}

/**
 * 把任意书名清洗成可用的文件名主干。
 * @param {string} name 原始名称（可含扩展名）。
 * @param {string} [extension] 期望扩展名，不含点。
 * @returns {string} 形如 `书名.pdf`。
 */
export function safeFilename(name, extension) {
  let raw = String(name ?? '').trim()
  // 去掉已有的扩展名，统一由参数决定
  raw = raw.replace(/\.(pdf|epub|mobi|azw3|txt|djvu|fb2)$/i, '')
  let base = raw
    .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim()
  if (!base) base = 'book'
  if (base.length > 120) base = base.slice(0, 120).trim()
  return extension ? `${base}.${extension.replace(/^\./, '')}` : base
}

/**
 * 按 content-type 或声明字符集解码，缺省 UTF-8。
 * @param {Buffer} buf 字节。
 * @param {string} contentType 响应类型。
 * @returns {string}
 */
export function decodeBody(buf, contentType) {
  const match = /charset=([\w-]+)/i.exec(contentType ?? '')
  const charset = (match?.[1] ?? 'utf-8').toLowerCase()
  if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') {
    try { return new TextDecoder('gb18030').decode(buf) } catch { /* 回落到 utf-8 */ }
  }
  if (charset === 'iso-8859-1' || charset === 'latin1' || charset === 'us-ascii') {
    return buf.toString('latin1')
  }
  return buf.toString('utf8')
}

/**
 * 从 HTML 中抽出纯文本。
 * @param {string} html 片段。
 * @returns {string}
 */
export function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
}

/**
 * 清洗正文文本。
 * @param {string} text 原始文本。
 * @returns {string}
 */
export function normalizeText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
