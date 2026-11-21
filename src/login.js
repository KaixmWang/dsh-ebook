/**
 * 取书平台登录。
 *
 * Z-Library 走 eAPI（`/eapi/user/login`）——实测这条路径不受 DiamWall 验证墙影响，
 * 邮箱密码直接换 cookie，不需要浏览器、不需要手工粘贴。详见 sources/zlib.js。
 *
 * 这里保留域名探测与网络诊断：域名经常失效，先把「连不连得上」说清楚，
 * 再谈登录，比笼统报一句 fetch failed 有用得多。
 */
import { request, currentProxy } from './http.js'
import * as zlib from './sources/zlib.js'

/**
 * 识别站点下发的浏览器验证页。
 * DiamWall（z-library 网页端在用）与 Cloudflare 都会返回需要执行 JS 的页面。
 * 注意：eAPI 路径不走这条路，这个判断只用于网页探测。
 * @param {string} body 响应正文。
 * @returns {boolean}
 */
export function isBrowserChallenge(body) {
  return /Verifying your browser|DiamWall|Just a moment|challenge-platform|cf_chl|Enable JavaScript and cookies/i
    .test(String(body ?? '').slice(0, 6000))
}

/**
 * 把网络异常翻译成能指导下一步动作的诊断。
 * @param {Error} error 异常。
 * @returns {string}
 */
export function diagnoseNetworkError(error) {
  const text = `${error.message} ${error.cause?.code ?? ''} ${error.cause?.message ?? ''}`
  if (/HTTP 513/.test(text)) {
    return '站点网页端要求浏览器验证（DiamWall）。插件走的是 eAPI 接口，不受影响；这里只需确认账号能登录。'
  }
  if (/redirect count exceeded|too many redirects|重定向循环/i.test(text)) {
    return '该域名陷入重定向循环：可能已失效。换一个站点域名再试。'
  }
  if (/ECONNRESET|socket disconnected|Client network socket/i.test(text)) {
    return `连接被重置：代理节点拒绝了这个域名。换一个节点或换域名。${currentProxy() ? '' : '（当前未走代理）'}`
  }
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|Connect Timeout/i.test(text)) {
    return '连接超时：当前网络到该域名不通。确认代理已开启，并让代理覆盖这个域名。'
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(text)) {
    return '证书校验失败：可能是中间人拦截或域名被劫持，换域名或检查代理。'
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return '域名解析失败：检查域名拼写，或 DNS 被污染（可换 DNS 后再试）。'
  }
  return `请求失败：${error.message}`
}

/**
 * 探测站点域名是否可用（只探网页首页，用于判断域名本身活不活）。
 * @param {object} params 参数。
 * @returns {Promise<{ok:boolean, status:number, ms:number, proxy:string, message:string, challenge:boolean}>}
 */
export async function probeDomain(params) {
  const { domain, cookie, signal } = params
  const base = zlib.normalizeHost(domain)
  const started = Date.now()

  try {
    const response = await request(`${base}/`, {
      method: 'GET',
      signal,
      timeout: 25_000,
      retries: 0,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    })
    const ms = Date.now() - started
    const text = await response.text().catch(() => '')
    const challenge = isBrowserChallenge(text)

    if (challenge) {
      // 网页端有验证墙是常态，说明域名是活的；能不能用取决于 eAPI
      return {
        ok: true,
        status: response.status,
        ms,
        proxy: currentProxy(),
        challenge: true,
        message: `域名存活（网页端有 DiamWall 验证，HTTP ${response.status}）。插件走 eAPI 接口，不受验证墙影响，直接填邮箱密码登录即可。`,
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      ms,
      proxy: currentProxy(),
      challenge: false,
      message: response.ok ? `可达（HTTP ${response.status}，${ms} ms）` : `站点返回 HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      proxy: currentProxy(),
      message: diagnoseNetworkError(error),
      challenge: false,
    }
  }
}

/**
 * 尝试用账号密码登录 Z-Library（走 eAPI）。
 *
 * 登录端点实测畅通，但搜索端点在未认证时会被 DiamWall 拦；登录后能否放行
 * 取决于账号状态，所以登录成功后立刻用搜索端点探一次，把实情一起返回，
 * 免得用户以为登录成功就万事大吉。
 *
 * @param {object} params 参数。
 * @returns {Promise<{ok:boolean, cookie:string, message:string, searchOk:boolean}>}
 */
export async function loginZlibrary(params) {
  const { email, password, domain, signal } = params
  if (!email || !password) return { ok: false, cookie: '', message: '登录需要邮箱与密码', searchOk: false }

  const result = await zlib.login({ email, password, host: domain, signal })
  if (!result.ok) return { ok: false, cookie: '', message: result.message, searchOk: false }

  // 登录成功，顺手确认取书通道是否真的通
  const probe = await zlib.verifyLogin({ host: domain, cookie: result.cookie, signal })
  if (probe.ok) {
    return { ok: true, cookie: result.cookie, message: `${result.message}，取书通道已确认可用`, searchOk: true }
  }
  return {
    ok: true,
    cookie: result.cookie,
    message: `${result.message}，但取书通道未通过（${probe.message}）。可以点「验证」再试，或改用浏览器 Cookie 兜底。`,
    searchOk: false,
  }
}

/**
 * 用现有 cookie 验证会话是否仍然有效（走 eAPI 搜索接口试探）。
 * @param {object} params 参数。
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function verifyZlibraryCookie(params) {
  const { domain, cookie, signal } = params
  const result = await zlib.verifyLogin({ host: domain, cookie, signal })
  return { ok: result.ok, message: result.message }
}
