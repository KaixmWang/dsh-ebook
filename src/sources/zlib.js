/**
 * Z-Library 书源——走 eAPI（官方客户端用的 JSON 接口）。
 *
 * 为什么不用网页：站点首页由 DiamWall 浏览器验证保护，307 跳自身 + 513 验证页，
 * 需要执行 JS 才能过，脚本没有出路。但 /eapi/ 这条路径是给官方客户端用的白名单通道，
 * 实测直接返回 JSON（假凭据会得到 {"success":0,"error":"Incorrect email or password"}），
 * 完全不碰验证墙。所以这里全程走 eAPI：登录一次拿 cookie，之后搜索和取书都带上。
 *
 * 协议（实测于 2026-11）：
 *   POST /eapi/user/login            form: email, password      → { success, user: { id, remix_userkey } }
 *   POST /eapi/book/search           form: message, limit, extensions[], languages[] → { success, books: [...] }
 *   GET  /eapi/book/{id}/{hash}/file                            → { success, file: { downloadLink, allowDownload } }
 */
import { request, getBuffer, filenameFromHeaders } from '../http.js'

/** 默认站点；实测 z-lib.by 的 eAPI 可用，域名变了用户可在设置里改。 */
export const DEFAULT_HOST = 'z-lib.by'

/** eAPI 要求的 UA（与官方客户端一致的普通浏览器 UA 即可）。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 规范化站点地址。
 * @param {string} [domain] 用户配置的域名，可省略协议。
 * @returns {string} 形如 https://z-lib.by
 */
export function normalizeHost(domain) {
  const raw = String(domain ?? '').trim()
  if (!raw) return `https://${DEFAULT_HOST}`
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return withScheme.replace(/\/+$/, '')
}

/**
 * 调 eAPI 并解析 JSON。验证墙页面会被识别成明确错误，而不是当成数据。
 * @param {object} params 参数。
 * @returns {Promise<any>}
 */
