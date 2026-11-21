/**
 * 微信读书推送：走墨水屏端使用的非公开接口。
 * 流程：/cos/getcredential 取临时凭证 → 上传腾讯 COS → /cos/notify 触发导入。
 * 需要用户自己的账号凭据（vid + refreshToken + deviceId），接口可能随官方调整。
 *
 * 注意：当前版本未把它注册为工具（工具集精简到 5 个）。协议实现保留完好，
 * 需要恢复时在 src/tools.js 里加回一个调用 pushToWeread 的工具定义即可。
 */
import { createHash, createHmac, randomInt } from 'node:crypto'
import { httpFetch } from '../http.js'

const BASE = 'https://i.weread.qq.com'
const EINK_UA = 'WeRead/2.1.2 WRBrand/Onyx wr_eink Dalvik/2.1.0 (Linux; U; Android 11; BOOX Build/onyx)'

/**
 * 固定的墨水屏端请求头。
 * @returns {Record<string,string>}
 */
function versionHeaders() {
  return {
    baseapi: '30',
    appver: '2.1.2.10245900',
    basever: '2.1.2.10245900',
    osver: '11',
    channelId: '900',
    'User-Agent': EINK_UA,
  }
}

/**
 * 用 refreshToken 换 accessToken。
 * @param {object} credentials 凭据。
 * @param {object} [options] 选项。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @returns {Promise<{vid:string, accessToken:string}>}
 */
