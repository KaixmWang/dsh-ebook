/**
 * 设置面板用的 HTTP 接口。
 *
 * 走 webServer 的普通路由，而不是 Typert Remote：设置页在无会话时也要能打开，
 * Remote 命名空间绑定会话，不合适。
 * 只接受来自本机回环地址的请求——这些接口能改书库目录、能写入账号凭据。
 */
import { statSync, mkdirSync, accessSync, constants, existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join, basename, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PLATFORMS } from './settings.js'
import { loginZlibrary, verifyZlibraryCookie, probeDomain } from './login.js'
import { currentProxy, request as httpRequest } from './http.js'
import { probeSources } from './sources/probe.js'
import { fetchProfile as fetchZlibProfile } from './sources/zlib.js'
import { findCovers, downloadCover } from './cover-web.js'
import { lookupBookInfo } from './bookinfo.js'
import { pushToWeread } from './push/weread.js'
import { requestQr, pollOnce, exchange } from './weread-qrlogin.js'

const PREFIX = '/dsh-ebook/api'

/** 后台任务表：翻译 / OCR 这类长活儿不在 HTTP 请求里同步等。 */
const backgroundTasks = new Map()

/**
 * 记一个后台任务。同 kind + 同书若有在跑的任务，返回 null（幂等，防连点重复跑）。
 * @param {string} kind 任务类型。
 * @param {string} [dir] 关联的书目录名。
 * @returns {{id:string, push:(line:string)=>void}|null}
 */
function startTask(kind, dir = '') {
  const running = [...backgroundTasks.values()]
    .find(task => task.status === 'running' && task.kind === kind && task.dir === dir)
  if (running) return null
  const id = randomUUID()
  const task = {
    id,
    kind,
    dir,
    status: 'running',
    startedAt: Date.now(),
    message: '',
    result: null,
    log: [],
  }
  backgroundTasks.set(id, task)
  // 只淘汰已结束的旧记录，正在跑的任务不能被挤掉
  if (backgroundTasks.size > 30) {
    const finished = [...backgroundTasks.values()]
      .filter(item => item.status !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt)
    for (const item of finished) {
      if (backgroundTasks.size <= 30) break
      backgroundTasks.delete(item.id)
    }
  }
  return {
    id,
    // 把长任务里的每一步都记下来，失败时能看出卡在哪
    push(line) {
      const text = String(line ?? '').trim()
      if (!text) return
      task.log.push(text)
      if (task.log.length > 80) task.log.splice(0, task.log.length - 80)
    },
  }
}

/**
 * 列出任务的对外视图（去掉内部字段，日志只留尾部）。
 * @param {object} task 内部任务。
 * @returns {object}
 */
function taskView(task) {
  return {
    id: task.id,
    kind: task.kind,
    dir: task.dir ?? '',
    status: task.status,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt ?? null,
    elapsedMs: (task.finishedAt ?? Date.now()) - task.startedAt,
    message: task.message ?? '',
    log: (task.log ?? []).slice(-12),
    result: task.status === 'done' ? task.result ?? null : null,
  }
}

/**
 * 标记任务完成或失败。
 * @param {string} id 任务 id。
 * @param {object} patch 变更。
 */
function finishTask(id, patch) {
  const task = backgroundTasks.get(id)
  if (task) Object.assign(task, patch, { finishedAt: Date.now() })
}

/**
 * 发一张图片。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {string} filePath 文件路径。
 */
function sendFile(res, filePath) {
  const ext = filePath.toLowerCase().split('.').pop()
  const type = ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
      : ext === 'gif' ? 'image/gif'
        : 'image/jpeg'
  try {
    const data = readFileSync(filePath)
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      // 封面基本不变，缓存久一点
      'Cache-Control': 'private, max-age=3600',
    })
    res.end(data)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('封面不存在')
  }
}

/**
 * 发一段图片字节。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {Buffer} data 字节。
 * @param {string} mediaType MIME 类型。
 */
function sendImageBuffer(res, data, mediaType) {
  res.writeHead(200, {
    'Content-Type': mediaType,
    'Content-Length': data.length,
    'Cache-Control': 'private, max-age=1800',
  })
  res.end(data)
}

/**
 * 扫码登录会话。后端自己轮询微信，前端只查状态，避免长请求把界面卡住。
 * id -> { uuid, status, message, createdAt, expiresAt, cancelled }
 */
const qrSessions = new Map()

/**
 * 把二维码内容渲染成 data URL，前端直接塞给 img。
 * @param {string} text 二维码内容。
 * @returns {Promise<string>}
 */
async function renderQr(text) {
  const mod = await import('qrcode')
  const QRCode = mod.default ?? mod
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
    color: { dark: '#000000', light: '#ffffff' },
  })
}

/**
 * 后台跑完整个扫码流程。
 * @param {object} session 会话对象。
 * @param {object} settings 设置实例。
 * @param {Function} log 日志。
 */
