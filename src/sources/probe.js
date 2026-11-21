/**
 * 书源可达性探测。
 *
 * 只探「实际会被调用的接口」，不探首页——首页能开但搜索接口被挡（Anna's Archive 就是
 * 首页 200、/search 403 DDoS-Guard）是很常见的情况，探测首页会给假阳性。
 *
 * 每个源独立超时，一个慢不拖垮整批。
 */
import { request, currentProxy } from '../http.js'
import * as zlib from './zlib.js'
import { FALLBACK_MIRRORS } from '../fetch/mirrors.js'

/** 单源探测超时。 */
const PROBE_TIMEOUT = 15_000

/** 探测时带的浏览器头，尽量接近真实客户端。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 跑一个探测，统一成结果对象。
 * @param {string} id 源标识。
 * @param {string} label 展示名。
 * @param {string} detail 探测目标描述。
 * @param {(signal:AbortSignal)=>Promise<{ok:boolean, message:string}>} probe 探测函数。
 * @returns {Promise<object>}
 */
async function run(id, label, detail, probe) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('探测超时')), PROBE_TIMEOUT)
  try {
    const result = await probe(controller.signal)
    return { id, label, detail, ok: result.ok, ms: Date.now() - started, message: result.message }
  } catch (error) {
    const message = controller.signal.aborted ? `超时（${PROBE_TIMEOUT / 1000}s）` : String(error.message ?? error)
    return { id, label, detail, ok: false, ms: Date.now() - started, message: message.slice(0, 90) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探测 LibGen 单个镜像。
 * @param {string} host 域名。
 * @param {AbortSignal} signal 取消信号。
 * @returns {Promise<{ok:boolean, message:string}>}
 */
async function probeLibgenMirror(host, signal) {
  const response = await request(`https://${host}/index.php?req=test&res=1`, {
    signal,
    timeout: PROBE_TIMEOUT,
    retries: 0,
    maxRedirects: 5,
    headers: { 'user-agent': UA },
  })
  if (!response.ok) return { ok: false, message: `HTTP ${response.status}` }
  const html = await response.text().catch(() => '')
  if (!html.includes('tablelibgen')) return { ok: false, message: '页面结构异常（可能被拦）' }
  return { ok: true, message: '搜索接口正常' }
}

/**
 * 探测全部书源。
 * @param {object} options 选项。
 * @param {object} [options.zlib] Z-Library 凭据 {domain, cookie}。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @returns {Promise<{checkedAt:string, proxy:string, results:Array<object>}>}
 */
export async function probeSources(options = {}) {
  const { zlib: zlibConf, signal } = options
  const tasks = []

  // LibGen 家族：每个镜像单独探，用户能看出哪个能用
  for (const host of FALLBACK_MIRRORS) {
    tasks.push(run(
      `libgen:${host}`, 'LibGen', host,
      probeSignal => probeLibgenMirror(host, signal ?? probeSignal),
    ))
  }

  // Z-Library：探 eAPI 登录端点（不带凭据只看通道通不通）
  tasks.push(run('zlibrary', 'Z-Library', 'eAPI 接口', async probeSignal => {
    const host = zlibConf?.domain
    const response = await request(`${zlib.normalizeHost(host)}/eapi/user/login`, {
      method: 'POST',
      body: new URLSearchParams({ email: 'probe@example.invalid', password: 'x' }).toString(),
      signal: signal ?? probeSignal,
      timeout: PROBE_TIMEOUT,
      retries: 0,
      maxRedirects: 5,
      headers: {
        'user-agent': UA,
        'content-type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    })
    const text = await response.text().catch(() => '')
    if (/Verifying your browser|DiamWall/i.test(text.slice(0, 2000))) {
      return { ok: false, message: '被浏览器验证墙拦截' }
    }
    if (!/^\s*\{/.test(text)) return { ok: false, message: `非 JSON 响应（HTTP ${response.status}）` }
    const hasCookie = Boolean(zlibConf?.cookie)
    return { ok: true, message: hasCookie ? '接口正常（已登录）' : '接口正常（未登录，可在下方添加账号）' }
  }))

  // Internet Archive 搜索 API
  tasks.push(run('archive', 'Internet Archive', 'advancedsearch', async probeSignal => {
    const response = await request(
      'https://archive.org/advancedsearch.php?q=test&fl[]=identifier&rows=1&output=json',
      { signal: signal ?? probeSignal, timeout: PROBE_TIMEOUT, retries: 0, maxRedirects: 5, headers: { 'user-agent': UA } },
    )
    if (!response.ok) return { ok: false, message: `HTTP ${response.status}` }
    const text = await response.text().catch(() => '')
    if (!/"response"/.test(text)) return { ok: false, message: '响应格式异常' }
    return { ok: true, message: '搜索 API 正常' }
  }))

  const results = await Promise.all(tasks)
  return {
    checkedAt: new Date().toISOString(),
    proxy: currentProxy(),
    results,
  }
}