async function eapiCall(params) {
  const { host, path, method = 'GET', form, cookie, signal, timeout = 30_000 } = params
  const url = `${normalizeHost(host)}${path}`
  const headers = {
    'user-agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  }

  const response = await request(url, {
    method,
    headers,
    body: form ? form.toString() : undefined,
    signal,
    timeout,
    retries: 0,
  })

  const text = await response.text().catch(() => '')

  if (/Verifying your browser|DiamWall|Just a moment|challenge-platform/i.test(text.slice(0, 2000))) {
    throw new Error(
      'eAPI 被浏览器验证拦截（DiamWall）。这通常意味着这个域名把 /eapi 也纳入了保护，'
      + '换一个站点域名再试（如 z-lib.by / z-library.sk）。',
    )
  }

  if (!/^\s*[[{]/.test(text)) {
    throw new Error(`eAPI 返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 120).replace(/\s+/g, ' ')}`)
  }

  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`eAPI 返回的 JSON 解析失败（HTTP ${response.status}）`)
  }
  return { status: response.status, data }
}

/**
 * 用邮箱密码登录，返回可直接用于后续请求的 cookie 串。
 * @param {object} params 参数。
 * @param {string} params.email 邮箱。
 * @param {string} params.password 密码。
 * @param {string} [params.host] 站点域名。
 * @param {AbortSignal} [params.signal] 取消信号。
 * @returns {Promise<{ok:boolean, cookie:string, userId:string, message:string}>}
 */
export async function login(params) {
  const { email, password, host, signal } = params
  if (!email || !password) {
    return { ok: false, cookie: '', userId: '', message: '需要邮箱与密码' }
  }

  const form = new URLSearchParams()
  form.set('email', email)
  form.set('password', password)

  let result
  try {
    result = await eapiCall({ host, path: '/eapi/user/login', method: 'POST', form, signal })
  } catch (error) {
    return { ok: false, cookie: '', userId: '', message: error.message }
  }

  const { data, status } = result
  if (!data?.success || !data.user) {
    return {
      ok: false,
      cookie: '',
      userId: '',
      message: data?.error ? String(data.error) : `登录失败（HTTP ${status}）`,
    }
  }

  const user = data.user
  const cookie = [
    `remix_userid=${user.id}`,
    `remix_userkey=${user.remix_userkey}`,
    'siteLanguageV2=zh',
  ].join('; ')

  return {
    ok: true,
    cookie,
    userId: String(user.id ?? ''),
    message: `登录成功${user.name ? `（${user.name}）` : ''}`,
  }
}

/**
 * 用现有 cookie 确认会话是否还有效。
 * @param {object} params 参数。
 * @returns {Promise<{ok:boolean, message:string, name:string}>}
 */
export async function verifyLogin(params) {
  const { host, cookie, signal } = params
  if (!cookie) return { ok: false, message: '还没有登录凭据', name: '' }
  // 用搜索接口探一次：能返回 JSON 就说明 cookie 被接受
  const form = new URLSearchParams()
  form.set('message', 'test')
  form.set('limit', '1')
  try {
    const { data } = await eapiCall({ host, path: '/eapi/book/search', method: 'POST', form, cookie, signal })
    if (data?.success) return { ok: true, message: '会话有效', name: '' }
    return { ok: false, message: data?.error ? String(data.error) : '会话已失效，请重新登录', name: '' }
  } catch (error) {
    return { ok: false, message: error.message, name: '' }
  }
}

/**
 * 查询账号状态与今日配额。
 *
 * eAPI 的 /eapi/user/profile 直接给出 downloads_today / downloads_limit，
 * 所以配额是「读出来的」而不是本地猜的——换设备、用网页下过书都能反映出来。
 *
 * @param {object} params 参数。
 * @param {string} [params.host] 站点域名。
 * @param {string} params.cookie 登录 cookie。
 * @param {AbortSignal} [params.signal] 取消信号。
 * @returns {Promise<{ok:boolean, message:string, email:string, name:string, downloadsToday:number, downloadsLimit:number, remaining:number, isPremium:boolean, expires:string}>}
 */
export async function fetchProfile(params) {
  const { host, cookie, signal } = params
  const empty = {
    ok: false, message: '', email: '', name: '',
    downloadsToday: 0, downloadsLimit: 0, remaining: 0,
    isPremium: false, expires: '',
  }
  if (!cookie) return { ...empty, message: '未登录' }

  try {
    const { data } = await eapiCall({ host, path: '/eapi/user/profile', cookie, signal })
    if (!data?.success || !data.user) {
      return { ...empty, message: data?.error ? String(data.error) : '查询失败' }
    }
    const user = data.user
    const used = Number(user.downloads_today ?? 0)
    const limit = Number(user.downloads_limit ?? 0)
    return {
      ok: true,
      message: '正常',
      email: String(user.email ?? ''),
      name: String(user.name ?? ''),
      downloadsToday: used,
      downloadsLimit: limit,
      remaining: Math.max(0, limit - used),
      isPremium: Boolean(user.isPremium),
      expires: user.donations_expire ? String(user.donations_expire) : '',
    }
  } catch (error) {
    return { ...empty, message: error.message }
  }
}

/**
 * 搜索书籍。
 * @param {string} query 关键词。
 * @param {object} options 选项。
 * @param {string} [options.domain] 站点域名。
 * @param {string} [options.cookie] 登录 cookie。
 * @param {number} [options.limit] 条数。
 * @param {string} [options.format] 格式过滤。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @returns {Promise<Array<object>>}
 */
export async function search(query, options = {}) {
  const { domain, cookie, limit = 20, format, signal } = options
  if (!cookie) throw new Error('Z-Library 需要先登录（设置页里填邮箱密码）')

  const form = new URLSearchParams()
  form.set('message', String(query))
  form.set('limit', String(limit))
  if (format) form.append('extensions[]', String(format).toLowerCase())

  const { data } = await eapiCall({ host: domain, path: '/eapi/book/search', method: 'POST', form, cookie, signal })
  if (!data?.success) throw new Error(data?.error ? String(data.error) : '搜索失败')

  const books = Array.isArray(data.books) ? data.books : []
  return books.map(book => ({
    title: String(book.title ?? ''),
    author: String(book.author ?? ''),
    year: String(book.year ?? ''),
    language: String(book.language ?? ''),
    extension: String(book.extension ?? '').toLowerCase(),
    size: String(book.filesizeString ?? ''),
    // 统一用 `${id}/${hash}` 作为这本书在源内的标识
    md5: `${book.id ?? ''}/${book.hash ?? ''}`,
    bookPath: `${book.id ?? ''}/${book.hash ?? ''}`,
    id: String(book.id ?? ''),
    hash: String(book.hash ?? ''),
    source: 'zlibrary',
  })).filter(item => item.id && item.hash)
}

/**
 * 取下载直链。
 * @param {object} params 参数。
 * @param {string} params.host 站点域名。
 * @param {string} params.cookie 登录 cookie。
 * @param {string} params.bookPath `${id}/${hash}`。
 * @param {AbortSignal} [params.signal] 取消信号。
 * @returns {Promise<string>}
 */
export async function resolveDownload(params) {
  const { host, cookie, bookPath, signal } = params
  const path = `/eapi/book/${bookPath}/file`
  const { data } = await eapiCall({ host, path, cookie, signal })
  if (!data?.success) throw new Error(data?.error ? String(data.error) : '取下载链接失败')
  const file = data.file ?? {}
  if (file.allowDownload === false) throw new Error('这本书当前不允许下载（可能超出每日额度或需要更高权限）')
  if (!file.downloadLink) throw new Error('接口没有返回下载链接')
  return String(file.downloadLink)
}

/**
 * 下载书籍字节。
 * @param {string} bookPath `${id}/${hash}`。
 * @param {object} options 选项。
 * @returns {Promise<{buffer:Buffer, url:string}>}
 */
export async function download(bookPath, options = {}) {
  const { domain, cookie, signal, maxBytes = 300 * 1024 * 1024 } = options
  const link = await resolveDownload({ host: domain, cookie, bookPath, signal })

  // 下载链接指向另一台主机，带上同样的 cookie 才被接受
  let hostname = ''
  try { hostname = new URL(link).hostname } catch { /* 交给 getBuffer 报错 */ }

  const { buffer, headers } = await getBuffer(link, {
    signal,
    timeout: 240_000,
    retries: 1,
    headers: {
      'user-agent': UA,
      ...(hostname ? { authority: hostname } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
  })
  if (buffer.length === 0) throw new Error('下载内容为空')
  if (buffer.length > maxBytes) throw new Error(`文件体积 ${buffer.length} 超过上限 ${maxBytes}`)
  return { buffer, url: link, filename: filenameFromHeaders(headers) }
}