async function runQrSession(session, settings, log) {
  let last
  while (Date.now() < session.expiresAt) {
    if (session.cancelled) return
    try {
      const result = await pollOnce({ uuid: session.uuid, last, signal: AbortSignal.timeout(70_000) })
      if (result.status === 'confirmed') {
        session.status = 'exchanging'
        session.message = '已确认，正在换取令牌…'
        const auth = await exchange({ wxCode: result.wxCode, signal: AbortSignal.timeout(30_000) })
        settings.setWeread({
          vid: auth.vid,
          refreshToken: auth.refreshToken,
          deviceId: auth.deviceId,
        })
        session.status = 'done'
        session.message = `登录成功（vid ${auth.vid}）`
        log(`微信读书扫码登录成功，vid=${auth.vid}`)
        return
      }
      if (result.status === 'scanned') {
        session.status = 'scanned'
        session.message = '已扫描，请在手机上点确认'
      } else if (result.status === 'expired') {
        session.status = 'expired'
        session.message = '二维码已过期，请重新获取'
        return
      } else if (result.status === 'declined') {
        session.status = 'declined'
        session.message = '手机上取消了登录'
        return
      }
      last = result.last
    } catch (error) {
      // 单次轮询失败不终止，等一下重试
      session.message = `等待中（${error.message.slice(0, 40)}）`
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }
  session.status = 'expired'
  session.message = '二维码已过期，请重新获取'
}

/**
 * 扫一本书的目录，汇总给书库界面用的信息。
 * @param {string} root 书库根。
 * @param {string} dirName 书目录名。
 * @param {object} library 书库实例。
 * @returns {object|null}
 */
function bookCard(root, dirName, library) {
  const dir = join(root, dirName)
  const meta = library.readMeta(dir)
  const manifest = library.readManifest(dir)
  let files
  try {
    files = readdirSync(dir)
  } catch {
    return null
  }
  // 只要有点可展示的东西就算一本书：入库过，或者至少有原始文件
  const hasSource = files.some(f => /\.(pdf|epub|mobi|azw3)$/i.test(f))
  if (!meta.title && !manifest && !hasSource) return null

  const coverFile = files.find(f => /^cover\.(jpg|jpeg|png|webp|gif)$/i.test(f))
  const sourceFile = meta.sourceFile ?? files.find(f => /\.(pdf|epub|mobi|azw3)$/i.test(f) && f !== 'book.epub')
  // 能给人读的 EPUB：优先生成的 book.epub，其次原始 EPUB（EPUB 源不再复制一份成品）
  const epubFile = files.includes('book.epub')
    ? 'book.epub'
    : String(sourceFile ?? '').toLowerCase().endsWith('.epub') ? String(sourceFile) : ''

  return {
    dir: dirName,
    title: meta.title ?? manifest?.title ?? dirName,
    creator: meta.creator ?? '',
    language: meta.language ?? '',
    description: meta.description ?? '',
    descriptionZh: meta.descriptionZh ?? '',
    summarySource: meta.summarySource ?? '',
    publisher: meta.publisher ?? '',
    translator: meta.translator ?? '',
    rating: meta.rating ?? 0,
    ratingCount: meta.ratingCount ?? 0,
    ratingSource: meta.ratingSource ?? '',
    format: meta.format ?? (sourceFile ? String(sourceFile.split('.').pop() ?? '') : ''),
    chapters: manifest?.chapters?.length ?? meta.chapters ?? 0,
    chars: manifest?.chars ?? meta.chars ?? 0,
    hasCover: Boolean(coverFile),
    epubFile,
    hasEpub: Boolean(epubFile),
    hasMarkdown: files.includes('book.md'),
    sourceFile: sourceFile ?? '',
    translatedTo: meta.translated ?? '',
    ocrApplied: Boolean(meta.ocr?.applied),
    ocrFailed: meta.ocr?.failed?.length ?? 0,
    updatedAt: meta.updatedAt ?? null,
  }
}

/**
 * 界面文件的修改时间。客户端把它显示出来，用一眼就能判断浏览器加载的是不是最新代码。
 * @returns {string}
 */
function uiBuildStamp() {
  try {
    return statSync(new URL('../client.js', import.meta.url)).mtime.toISOString()
  } catch {
    return ''
  }
}

/**
 * 读请求体并解析 JSON。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @param {number} [limit] 体积上限。
 * @returns {Promise<object>}
 */
async function readJson(req, limit = 64 * 1024) {
  // 只接受 application/json：跨站表单（text/plain、form-urlencoded）因此进不来
  const type = String(req.headers['content-type'] ?? '').toLowerCase()
  if (type && !type.includes('application/json')) throw new ApiError(415, '请求体必须是 application/json')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new ApiError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ApiError(400, '请求体不是合法 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(400, '请求体必须是 JSON 对象')
  return parsed
}

/**
 * 写 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {number} status 状态码。
 * @param {object} payload 内容。
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** 可推送到微信读书的文件类型。 */
const PUSHABLE = /\.(epub|pdf|mobi|azw3|txt)$/i

/** 译本语言代码到中文名，用于列表文案与推送用的文件名。 */
const LANG_LABELS = {
  zh: '中文',
  en: '英文',
  ja: '日文',
  ko: '韩文',
  fr: '法文',
  de: '德文',
  es: '西班牙文',
  ru: '俄文',
  pt: '葡萄牙文',
  it: '意大利文',
}

/**
 * 列出这本书可推送到微信读书的版本：原书 + 各个译本。
 *
 * 译本来自书目录里的 `book.<lang>.epub`（翻译产物）；原书优先生成的 book.epub，
 * 其次原始 EPUB / PDF。EPUB 源不再复制 book.epub，所以原书可能就是原始文件。
 *
 * @param {string} dir 书目录。
 * @param {object} meta 元数据。
 * @returns {Array<{file:string, label:string, kind:'original'|'translated', lang:string, format:string, bytes:number}>}
 */
function pushCandidates(dir, meta) {
  let files = []
  try { files = readdirSync(dir) } catch { return [] }
  const sizeOf = name => {
    try { return statSync(join(dir, name)).size } catch { return 0 }
  }
  const options = []
  const seen = new Set()
  const add = (file, kind, lang) => {
    if (!file || seen.has(file) || !PUSHABLE.test(file) || !files.includes(file)) return
    seen.add(file)
    const format = String(file.split('.').pop() ?? '').toLowerCase()
    const langLabel = kind === 'translated' ? (LANG_LABELS[lang] || lang || '译文') : ''
    options.push({
      file,
      kind,
      lang,
      format,
      bytes: sizeOf(file),
      label: kind === 'translated' ? `${langLabel}译本（${format.toUpperCase()}）` : `原书（${format.toUpperCase()}）`,
    })
  }

  // 原书：生成的 book.epub > 原始 EPUB/PDF > 目录里任意可推送文件（排除译本）
  const sourceFile = meta.sourceFile && files.includes(meta.sourceFile) ? meta.sourceFile : ''
  const original = files.includes('book.epub')
    ? 'book.epub'
    : (sourceFile && PUSHABLE.test(sourceFile)
      ? sourceFile
      : files.find(name => PUSHABLE.test(name) && !/^book\.[^/\\]+\.[a-z0-9]+$/i.test(name)))
  add(original, 'original', '')

  // 译本：book.zh.epub / book.English.epub 这类，按文件名排序保证稳定
  const translated = files
    .filter(name => /^book\.[^/\\]+\.(epub|pdf|mobi|azw3|txt)$/i.test(name))
    .sort()
  for (const name of translated) {
    const lang = name.replace(/^book\./i, '').replace(/\.(epub|pdf|mobi|azw3|txt)$/i, '')
    add(name, 'translated', lang)
  }
  return options
}

/**
 * 推送到微信读书时用的文件名：译本带上语言，原书 book.epub 用书名。
 * @param {object} option 版本条目。
 * @param {string} title 书名。
 * @returns {string}
 */
function pushUploadName(option, title) {
  if (option.kind === 'translated') {
    const langLabel = LANG_LABELS[option.lang] || option.lang || '译本'
    return `${title}（${langLabel}）.${option.format}`
  }
  if (option.file === 'book.epub') return `${title}.epub`
  return option.file
}

/**
 * 是否可信请求：本机回环，或与当前 Host 同源（用户通过局域网打开 Web UI 的情况）。
 * 这些接口能改书库目录、能写入账号凭据，所以不能无条件放行。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {boolean}
 */
function isTrustedRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true
  const origin = req.headers.origin || req.headers.referer
  const host = req.headers.host
  if (!origin || !host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** 写操作必须带的请求头。跨站 fetch 带自定义头会触发预检，从而被浏览器挡在门外。 */
const CSRF_HEADER = 'x-dsh-ebook'

/** 视为写操作的 HTTP 方法。 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * child 是否在 root 之内（root 自身不算）。
 * 用 relative 而不是 startsWith：`E:\Books-backup` 会被 startsWith('E:\Books') 误判为子路径。
 * @param {string} root 根目录。
 * @param {string} child 子路径。
 * @returns {boolean}
 */
function isInside(root, child) {
  const rel = relative(root, child)
  return rel !== '' && !rel.startsWith('..') && !rel.includes(`..${sep}`)
}

/**
 * 把请求里的书目录名解析成绝对路径。
 * 只接受书库根下的一级目录名：挡掉 `.`、`..` 与带分隔符的名字，避免删库/越界。
 * @param {object} library 书库实例。
 * @param {unknown} value 请求给的值。
 * @returns {string|null} 合法且存在的目录，否则 null。
 */
function resolveBookDir(library, value) {
  const name = String(value ?? '').trim()
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || name.startsWith('.')) return null
  const dir = join(library.root, name)
  if (!isInside(library.root, dir)) return null
  return existsSync(dir) ? dir : null
}

/**
 * 是否为「看起来可以公开访问」的图片地址：只收 https，且不指向本机/内网。
 * `/book/set-cover` 会用服务端去下载，不能让请求方指定任意内网地址。
 * @param {string} value 地址。
 * @returns {boolean}
 */
function isPublicImageUrl(value) {
  let url
  try { url = new URL(String(value)) } catch { return false }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '[::1]') return false
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
  if (/^0\./.test(host) || host.endsWith('.internal')) return false
  return true
}

/**
 * 一个带 HTTP 状态码的错误，供外层统一映射响应。
 */
class ApiError extends Error {
  /**
   * @param {number} status 状态码。
   * @param {string} message 给用户看的说明。
   */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * 校验目录可用且可写。
 * @param {string} dir 路径。
 * @returns {{ok:boolean, message:string}}
 */
function checkDirectory(dir) {
  if (!dir || typeof dir !== 'string') return { ok: false, message: '请填写目录路径' }
  try {
    const stat = statSync(dir)
    if (!stat.isDirectory()) return { ok: false, message: '这个路径不是目录' }
    accessSync(dir, constants.W_OK)
    return { ok: true, message: '可写' }
  } catch (error) {
    if (error.code === 'ENOENT') {
      // 不存在就试着建出来
      try {
        mkdirSync(dir, { recursive: true })
        return { ok: true, message: '目录已创建' }
      } catch (mkdirError) {
        return { ok: false, message: `无法创建目录：${mkdirError.message}` }
      }
    }
    return { ok: false, message: `目录不可用：${error.message}` }
  }
}

/**
 * 注册设置接口。
 * @param {object} ctx 插件上下文。
 * @param {object} deps 依赖。
 * @param {object} deps.settings Settings 实例。
 * @param {() => object} deps.getLibrary 取当前书库。
 * @param {(dir:string) => void} deps.switchLibrary 切换书库。
 * @param {(line:string)=>void} [deps.log] 日志。
 * @returns {() => void} 清理函数。
 */
export function registerSettingsApi(ctx, deps) {
  const {
    settings, getLibrary, switchLibrary, dataDir, llm, log = () => {},
    ai, translateText, localOcr, updateChecker,
  } = deps

  const handler = async (req, res) => {
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { error: '来源不受信任' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.slice(PREFIX.length) || '/'
    const method = (req.method ?? 'GET').toUpperCase()

    // 写操作要求自定义头：浏览器跨站请求带它会触发预检，从而被挡住（CSRF 防护）
    if (WRITE_METHODS.has(method) && req.headers[CSRF_HEADER] !== '1') {
      sendJson(res, 403, { error: '缺少请求头 x-dsh-ebook，拒绝跨站写入' })
      return
    }

    try {
      // 当前状态
      if (path === '/state' && method === 'GET') {
        const library = getLibrary()
        sendJson(res, 200, {
          libraryDir: settings.libraryDir || library.root,
          effectiveDir: library.root,
          version: updateChecker?.status?.().current ?? '',
          platforms: PLATFORMS,
          accounts: settings.listAccounts(),
          books: library.count(),
          uiBuild: uiBuildStamp(),
          translateViaSubagent: settings.translateViaSubagent,
          showSidebarIcon: settings.showSidebarIcon,
          wereadReady: settings.wereadReady,
          // 不回传 refreshToken 本身，只告诉前端有没有存过
          weread: {
            vid: settings.weread.vid,
            deviceId: settings.weread.deviceId,
            hasToken: Boolean(settings.weread.refreshToken),
          },
          // 取书与登录都会走这套网络设置，显示出来便于判断「是不是代理没生效」
          network: {
            proxy: currentProxy(),
            mode: currentProxy() ? 'proxy' : 'direct',
          },
        })
        return
      }

      // ===== 书库界面接口 =====

      // 联网更新书籍简介（微信读书优先，豆瓣兜底）
      if (path === '/book/refresh-summary' && method === 'POST') {
        const body = await readJson(req)
        const dirName = String(body.dir ?? '')
        const library = getLibrary()
        const dir = resolveBookDir(library, dirName)
        if (!dir) {
          sendJson(res, 404, { error: '这本书不在书库里' })
          return
        }
        const meta = library.readMeta(dir)
        try {
          const info = await lookupBookInfo({
            title: meta.title ?? dirName,
            author: meta.creator ?? '',
            credentials: settings.weread,
            signal: AbortSignal.timeout(80_000),
          })
          if (!info) {
            sendJson(res, 404, { error: '没找到这本书的简介，可能是冷门书或书名对不上' })
            return
          }
          // 把查到的信息合并进元数据，简介原文存 description
          library.writeMeta(dir, {
            description: info.intro,
            summarySource: info.source,
            summaryMatchedTitle: info.matchedTitle,
            publisher: info.publisher || meta.publisher || '',
            translator: info.translator || meta.translator || '',
            // 新源没给评分/评分人数时保留旧值，别把已有的评分清成 0
            rating: info.rating || meta.rating || 0,
            ratingCount: info.ratingCount || meta.ratingCount || 0,
            ratingSource: info.rating ? info.source : (meta.ratingSource || ''),
            // 简介变了，之前翻好的中文译本作废
            descriptionZh: '',
          })
          log(`《${dirName}》简介已从${info.source}更新（${info.intro.length} 字）`)
          sendJson(res, 200, {
            ok: true,
            message: `已从${info.source}更新简介（${info.intro.length} 字）`,
            info,
          })
        } catch (error) {
          sendJson(res, 500, { error: `更新简介失败：${error.message}` })
        }
        return
      }

      // 候选封面预览：由 Host 代理下载，避免外链被 CSP / Referer 拦掉
      if (path === '/cover/preview' && method === 'GET') {
        const imageUrl = url.searchParams.get('url') ?? ''
        // 白名单：只代理豆瓣图床，防止被拿来当任意 URL 的跳板
        if (!/^https:\/\/img\d\.doubanio\.com\//i.test(imageUrl)) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('只支持豆瓣图床地址')
          return
        }
        try {
          const response = await httpRequest(imageUrl, {
            timeout: 20_000,
            retries: 1,
            maxRedirects: 3,
            headers: {
              'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              Referer: 'https://book.douban.com/',
              Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            },
          })
          if (!response.ok) {
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end(`图源返回 HTTP ${response.status}`)
            return
          }
          const data = Buffer.from(await response.arrayBuffer())
          const isPng = data[0] === 0x89 && data[1] === 0x50
          const isWebp = data.subarray(0, 4).toString('ascii') === 'RIFF'
          sendImageBuffer(res, data, isPng ? 'image/png' : isWebp ? 'image/webp' : 'image/jpeg')
        } catch (error) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(`预览失败：${error.message}`)
        }
        return
      }

      // 申请扫码登录二维码
      if (path === '/weread/qr/start' && method === 'POST') {
        try {
          const qr = await requestQr(AbortSignal.timeout(40_000))
          const id = randomUUID()
          const session = {
            id,
            uuid: qr.uuid,
            confirmUrl: qr.confirmUrl,
            status: 'waiting',
            message: '等待扫码',
            createdAt: Date.now(),
            expiresAt: Date.now() + 5 * 60_000,
            cancelled: false,
          }
          qrSessions.set(id, session)
          // 清掉过期会话
          for (const [key, value] of qrSessions) {
            if (Date.now() > value.expiresAt + 60_000) qrSessions.delete(key)
          }
          // 后台轮询，不 await
          runQrSession(session, settings, log).catch(error => {
            session.status = 'failed'
            session.message = error.message
          })
          const image = await renderQr(qr.confirmUrl)
          sendJson(res, 200, {
            id,
            image,
            expiresIn: 300,
            message: '用微信扫码，并在手机上确认',
          })
        } catch (error) {
          sendJson(res, 500, { error: `获取二维码失败：${error.message}` })
        }
        return
      }

      // 查询扫码状态
      if (path === '/weread/qr/status' && method === 'GET') {
        const id = url.searchParams.get('id') ?? ''
        const session = qrSessions.get(id)
        if (!session) {
          sendJson(res, 404, { error: '会话不存在或已过期' })
          return
        }
        const remain = Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000))
        sendJson(res, 200, {
          id,
          status: session.status,
          message: session.message,
          remain,
          ready: settings.wereadReady,
          done: session.status === 'done',
        })
        return
      }

      // 取消扫码
      if (path === '/weread/qr/cancel' && method === 'POST') {
        const body = await readJson(req).catch(() => ({}))
        const session = qrSessions.get(String(body.id ?? ''))
        if (session) {
          session.cancelled = true
          session.status = 'cancelled'
        }
        sendJson(res, 200, { ok: true })
        return
      }

      // 删除微信读书凭据
      if (path === '/weread/clear' && method === 'POST') {
        settings.setWeread({ vid: '', refreshToken: '', deviceId: '' })
        // 同时清掉本地登录态缓存（含 weread-omni 导入过的痕迹）
        for (const [key, session] of qrSessions) {
          session.cancelled = true
          qrSessions.delete(key)
        }
        log('微信读书凭据已删除')
        sendJson(res, 200, {
          ok: true,
          weread: { vid: '', deviceId: '', hasToken: false },
          ready: false,
          message: '凭据已删除，推送前需要重新扫码登录',
        })
        return
      }

      // 微信读书凭据
      if (path === '/weread' && method === 'POST') {
        const body = await readJson(req)
        const saved = settings.setWeread(body)
        sendJson(res, 200, {
          ok: true,
          // 不回传 refreshToken：前端只需要知道存过没有
          weread: { vid: saved.vid, deviceId: saved.deviceId, hasToken: Boolean(saved.refreshToken) },
          ready: settings.wereadReady,
          message: settings.wereadReady ? '微信读书凭据已保存' : '凭据不完整：需要 refreshToken 与 deviceId',
        })
        return
      }

      // 可推送的版本列表：原书 + 各译本，供界面选择
      if (path === '/book/push-options' && method === 'GET') {
        const library = getLibrary()
        const dir = resolveBookDir(library, url.searchParams.get('dir'))
        if (!dir) {
          sendJson(res, 404, { error: '这本书不在书库里' })
          return
        }
        const meta = library.readMeta(dir)
        const options = pushCandidates(dir, meta)
        sendJson(res, 200, {
          dir: basename(dir),
          title: meta.title ?? basename(dir),
          translatedTo: meta.translated ?? '',
          options,
        })
        return
      }

      // 推送到微信读书
      if (path === '/book/push-weread' && method === 'POST') {
        const body = await readJson(req)
        const dirName = String(body.dir ?? '')
        const library = getLibrary()
        const dir = resolveBookDir(library, dirName)
        if (!dir) {
          sendJson(res, 404, { error: '这本书不在书库里' })
          return
        }
        if (!settings.wereadReady) {
          sendJson(res, 400, { error: '先在下方的微信读书里填好 refreshToken 与 deviceId' })
          return
        }
        const meta = library.readMeta(dir)
        const options = pushCandidates(dir, meta)
        if (options.length === 0) {
          sendJson(res, 400, { error: '这本书没有可推送的 EPUB/PDF 文件' })
          return
        }
        // 指定了版本就用它；没指定时保持旧行为：原书优先
        const requested = String(body.file ?? '')
        let chosen
        if (requested) {
          chosen = options.find(item => item.file === requested)
          if (!chosen) {
            sendJson(res, 400, {
              error: `没有这个可推送的版本：${requested}`,
              options,
            })
            return
          }
        } else {
          chosen = options.find(item => item.kind === 'original') ?? options[0]
        }
        const task = startTask('weread', dirName)
        if (!task) {
          sendJson(res, 409, { error: '这本书正在推送，请等当前任务结束' })
          return
        }
        const uploadName = pushUploadName(chosen, meta.title || dirName)
        task.push(`准备推送 ${chosen.label}：${uploadName}`)
        pushToWeread({
          bytes: readFileSync(join(dir, chosen.file)),
          filename: uploadName,
          credentials: settings.weread,
          signal: AbortSignal.timeout(10 * 60_000),
        })
          .then(result => finishTask(task.id, { status: 'done', result }))
          .catch(error => finishTask(task.id, { status: 'failed', message: error.message }))
        sendJson(res, 202, {
          ok: true,
          taskId: task.id,
          file: chosen.file,
          label: chosen.label,
          message: `已开始推送到微信读书（${chosen.label}）`,
        })
        return
      }

      // 用系统默认程序打开原始文件
      if (path === '/book/open' && method === 'POST') {
        const body = await readJson(req)
        const dirName = String(body.dir ?? '')
        const library = getLibrary()
        const dir = resolveBookDir(library, dirName)
        if (!dir) {
          sendJson(res, 404, { error: '这本书不在书库里' })
          return
        }
        const meta = library.readMeta(dir)
        let files = []
        try { files = readdirSync(dir) } catch { /* 目录被外部删掉 */ }
        // 优先原始文件，其次生成的成品
        const candidates = [
          meta.sourceFile,
          files.find(f => /\.(pdf|epub|mobi|azw3)$/i.test(f) && f !== 'book.epub'),
          files.find(f => /\.(pdf|epub|mobi|azw3)$/i.test(f)),
          files.includes('book.md') ? 'book.md' : null,
        ].filter(Boolean)
        const target = candidates.map(f => join(dir, f)).find(p => existsSync(p))
        if (!target) {
          sendJson(res, 400, { error: '这本书没有可打开的文件' })
          return
        }
        try {
          const { spawn } = await import('node:child_process')
          const command = process.platform === 'win32'
            // start 的第一个引号参数是窗口标题，必须留空
            ? ['cmd', ['/c', 'start', '', target]]
            : process.platform === 'darwin'
              ? ['open', [target]]
              : ['xdg-open', [target]]
          const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' })
          // spawn 的失败是异步 error 事件，try/catch 抓不到
          child.on('error', error => log(`打开文件失败：${error.message}`))
          child.unref()
          sendJson(res, 200, { ok: true, message: `已打开 ${basename(target)}`, path: target })
        } catch (error) {
          sendJson(res, 500, { error: `打开失败：${error.message}` })
        }
        return
      }

      // 联网找封面：返回候选列表供选择
      if (path === '/book/find-cover' && method === 'POST') {
        const body = await readJson(req)
        const dirName = String(body.dir ?? '')
        const library = getLibrary()
        const dir = resolveBookDir(library, dirName)
        if (!dir) {
          sendJson(res, 404, { error: '这本书不在书库里' })
          return
        }
        const meta = library.readMeta(dir)
        try {
          const covers = await findCovers({
            title: meta.title ?? dirName,
            author: meta.creator ?? '',
            signal: AbortSignal.timeout(40_000),
          })
          sendJson(res, 200, {
            covers,
            query: [meta.title ?? dirName, meta.creator].filter(Boolean).join(' '),
          })
        } catch (error) {
          sendJson(res, 500, { error: `搜索封面失败：${error.message}` })
        }
        return
      }

      // 选定一张封面并保存
      if (path === '/book/set-cover' && method === 'POST') {
        const body = await readJson(req)
        const dirName = String(body.dir ?? '')
        const imageUrl = String(body.url ?? '')
        const library = getLibrary()
        const dir = resolveBookDir(library, dirName)
        if (!dir) {
          sendJson(res, 404, { error: '这本书不在书库里' })
          return
        }
        // 服务端会去下载这个地址，只接受公网 https，挡掉内网/本机
        if (!isPublicImageUrl(imageUrl)) {
          sendJson(res, 400, { error: '图片地址无效（只支持 https 公网地址）' })
          return
        }
        // 先落到临时名：下载或校验失败时旧封面原样保留
        const temp = join(dir, 'cover.download')
        let result
        try {
          result = await downloadCover({
            url: imageUrl,
            targetPath: temp,
            signal: AbortSignal.timeout(60_000),
          })
        } catch (error) {
          sendJson(res, 500, { error: `保存封面失败：${error.message}` })
          return
        }
        const ext = result.mediaType === 'image/png' ? 'png' : result.mediaType === 'image/webp' ? 'webp' : 'jpg'
        // 清掉其它格式的旧封面，保证书目录里只有一个 cover.*
        for (const old of ['jpg', 'jpeg', 'png', 'webp', 'gif']) {
          const path2 = join(dir, `cover.${old}`)
          if (existsSync(path2)) rmSync(path2, { force: true })
        }
        try {
          renameSync(temp, join(dir, `cover.${ext}`))
        } catch (error) {
          sendJson(res, 500, { error: `封面落盘失败：${error.message}` })
          return
        }
        log(`《${dirName}》封面已更新（${Math.round(result.bytes / 1024)}KB）`)
        sendJson(res, 200, {
          ok: true,
          message: `封面已更新（${Math.round(result.bytes / 1024)}KB）`,
          ext,
        })
        return
      }

      // 书籍列表
      if (path === '/books' && method === 'GET') {
        const library = getLibrary()
        const books = []
        for (const entry of readdirSync(library.root, { withFileTypes: true })) {
          // 跳过缓存与插件的私有数据目录
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue
          const card = bookCard(library.root, entry.name, library)
          if (card) books.push(card)
        }
        books.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
        sendJson(res, 200, { root: library.root, count: books.length, books })
        return
      }

      // 封面图
      if (path === '/cover' && method === 'GET') {
        const library = getLibrary()
        const dir = resolveBookDir(library, url.searchParams.get('dir'))
        if (!dir) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('未找到')
          return
        }
        let cover = ''
        try {
          cover = readdirSync(dir).find(f => /^cover\.(jpg|jpeg|png|webp|gif)$/i.test(f)) ?? ''
        } catch { /* 目录被外部删掉 */ }
        if (!cover) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('无封面')
          return
        }
        sendFile(res, join(dir, cover))
        return
      }

      // 单本书详情
      if (path === '/book' && method === 'GET') {
        const library = getLibrary()
        const dirName = String(url.searchParams.get('dir') ?? '')
        const dir = resolveBookDir(library, dirName)
        if (!dir) {
          sendJson(res, 404, { error: '这本书不在书库里' })
          return
        }
        const card = bookCard(library.root, dirName, library)
        if (!card) {
          sendJson(res, 404, { error: '书目录不完整' })
          return
        }
        sendJson(res, 200, card)
        return
      }

      // 删除一本书
      if (path === '/book/delete' && method === 'POST') {
        const body = await readJson(req)
        const dirName = String(body.dir ?? '')
        const library = getLibrary()
        const dir = resolveBookDir(library, dirName)
        if (!dir) {
          sendJson(res, 404, { error: '这本书不在书库里' })
          return
        }
        if (body.confirm !== true) {
          sendJson(res, 400, { error: '需要 confirm: true 才会真的删除' })
          return
        }
        rmSync(dir, { recursive: true, force: true })
        log(`已删除《${dirName}》`)
        sendJson(res, 200, { ok: true, message: `已删除《${dirName}》` })
        return
      }

      // 翻译简介（外文简介转中文）
      if (path === '/book/summary' && method === 'POST') {
        const body = await readJson(req)
        const dirName = String(body.dir ?? '')
        const library = getLibrary()
        const dir = resolveBookDir(library, dirName)
        if (!dir) {
          sendJson(res, 404, { error: '这本书不在书库里' })
          return
        }
        const meta = library.readMeta(dir)
        const description = String(meta.description ?? '').trim()
        if (!description) {
          sendJson(res, 400, { error: '这本书没有简介可翻' })
          return
        }
        if (!translateText || !ai) {
          sendJson(res, 503, { error: '当前环境缺少翻译能力' })
          return
        }
        try {
          const translated = await translateText(ai, description, {
            target: '简体中文',
            signal: AbortSignal.timeout(120_000),
          })
          library.writeMeta(dir, { descriptionZh: translated })
          sendJson(res, 200, { ok: true, descriptionZh: translated })
        } catch (error) {
          sendJson(res, 500, { error: `简介翻译失败：${error.message}` })
        }
        return
      }

      // 列出后台任务（进行中的 + 最近完成的），用于面板重开后恢复进度
      if (path === '/book/tasks' && method === 'GET') {
        const dirFilter = url.searchParams.get('dir') ?? ''
        const all = [...backgroundTasks.values()]
          .filter(task => (dirFilter ? task.dir === dirFilter : true))
          .sort((a, b) => b.startedAt - a.startedAt)
          .map(taskView)
        sendJson(res, 200, {
          tasks: all,
          running: all.filter(task => task.status === 'running').length,
        })
        return
      }

      // 校验目录（保存前的即时反馈）
      if (path === '/check-dir' && method === 'POST') {
        const body = await readJson(req)
        sendJson(res, 200, checkDirectory(String(body.dir ?? '')))
        return
      }

      // 切换下载目录
      if (path === '/library' && method === 'POST') {
        const body = await readJson(req)
        // 必须挡住非字符串：String({}) 会得到 "[object Object]"，
        // 那会当成合法路径存进配置，把书库目录彻底弄坏。
        if (typeof body.dir !== 'string') {
          sendJson(res, 400, { error: '目录参数必须是字符串路径' })
          return
        }
        const dir = body.dir.trim()
        if (!dir) {
          sendJson(res, 400, { error: '请填写目录路径' })
          return
        }
        const check = checkDirectory(dir)
        if (!check.ok) {
          sendJson(res, 400, { error: check.message })
          return
        }
        settings.setLibraryDir(dir)
        switchLibrary(dir)
        log(`书库目录已切换为 ${dir}`)
        sendJson(res, 200, { ok: true, message: check.message, libraryDir: dir })
        return
      }

      // 切换侧栏图标显示
      if (path === '/sidebar-icon' && method === 'POST') {
        const body = await readJson(req)
        if (typeof body.show !== 'boolean') {
          sendJson(res, 400, { error: 'show 必须是布尔值' })
          return
        }
        const saved = settings.setShowSidebarIcon(body.show)
        sendJson(res, 200, {
          ok: true,
          showSidebarIcon: saved,
          message: saved ? '已开启，重启 DSH 后出现' : '已关闭，重启 DSH 后消失',
        })
        return
      }

      // 切换翻译执行方式（直接调用 / 子代理）
      if (path === '/translate-mode' && method === 'POST') {
        const body = await readJson(req)
        if (typeof body.viaSubagent !== 'boolean') {
          sendJson(res, 400, { error: 'viaSubagent 必须是布尔值' })
          return
        }
        const saved = settings.setTranslateViaSubagent(body.viaSubagent)
        sendJson(res, 200, {
          ok: true,
          viaSubagent: saved,
          message: saved
            ? '翻译将交给子代理执行：独立会话，主对话不参与正文，速度较慢'
            : '翻译回到直接调用：更快，模型在插件内部一次请求完成',
        })
        return
      }

      // 列出可用模型，并带上当前按用途的指定
      if (path === '/models' && method === 'GET') {
        const flat = []
        try {
          const providers = llm?.listProviders?.() ?? []
          for (const provider of providers) {
            let models = []
            try {
              models = await llm.listModels(provider.id)
            } catch { /* 单个 provider 列不出就跳过 */ }
            for (const model of models) {
              flat.push({
                provider: provider.id,
                providerName: provider.name ?? provider.id,
                model: model.id,
                modelName: model.name ?? model.id,
                // 明确标注是否接受图片：OCR 只能选支持图片的
                image: Array.isArray(model.inputModalities)
                  ? model.inputModalities.includes('image')
                  : null,
              })
            }
          }
        } catch (error) {
          log(`列举模型失败：${error.message}`)
        }
        sendJson(res, 200, { models: flat, current: settings.allModels() })
        return
      }

      // 保存某个用途的模型指定
      if (path === '/models' && method === 'POST') {
        const body = await readJson(req)
        const role = String(body.role ?? '')
        if (!['ocr', 'translate', 'read'].includes(role)) {
          sendJson(res, 400, { error: '用途只能是 ocr、translate 或 read' })
          return
        }
        const value = body.value && typeof body.value === 'object' ? body.value : {}
        const saved = settings.setModel(role, {
          provider: String(value.provider ?? ''),
          model: String(value.model ?? ''),
        })
        sendJson(res, 200, { ok: true, model: saved })
        return
      }

      // ===== 本地 OCR（Xiaomi-OCR-0）=====

      // 状态：安装情况 / 下载进度 / 服务是否在跑
      if (path === '/ocr/local' && method === 'GET') {
        if (!localOcr) {
          sendJson(res, 503, { error: '当前环境没有本地 OCR 能力' })
          return
        }
        sendJson(res, 200, localOcr.status())
        return
      }

      // 开关 / 识别模式
      if (path === '/ocr/local' && method === 'POST') {
        if (!localOcr) {
          sendJson(res, 503, { error: '当前环境没有本地 OCR 能力' })
          return
        }
        const body = await readJson(req)
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
          sendJson(res, 400, { error: 'enabled 必须是布尔值' })
          return
        }
        if (body.mode !== undefined && !['text', 'document'].includes(String(body.mode))) {
          sendJson(res, 400, { error: 'mode 只能是 text 或 document' })
          return
        }
        if (typeof body.enabled === 'boolean') localOcr.setEnabled(body.enabled)
        if (body.mode !== undefined) localOcr.setMode(String(body.mode))
        const status = localOcr.status()
        // 提示按「这次改了什么」给，改模式时不要回一句「已启用」
        let message = ''
        if (typeof body.enabled === 'boolean') {
          message = status.enabled
            ? (status.ready ? '已启用本地模型' : '已启用，但模型还没下载')
            : '已关闭本地模型，OCR 回到视觉模型'
        } else if (body.mode !== undefined) {
          message = status.mode === 'document'
            ? '已切换为整页 Markdown 解析（表格 OTSL、公式 LaTeX）'
            : '已切换为纯文本识别'
        } else {
          message = '本地 OCR 设置已更新'
        }
        sendJson(res, 200, { ...status, message })
        return
      }

      // 下载模型 + 运行库（后台跑，前端轮询 /ocr/local 看进度）
      if (path === '/ocr/local/download' && method === 'POST') {
        if (!localOcr) {
          sendJson(res, 503, { error: '当前环境没有本地 OCR 能力' })
          return
        }
        try {
          const result = localOcr.startDownload()
          sendJson(res, 202, { ok: true, ...result, status: localOcr.status() })
        } catch (error) {
          sendJson(res, 400, { error: error.message })
        }
        return
      }

      // 取消下载
      if (path === '/ocr/local/cancel' && method === 'POST') {
        if (!localOcr) {
          sendJson(res, 503, { error: '当前环境没有本地 OCR 能力' })
          return
        }
        const cancelled = localOcr.cancelDownload()
        sendJson(res, 200, { ok: true, cancelled, status: localOcr.status() })
        return
      }

      // 删除模型与运行库
      if (path === '/ocr/local/delete' && method === 'POST') {
        if (!localOcr) {
          sendJson(res, 503, { error: '当前环境没有本地 OCR 能力' })
          return
        }
        const body = await readJson(req).catch(() => ({}))
        if (body.confirm !== true) {
          sendJson(res, 400, { error: '需要 confirm: true 才会删除' })
          return
        }
        const result = await localOcr.remove()
        sendJson(res, 200, { ok: true, ...result, status: localOcr.status() })
        return
      }

      // ===== 检查更新 =====

      // 只回缓存，不主动联网：联网只发生在用户点「检查更新」时
      if (path === '/update' && method === 'GET') {
        if (!updateChecker) {
          sendJson(res, 503, { error: '当前环境没有更新检查能力' })
          return
        }
        sendJson(res, 200, updateChecker.status())
        return
      }

      // 强制检查一次（按钮）
      if (path === '/update/check' && method === 'POST') {
        if (!updateChecker) {
          sendJson(res, 503, { error: '当前环境没有更新检查能力' })
          return
        }
        const status = await updateChecker.check({ force: true })
        sendJson(res, 200, status)
        return
      }

      // 查询所有 Z-Library 账号的今日配额（eAPI 直接给，不用本地猜）
      if (path === '/accounts/quotas' && method === 'GET') {
        const accounts = settings.rawAccounts()
          .filter(item => item.platform === 'zlibrary' && item.cookie)
        const quotas = await Promise.all(accounts.map(async item => {
          const profile = await fetchZlibProfile({
            host: item.domain,
            cookie: item.cookie,
            signal: AbortSignal.timeout(25_000),
          })
          return {
            id: item.id,
            email: item.email,
            domain: item.domain || '',
            ok: profile.ok,
            message: profile.message,
            name: profile.name,
            downloadsToday: profile.downloadsToday,
            downloadsLimit: profile.downloadsLimit,
            remaining: profile.remaining,
            isPremium: profile.isPremium,
            expires: profile.expires,
          }
        }))
        sendJson(res, 200, { quotas })
        return
      }

      // 书源可达性检测
      if (path === '/sources/probe' && method === 'POST') {
        const account = settings.accountFor('zlibrary')
        const report = await probeSources({
          zlib: { domain: account?.domain || '', cookie: account?.cookie || '' },
          signal: AbortSignal.timeout(90_000),
        })
        sendJson(res, 200, report)
        return
      }

      // 探测 Z-Library 域名是否可用（不登录）
      if (path === '/zlibrary/probe' && method === 'POST') {
        const body = await readJson(req)
        const result = await probeDomain({
          domain: String(body.domain ?? ''),
          cookie: body.cookie ? String(body.cookie) : undefined,
          signal: AbortSignal.timeout(40_000),
        })
        sendJson(res, 200, result)
        return
      }

      // 新增账号
      if (path === '/accounts' && method === 'POST') {
        const body = await readJson(req)
        const account = settings.addAccount(body)
        sendJson(res, 200, { ok: true, account })
        return
      }

      // 单账号操作：/accounts/:id 或 /accounts/:id/login
      const accountMatch = /^\/accounts\/([^/]+)(?:\/(login|verify))?$/.exec(path)
      if (accountMatch) {
        const id = decodeURIComponent(accountMatch[1])
        const action = accountMatch[2]
        const raw = settings.rawAccounts().find(item => item.id === id)
        if (!raw) {
          sendJson(res, 404, { error: '账号不存在' })
          return
        }

        if (!action && method === 'PATCH') {
          const body = await readJson(req)
          const account = settings.updateAccount(id, body)
          sendJson(res, 200, { ok: true, account })
          return
        }
        if (!action && method === 'DELETE') {
          settings.removeAccount(id)
          sendJson(res, 200, { ok: true })
          return
        }

        if (action === 'login' && method === 'POST') {
          const body = await readJson(req)
          // 请求里没带密码时回退到账号已保存的密码。
          // 注意不能用 ??：空串不会触发回退，会导致「明明存了密码却还要再输一次」。
          const submitted = typeof body.password === 'string' ? body.password.trim() : ''
          const password = submitted || String(raw.password ?? '')
          if (!password) {
            sendJson(res, 400, { ok: false, message: '账号没有保存密码，请先填写密码再登录' })
            return
          }
          const result = await loginZlibrary({
            email: raw.email,
            password,
            domain: String(body.domain ?? raw.domain ?? ''),
            signal: AbortSignal.timeout(60_000),
          })
          settings.updateAccount(id, {
            status: result.ok ? (result.searchOk ? 'ok' : 'login-only') : 'failed',
            note: result.message,
            ...(result.cookie ? { cookie: result.cookie } : {}),
          })
          sendJson(res, 200, { ok: result.ok, message: result.message, searchOk: result.searchOk })
          return
        }

        if (action === 'verify' && method === 'POST') {
          const result = await verifyZlibraryCookie({
            domain: raw.domain,
            cookie: raw.cookie,
            signal: AbortSignal.timeout(30_000),
          })
          settings.updateAccount(id, { status: result.ok ? 'ok' : 'failed', note: result.message })
          sendJson(res, 200, { ok: result.ok, message: result.message })
          return
        }
      }

      sendJson(res, 404, { error: `未知接口 ${method} ${path}` })
    } catch (error) {
      // 参数类错误用自身状态码，其余当内部错误（细节写日志，不回显堆栈）
      if (error instanceof ApiError) {
        sendJson(res, error.status, { error: error.message })
        return
      }
      log(`${method} ${path} 失败：${error.message}`)
      sendJson(res, 500, { error: error.message })
    }
  }

  return ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler })
}

/** 接口前缀（供文档与调试使用）。 */
const API_PREFIX = PREFIX