export async function mintAccessToken(credentials, options = {}) {
  const { signal } = options
  const timestamp = Date.now()
  const random = randomInt(1, 1001)
  const body = {
    deviceId: credentials.deviceId,
    deviceName: 'BOOX',
    inBackground: 0,
    kickType: 1,
    random,
    refCgi: '',
    refreshToken: credentials.refreshToken,
    signature: createHash('sha256').update(`${timestamp}${credentials.deviceId}${random}`).digest('hex'),
    timestamp,
    trackId: '',
    deviceType: 3,
  }
  const response = await httpFetch(`${BASE}/login`, {
    method: 'POST',
    headers: { ...versionHeaders(), 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
    signal,
  })
  const data = await response.json().catch(() => ({}))
  const accessToken = data?.accessToken ?? data?.access_token
  const vid = String(data?.vid ?? credentials.vid ?? '')
  if (!accessToken) {
    throw new Error(`微信读书换取 token 失败：${data?.errMsg ?? data?.errcode ?? response.status}`)
  }
  return { vid, accessToken }
}

/**
 * 调微信读书移动端接口。
 * @param {string} method 方法。
 * @param {string} path 路径。
 * @param {object} options 选项。
 * @returns {Promise<any>}
 */
async function call(method, path, options) {
  const { auth, query, body, signal } = options
  const url = `${BASE}${path}${query ? `?${query}` : ''}`
  const response = await httpFetch(url, {
    method,
    headers: {
      vid: auth.vid,
      accessToken: auth.accessToken,
      ...versionHeaders(),
      ...(body ? { 'content-type': 'application/json; charset=UTF-8' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`微信读书返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  const code = data?.errcode ?? data?.errCode
  if (response.status === 401 || code === -2012) throw new Error('微信读书登录已失效：请更新 vid / refreshToken / deviceId')
  if (code === -2041) throw new Error('微信读书要求人工验证（-2041）：请在官方客户端完成验证后重试')
  if (!response.ok || (code !== undefined && code !== 0)) {
    throw new Error(`微信读书接口 ${path} 失败：${code ?? response.status} ${data?.errMsg ?? data?.errmsg ?? ''}`.trim())
  }
  return data
}

/**
 * 计算腾讯 COS 的 q-sign-algorithm=sha1 签名头。
 * @param {object} params 参数。
 * @returns {string}
 */
function cosAuthorization(params) {
  const { secretId, secretKey, method, pathname, headers } = params
  const start = Math.floor(Date.now() / 1000) - 60
  const end = start + 3600
  const keyTime = `${start};${end}`
  const signKey = createHmac('sha1', secretKey).update(keyTime).digest('hex')
  const headerEntries = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), String(value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const headerList = headerEntries.map(([key]) => key).join(';')
  const headerString = headerEntries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  const httpString = `${method.toLowerCase()}\n${pathname}\n\n${headerString}\n`
  const stringToSign = `sha1\n${keyTime}\n${createHash('sha1').update(httpString).digest('hex')}\n`
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex')
  return [
    'q-sign-algorithm=sha1',
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList}`,
    'q-url-param-list=',
    `q-signature=${signature}`,
  ].join('&')
}

/**
 * 上传字节到腾讯 COS。
 * @param {object} params 参数。
 * @returns {Promise<void>}
 */
async function cosUpload(params) {
  const { bucket, key, credentials, bytes, signal } = params
  const host = `${bucket}.cos.accelerate.myqcloud.com`
  const pathname = `/${key}`
  const headers = {
    host,
    'x-cos-security-token': credentials.Token,
  }
  const authorization = cosAuthorization({
    secretId: credentials.TmpSecretId,
    secretKey: credentials.TmpSecretKey,
    method: 'PUT',
    pathname,
    headers,
  })
  const response = await httpFetch(`https://${host}${pathname}`, {
    method: 'PUT',
    headers: {
      Host: host,
      Authorization: authorization,
      'x-cos-security-token': credentials.Token,
      'Content-Type': 'application/octet-stream',
    },
    body: bytes,
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`COS 上传失败 HTTP ${response.status}：${text.slice(0, 300)}`)
  }
}

/**
 * 把一本书推进微信读书。
 * 返回值只带导入结果，不回传 accessToken——它会被后台任务表原样转发给前端。
 * @param {object} params 参数。
 * @returns {Promise<{bookId:string, deepLink:string, vid:string}>}
 */
export async function pushToWeread(params) {
  const { bytes, filename, credentials, signal } = params
  if (!credentials?.refreshToken || !credentials?.deviceId) {
    throw new Error('缺少微信读书凭据：需要 refreshToken 与 deviceId（配置 weread.*）')
  }
  let auth = { vid: credentials.vid, accessToken: credentials.accessToken }
  if (!auth.accessToken) auth = await mintAccessToken(credentials, { signal })

  const baseName = filename.replace(/\.[^./\\]+$/, '')
  const query = `name=${encodeURIComponent(baseName)}&from=`
  let credentialResponse
  try {
    credentialResponse = await call('GET', '/cos/getcredential', { auth, query, signal })
  } catch (error) {
    if (/登录已失效/.test(error.message)) {
      auth = await mintAccessToken(credentials, { signal })
      credentialResponse = await call('GET', '/cos/getcredential', { auth, query, signal })
    } else throw error
  }

  const bucket = credentialResponse.bucket
  const objectName = credentialResponse.ObjectName
  const cosCredentials = credentialResponse.Response?.Credentials
  if (!bucket || !objectName || !cosCredentials?.TmpSecretId) {
    throw new Error('微信读书返回的 COS 凭证不完整')
  }

  await cosUpload({
    bucket,
    key: String(objectName).replace(/^\//, ''),
    credentials: cosCredentials,
    bytes: new Uint8Array(bytes),
    signal,
  })

  const notification = await call('POST', '/cos/notify', {
    auth,
    query: `name=${encodeURIComponent(filename)}&path=${encodeURIComponent(objectName)}&cancel=0`,
    body: {},
    signal,
  })
  if (notification?.status !== 1) throw new Error('微信读书导入未确认成功（notify 未返回 status=1）')
  const bookId = String(notification.bookId ?? '')
  return {
    bookId,
    deepLink: bookId ? `https://weread.qq.com/web/reader/${bookId}` : 'https://weread.qq.com/',
    vid: auth.vid,
  }
}
