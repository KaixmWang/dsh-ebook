/**
 * 稳健下载器。
 *
 * 核心思路借自 libgen-mcp：**不设全局超时**。慢但在动的传输不该被杀掉，
 * 只有「连续一段时间没有新字节」才算死连接。配合 .part 文件做 Range 续传、
 * 下完校验 MD5、原子重命名。
 *
 * 另外把「拿到第一个字节」和「传完整个文件」分成两件事：
 * 启动失败值得重试很多次（每次重新解析，能刷新过期的下载 key），
 * 而一旦字节开始流动就只受 stall guard 约束。
 */
import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { httpFetch, filenameFromHeaders } from '../http.js'

/** 启动阶段重试间隔（毫秒）。镜像内部只做少量重试，换源由上层负责。 */
const START_RETRY_WAITS = [1_000, 3_000]

/** 连续多久没有新字节判定为死连接。慢速传输每收到一个字节就重置这个窗口。 */
const STALL_TIMEOUT_MS = 45_000

/**
 * 判断响应体是不是 HTML 错误页（镜像挂掉时常返回 200 + 网页）。
 * @param {Uint8Array} head 响应体开头若干字节。
 * @returns {boolean}
 */
export function looksLikeHtml(head) {
  const text = Buffer.from(head.subarray(0, 512)).toString('latin1').trim().toLowerCase()
  return text.startsWith('<!doctype') || text.startsWith('<html') || /<head[\s>]|<body[\s>]/.test(text.slice(0, 200))
}

/**
 * 带 stall guard 地把响应体写进文件，同时计算 MD5。
 * 用 stream pipeline 而不是手动 read 循环：实测同一文件 24 KB/s vs 18 KB/s。
 * @param {Response} response fetch 响应。
 * @param {string} partPath 目标 .part 路径。
 * @param {object} options 选项。
 * @returns {Promise<{bytes:number, md5:string}>}
 */
async function streamToFile(response, partPath, options = {}) {
  const { append = false, maxBytes = Infinity, signal, onProgress } = options
  const hash = createHash('md5')

  // 续传时先把已有字节吃进哈希，保证最终摘要覆盖整个文件
  let received = 0
  if (append && existsSync(partPath)) {
    received = statSync(partPath).size
    if (received > 0) {
      await new Promise((resolve, reject) => {
        createReadStream(partPath)
          .on('data', chunk => hash.update(chunk))
          .on('end', resolve)
          .on('error', reject)
      })
    }
  }

  // 总长度要在进度回调里用，先算好（Content-Length 是本次响应的，续传要加上已有字节）
  const declared = Number(response.headers.get('content-length') ?? 0)
  const total = declared > 0 ? declared + received : 0

  let lastActivity = Date.now()
  let firstChunkChecked = received > 0
  const controller = new AbortController()

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      if (!firstChunkChecked) {
        firstChunkChecked = true
        if (looksLikeHtml(chunk)) {
          callback(new Error('镜像返回的是网页而不是文件（下载链接已失效）'))
          return
        }
      }
      received += chunk.length
      if (received > maxBytes) {
        callback(new Error(`文件超过体积上限 ${maxBytes}`))
        return
      }
      hash.update(chunk)
      lastActivity = Date.now()
      onProgress?.({ received, total })
      callback(null, chunk)
    },
  })

  // stall guard：连续 STALL_TIMEOUT_MS 没有新字节才中止；字节在流动就让它继续
  const guard = setInterval(() => {
    if (Date.now() - lastActivity > STALL_TIMEOUT_MS) controller.abort(new Error('传输停滞'))
  }, 1_000)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) signal.addEventListener('abort', onAbort, { once: true })

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      createWriteStream(partPath, { flags: append ? 'a' : 'w' }),
      { signal: controller.signal },
    )
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error(`传输停滞超过 ${STALL_TIMEOUT_MS / 1000} 秒`)
    }
    throw error
  } finally {
    clearInterval(guard)
    signal?.removeEventListener('abort', onAbort)
  }

  return { bytes: received, md5: hash.digest('hex') }
}

