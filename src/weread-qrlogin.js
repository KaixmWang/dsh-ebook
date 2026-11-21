/**
 * 微信读书扫码登录。
 *
 * 全程是普通 HTTP 调用，不依赖浏览器或 Electron 窗口，所以在 Host 侧就能跑完：
 *
 *   1. GET  i.weread.qq.com/wxticket          → signature + timeStamp
 *   2. GET  open.weixin.qq.com/connect/sdk/qrconnect → uuid
 *   3. 二维码内容 = open.weixin.qq.com/connect/confirm?uuid=<uuid>
 *   4. GET  long.open.weixin.qq.com/connect/l/qrconnect → 轮询扫码状态
 *      wx_errcode: 408 等待 / 404 已扫 / 405 已确认（带 wx_code）/ 402 过期 / 403 拒绝
 *   5. POST i.weread.qq.com/login             → vid + refreshToken + accessToken
 *
 * 设备身份用公共的墨水屏标识（BOOX / Onyx），与 weread-omni 保持一致。
 */
import { createHash, randomInt, randomBytes } from 'node:crypto'
import { request } from './http.js'

const WEREAD = 'https://i.weread.qq.com'
const WX_APPID = 'wxab9b71ad2b90ff34'
const SCOPE = 'snsapi_userinfo,snsapi_timeline,snsapi_friend'
/** 墨水屏客户端的设备 ID 前缀。 */
const DEVICE_ID_PREFIX = 'eink334691225'
const UA = 'WeRead/2.1.2 WRBrand/Onyx wr_eink Dalvik/2.1.0 (Linux; U; Android 11; BOOX Build/onyx)'

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
    'User-Agent': UA,
  }
}

/**
 * 随机数字串。
 * @param {number} length 位数。
 * @returns {string}
 */
function digits(length) {
  let out = ''
  for (let i = 0; i < length; i++) out += String(randomInt(10))
  return out
}

/**
 * 生成设备 ID（与官方客户端同构：前缀 + 19 位数字）。
 * @returns {string}
 */
function newDeviceId() {
  const value = BigInt.asUintN(63, randomBytes(8).readBigUInt64BE()).toString().padStart(19, '0')
  return `${DEVICE_ID_PREFIX}${value}`
}

/**
 * 取 JSON。
 * @param {string} url 地址。
 * @param {object} [options] 选项。
 * @returns {Promise<any>}
 */
async function getJson(url, options = {}) {
  const response = await request(url, {
    timeout: 30_000,
    retries: 1,
    maxRedirects: 3,
    signal: options.signal,
    headers: { ...versionHeaders(), ...(options.headers ?? {}) },
  })
  const text = await response.text()
  try {
    return { ok: response.ok, status: response.status, data: JSON.parse(text) }
  } catch {
    throw new Error(`返回的不是 JSON（HTTP ${response.status}）`)
  }
}

/**
 * 申请一个登录二维码。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<{uuid:string, confirmUrl:string}>}
 */
export async function requestQr(signal) {
  const ticket = await getJson(`${WEREAD}/wxticket?nonceStr=weread`, { signal })
  if (!ticket.ok || typeof ticket.data?.signature !== 'string' || ticket.data.timeStamp === undefined) {
    throw new Error('取二维码签名失败')
  }

  const url = new URL('https://open.weixin.qq.com/connect/sdk/qrconnect')
  url.search = new URLSearchParams({
    appid: WX_APPID,
    noncestr: 'weread',
    timestamp: String(ticket.data.timeStamp),
    scope: SCOPE,
    signature: ticket.data.signature,
  }).toString()

  const qr = await getJson(url.toString(), { signal, headers: { 'User-Agent': UA } })
  if (!qr.ok || qr.data?.errcode !== 0 || typeof qr.data?.uuid !== 'string') {
    throw new Error(`取二维码失败：${qr.data?.errcode ?? qr.status}`)
  }
  return {
    uuid: qr.data.uuid,
    confirmUrl: `https://open.weixin.qq.com/connect/confirm?uuid=${encodeURIComponent(qr.data.uuid)}`,
  }
}

/**
 * 轮询一次扫码状态。
 * @param {object} params 参数。
 * @param {string} params.uuid 二维码标识。
 * @param {number} [params.last] 上次的状态码，用于长轮询。
 * @param {AbortSignal} [params.signal] 取消信号。
 * @returns {Promise<{status:'waiting'|'scanned'|'confirmed'|'expired'|'declined', wxCode?:string, last?:number}>}
 */
export async function pollOnce(params) {
  const { uuid, last, signal } = params
  const url = new URL('https://long.open.weixin.qq.com/connect/l/qrconnect')
  url.searchParams.set('f', 'json')
  url.searchParams.set('uuid', uuid)
  if (last !== undefined) url.searchParams.set('last', String(last))

  const result = await getJson(url.toString(), { signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
  const code = Number(result.data?.wx_errcode)
  if (code === 405) {
    const wxCode = result.data?.wx_code
    if (typeof wxCode !== 'string' || !wxCode) throw new Error('扫码确认没有返回 wx_code')
    return { status: 'confirmed', wxCode }
  }
  if (code === 404) return { status: 'scanned', last: code }
  if (code === 402) return { status: 'expired' }
  if (code === 403) return { status: 'declined' }
  // 408 与其它未列出的码都按「继续等」处理，避免偶发状态直接中断
  return { status: 'waiting', last: code }
}

/**
 * 用扫码得到的 code 换正式令牌。
 * @param {object} params 参数。
 * @param {string} params.wxCode 扫码 code。
 * @param {string} [params.deviceId] 设备 ID，省略则新建。
 * @param {AbortSignal} [params.signal] 取消信号。
 * @returns {Promise<{vid:string, accessToken:string, refreshToken:string, deviceId:string}>}
 */
export async function exchange(params) {
  const { wxCode, signal } = params
  const deviceId = params.deviceId ?? newDeviceId()
  const timestamp = Date.now()
  const random = randomInt(1000)

  const body = {
    appFirstInstall: 1,
    code: wxCode,
    deviceId,
    deviceName: 'BOOX',
    installId: `eink31${digits(26)}`,
    isAutoLogout: 0,
    isFromQrcode: 1,
    random,
    signature: createHash('sha256').update(`${timestamp}${deviceId}${random}`).digest('hex'),
    timestamp,
    trackId: '',
    deviceType: 3,
  }

  const response = await request(`${WEREAD}/login`, {
    method: 'POST',
    timeout: 30_000,
    retries: 0,
    maxRedirects: 3,
    signal,
    headers: { ...versionHeaders(), 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`登录返回不是 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok || typeof data?.accessToken !== 'string' || typeof data?.refreshToken !== 'string') {
    throw new Error(`登录失败：${data?.errCode ?? response.status} ${data?.errMsg ?? ''}`.trim())
  }
  return {
    vid: String(data.vid ?? ''),
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    deviceId,
  }
}
