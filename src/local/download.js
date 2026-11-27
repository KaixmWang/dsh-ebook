/**
 * 大文件下载：流式落盘、断点续传、进度回调。
 *
 * 模型是几百 MB 的 GGUF，不能用 arrayBuffer 一把拉进内存；这里直接接 undici 的响应流，
 * 边下边写 `.part`，断了下次带 `Range` 续传，下完再改名成正式文件。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { request } from '../http.js'

/** 单次尝试的最大重试次数。 */
const MAX_ATTEMPTS = 3

/**
 * 计算文件的 sha256（用于校验模型）。
 * @param {string} path 文件路径。
 * @returns {Promise<string>}
 */
export async function sha256File(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      callback()
    },
  }))
  return hash.digest('hex')
}

/**
 * 下载一个文件到本地，支持续传与进度回调。
 * @param {object} params 参数。
 * @param {string} params.url 地址。
 * @param {string} params.dest 目标路径。
 * @param {number} [params.expectedBytes] 期望字节数（给了就校验）。
 * @param {string} [params.sha256] 期望的 sha256（给了就校验）。
 * @param {AbortSignal} [params.signal] 取消信号。
 * @param {(info:{received:number,total:number})=>void} [params.onProgress] 进度回调。
 * @returns {Promise<{path:string, bytes:number}>}
 */
export async function downloadToFile(params) {
  const { url, dest, expectedBytes = 0, sha256, signal, onProgress } = params
  mkdirSync(dirname(dest), { recursive: true })
  const part = `${dest}.part`

  // 已经下好的文件：大小对得上就直接复用，避免重复下载
  if (existsSync(dest)) {
    const size = statSync(dest).size
    if ((!expectedBytes || size === expectedBytes) && (!sha256 || await sha256File(dest) === sha256)) {
      onProgress?.({ received: size, total: size })
      return { path: dest, bytes: size }
    }
    rmSync(dest, { force: true })
  }

  let lastError
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('已取消')
    const existing = existsSync(part) ? statSync(part).size : 0
    const headers = existing > 0 ? { Range: `bytes=${existing}-` } : {}
    try {
      const response = await request(url, {
        signal,
        timeout: 120_000,
        retries: 1,
        maxRedirects: 6,
        headers,
      })
      if (response.status === 416) {
        // Range 越界：多半是 .part 已经下完，清掉重来
        rmSync(part, { force: true })
        continue
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const append = existing > 0 && response.status === 206
      let received = append ? existing : 0
      const declared = Number(response.headers.get('content-length') ?? 0)
      const total = declared > 0 ? declared + (append ? existing : 0) : (expectedBytes || 0)

      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length
          onProgress?.({ received, total })
          callback(null, chunk)
        },
      })

      await pipeline(
        Readable.fromWeb(response.body),
        meter,
        createWriteStream(part, { flags: append ? 'a' : 'w' }),
        { signal },
      )

      const size = statSync(part).size
      if (expectedBytes && size !== expectedBytes) throw new Error(`大小不符（${size}/${expectedBytes}）`)
      if (sha256) {
        const actual = await sha256File(part)
        if (actual !== sha256) {
          rmSync(part, { force: true })
          throw new Error('sha256 校验失败')
        }
      }
      renameSync(part, dest)
      return { path: dest, bytes: size }
    } catch (error) {
      lastError = error
      if (signal?.aborted) throw signal.reason ?? error
      if (/sha256 校验失败/.test(error.message)) throw error
      // 带着 .part 重试，能续传就续传
    }
  }
  throw lastError ?? new Error(`下载失败：${url}`)
}