/**
 * 下载一个文件，带启动重试、续传与校验。
 * @param {object} params 参数。
 * @param {() => Promise<{url:string, headers?:Record<string,string>}>} params.resolve 每次调用都重新解析直链（用于刷新过期 key）。
 * @param {string} params.destPath 最终落盘路径。
 * @param {string} [params.expectedMd5] 期望的 MD5，下完比对。
 * @param {number} [params.maxBytes] 体积上限。
 * @param {AbortSignal} [params.signal] 取消信号。
 * @param {(info:object)=>void} [params.onProgress] 进度回调。
 * @param {(line:string)=>void} [params.log] 日志。
 * @returns {Promise<{path:string, bytes:number, md5:string, resumed:boolean, verified:boolean, filename:string}>}
 */
export async function downloadFile(params) {
  const { resolve, destPath, expectedMd5, maxBytes = Infinity, signal, onProgress, log = () => {} } = params
  const partPath = `${destPath}.part`
  mkdirSync(dirname(destPath), { recursive: true })

  let resumed = false
  let lastError

  for (let attempt = 0; attempt <= START_RETRY_WAITS.length; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('已取消')
    try {
      // 每次尝试都重新解析直链：镜像给的 key 会过期
      const target = await resolve()
      const existing = existsSync(partPath) ? statSync(partPath).size : 0
      const headers = { ...(target.headers ?? {}) }
      if (existing > 0) headers.Range = `bytes=${existing}-`

      const response = await httpFetch(target.url, { headers, signal, redirect: 'follow' })

      // 206：从断点续传；200：服务端不支持断点，从头来
      let append = false
      if (existing > 0 && response.status === 206) {
        append = true
        resumed = true
      } else if (response.status === 200) {
        if (existing > 0) log('镜像不支持断点续传，从头下载')
      } else if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      if (!append && !response.ok) throw new Error(`HTTP ${response.status}`)

      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared && declared + (append ? existing : 0) > maxBytes) {
        throw new Error(`文件体积 ${declared} 超过上限 ${maxBytes}`)
      }

      const result = await streamToFile(response, partPath, {
        append,
        maxBytes,
        signal,
        // 统一按 { received, total } 回调，total 由 streamToFile 内部按 Content-Length 计算
        onProgress,
      })

      if (expectedMd5 && result.md5.toLowerCase() !== expectedMd5.toLowerCase()) {
        rmSync(partPath, { force: true })
        throw new Error(`MD5 校验失败（期望 ${expectedMd5}，实际 ${result.md5}）`)
      }

      // 原子落位：同目录 rename，避免半截文件被当成成品
      renameSync(partPath, destPath)
      return {
        path: destPath,
        bytes: result.bytes,
        md5: result.md5,
        resumed,
        verified: Boolean(expectedMd5),
        // 服务器给的文件名，用于落库时保留原名；取不到由上层回退到书名
        filename: filenameFromHeaders(response.headers),
      }
    } catch (error) {
      lastError = error
      if (signal?.aborted) throw signal.reason ?? error
      // 校验失败说明拿到的内容不对，重试同一个源意义不大
      if (/MD5 校验失败|网页而不是文件|体积上限/.test(error.message)) throw error
      if (attempt >= START_RETRY_WAITS.length) break
      const wait = START_RETRY_WAITS[attempt]
      log(`下载未成功（${error.message}），${wait / 1000}s 后重试第 ${attempt + 2} 次`)
      await new Promise(resolve => setTimeout(resolve, wait))
    }
  }

  // 保留 .part 供下次续传，除非它已经明显无用
  throw lastError ?? new Error('下载失败')
}

/**
 * 清理残留的半成品。
 * @param {string} destPath 目标路径。
 */
export function sweepPartial(destPath) {
  const partPath = `${destPath}.part`
  if (existsSync(partPath)) rmSync(partPath, { force: true })
}
