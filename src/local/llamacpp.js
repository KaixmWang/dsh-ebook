/**
 * 本地 OCR 运行时：llama.cpp（llama-server）+ Xiaomi-OCR-0 的 GGUF 权重。
 *
 * 为什么选这条路：插件跑在 Node 里，没有 PyTorch，也装不动 transformers 那一套；
 * 而社区已经把这颗 0.8B 的视觉语言模型转成了 GGUF（配套 mmproj 视觉投影器），
 * llama.cpp 的 llama-server 自带 OpenAI 兼容接口，能直接吃 base64 图片。
 * 于是「下载模型」= 下 GGUF + 下 24MB 的 CPU 版 llama.cpp，进度和删除都由插件自己管。
 *
 * 目录布局（都在 $DSH_HOME/dsh-ebook 下，删起来干净）：
 *   models/xiaomi-ocr-0/Xiaomi-OCR-0.Q4_K_M.gguf + .mmproj-bf16.gguf + manifest.json
 *   runtime/llama-<version>/llama-server.exe + *.dll
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { getText } from '../http.js'
import { readZip } from '../zip.js'
import { downloadToFile } from './download.js'

/** 模型仓库与权重文件（社区转换版，Apache-2.0 原模型 + MIT 转换脚本）。 */
export const MODEL_INFO = {
  id: 'xiaomi-ocr-0',
  label: 'Xiaomi-OCR-0',
  params: '0.8B',
  repo: 'prithivMLmods/Xiaomi-OCR-0-GGUF',
  files: ['Xiaomi-OCR-0.Q4_K_M.gguf', 'Xiaomi-OCR-0.mmproj-bf16.gguf'],
}

/** llama.cpp 的 CPU 运行时（Windows x64）。 */
export const RUNTIME_INFO = {
  version: 'b12800',
  win32: `https://github.com/ggml-org/llama.cpp/releases/download/b12800/llama-b12800-bin-win-cpu-x64.zip`,
}

/** HF 镜像：国内直连 huggingface.co 常被墙，先试镜像再试官方。 */
const HF_ENDPOINTS = ['https://hf-mirror.com', 'https://huggingface.co']

/** 服务空闲多久后自动关掉，把内存还给系统。 */
const IDLE_STOP_MS = 10 * 60_000

/** 首次加载模型最多等多久。 */
const START_TIMEOUT_MS = 180_000

/** 识别一页最多等多久（CPU 推理，慢机器要给足）。 */
const OCR_TIMEOUT_MS = 180_000

/** 两种识别模式的提示词，取自模型卡。 */
const PROMPTS = {
  text: 'Extract the text in the image. Keep the reading order and paragraph breaks.',
  document: 'Extract all information from the main body of the document image and represent it in markdown format, '
    + 'ignoring headers and footers. Tables should be expressed in OTSL format, formulas in the document should be '
    + 'represented using LATEX format, and the parsing should be organized according to the reading order.',
}

/**
 * 本地文件的路径约定。
 * @param {string} dataDir 插件数据目录（$DSH_HOME/dsh-ebook）。
 * @returns {{modelDir:string, runtimeDir:string, manifest:string, modelFile:string, mmprojFile:string}}
 */
export function localPaths(dataDir) {
  const modelDir = join(dataDir, 'models', MODEL_INFO.id)
  const runtimeDir = join(dataDir, 'runtime', `llama-${RUNTIME_INFO.version}`)
  return {
    modelDir,
    runtimeDir,
    manifest: join(modelDir, 'manifest.json'),
    modelFile: join(modelDir, MODEL_INFO.files[0]),
    mmprojFile: join(modelDir, MODEL_INFO.files[1]),
  }
}

/**
 * llama-server 可执行文件名。
 * @returns {string}
 */
function serverExeName() {
  return process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
}

/**
 * 运行时是否已经下好。
 * @param {ReturnType<typeof localPaths>} paths 路径。
 * @returns {{installed:boolean, exe:string, bytes:number, version:string}}
 */
export function runtimeStatus(paths) {
  const exe = join(paths.runtimeDir, serverExeName())
  const installed = existsSync(exe)
  let bytes = 0
  if (existsSync(paths.runtimeDir)) {
    for (const name of readdirSync(paths.runtimeDir)) {
      try { bytes += statSync(join(paths.runtimeDir, name)).size } catch { /* 忽略 */ }
    }
  }
  return { installed, exe: installed ? exe : '', bytes, version: RUNTIME_INFO.version }
}

/**
 * 模型是否已经下好（两个文件都在、且有 manifest）。
 * @param {ReturnType<typeof localPaths>} paths 路径。
 * @returns {{installed:boolean, bytes:number, files:string[], installedAt:string}}
 */
export function modelStatus(paths) {
  const files = []
  let bytes = 0
  for (const name of MODEL_INFO.files) {
    const file = join(paths.modelDir, name)
    if (!existsSync(file)) continue
    files.push(name)
    try { bytes += statSync(file).size } catch { /* 忽略 */ }
  }
  let installedAt = ''
  try { installedAt = JSON.parse(readFileSync(paths.manifest, 'utf8')).installedAt ?? '' } catch { /* 没有 manifest */ }
  return { installed: files.length === MODEL_INFO.files.length, bytes, files, installedAt }
}

/**
 * 在镜像/官方之间挑一个能拿到元数据的端点。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<{base:string, files:Map<string,{size:number, sha:string}>}>}
 */
/**
 * 拿不到镜像清单时的兜底端点（测试里可以注入）。
 * @param {AbortSignal} [signal] 取消信号。
 * @param {string[]} [endpoints] 覆盖端点列表。
 * @returns {Promise<{base:string, files:Map<string,{size:number, sha:string}>}>}
 */
async function fetchModelMetadata(signal, endpoints = HF_ENDPOINTS) {
  let lastError
  for (const base of endpoints) {
    try {
      // 走插件统一的 http 层，这样系统代理/用户代理配置对元数据请求也生效
      const text = await getText(`${base}/api/models/${MODEL_INFO.repo}/tree/main?recursive=true`, {
        signal,
        timeout: 30_000,
        retries: 1,
      })
      const entries = JSON.parse(text)
      const files = new Map()
      for (const entry of entries) {
        if (entry.type !== 'file') continue
        files.set(entry.path, { size: Number(entry.size ?? entry.lfs?.size ?? 0), sha: String(entry.lfs?.oid ?? '') })
      }
      return { base, files }
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`拿不到模型文件列表（${lastError?.message ?? '网络不可用'}）`)
}

/**
 * 下载并解压 llama.cpp 运行时。
 * @param {object} params 参数。
 * @param {ReturnType<typeof localPaths>} params.paths 路径。
 * @param {(line:string)=>void} [params.log] 日志。
 * @param {(p:object)=>void} [params.onProgress] 进度。
 * @param {AbortSignal} [params.signal] 取消信号。
 * @returns {Promise<{exe:string, bytes:number}>}
 */
export async function downloadRuntime(params) {
  const { paths, log = () => {}, onProgress, signal, url } = params
  if (process.platform !== 'win32') {
    throw new Error('本地 OCR 的自动运行库目前只提供 Windows x64 版本；其他平台请自行安装 llama.cpp 并把 llama-server 放进 PATH')
  }
  const zipPath = join(paths.runtimeDir, 'llama-cpu.zip')
  mkdirSync(paths.runtimeDir, { recursive: true })
  log(`下载 llama.cpp ${RUNTIME_INFO.version}（CPU 版，约 24MB）`)
  await downloadToFile({
    url: url ?? RUNTIME_INFO.win32,
    dest: zipPath,
    signal,
    onProgress: info => onProgress?.({ ...info, phase: 'runtime' }),
  })
  log('解压 llama.cpp')
  const entries = readZip(readFileSync(zipPath))
  let written = 0
  for (const [name, data] of entries) {
    // 只取文件，丢掉目录条目与绝对路径
    if (!name || name.endsWith('/') || name.includes('..')) continue
    const target = join(paths.runtimeDir, name.replace(/\\/g, '/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    written++
  }
  rmSync(zipPath, { force: true })
  const exe = join(paths.runtimeDir, serverExeName())
  if (!existsSync(exe)) throw new Error('解压后没找到 llama-server，运行库压缩包结构可能变了')
  log(`llama.cpp 就绪：${written} 个文件`)
  return { exe, bytes: written }
}

/**
 * 下载模型权重（GGUF + mmproj）。
 * @param {object} params 参数。
 * @param {ReturnType<typeof localPaths>} params.paths 路径。
 * @param {(line:string)=>void} [params.log] 日志。
 * @param {(p:object)=>void} [params.onProgress] 进度。
 * @param {AbortSignal} [params.signal] 取消信号。
 * @returns {Promise<{bytes:number}>}
 */
export async function downloadModel(params) {
  const { paths, log = () => {}, onProgress, signal, endpoints } = params
  mkdirSync(paths.modelDir, { recursive: true })
  const meta = await fetchModelMetadata(signal, endpoints)
  log(`模型源：${meta.base}`)

  let totalBytes = 0
  for (let i = 0; i < MODEL_INFO.files.length; i++) {
    const name = MODEL_INFO.files[i]
    const info = meta.files.get(name)
    if (!info) throw new Error(`模型仓库里找不到 ${name}`)
    const fileProgress = p => onProgress?.({
      ...p,
      phase: 'model',
      file: name,
      fileIndex: i + 1,
      fileCount: MODEL_INFO.files.length,
    })
    log(`下载 ${name}（${(info.size / 1024 / 1024).toFixed(0)}MB）`)
    const result = await downloadToFile({
      url: `${meta.base}/${MODEL_INFO.repo}/resolve/main/${name}`,
      dest: join(paths.modelDir, name),
      expectedBytes: info.size || 0,
      sha256: info.sha || undefined,
      signal,
      onProgress: fileProgress,
    })
    totalBytes += result.bytes
  }

  writeFileSync(paths.manifest, JSON.stringify({
    model: MODEL_INFO.id,
    label: MODEL_INFO.label,
    repo: MODEL_INFO.repo,
    files: MODEL_INFO.files,
    source: meta.base,
    bytes: totalBytes,
    installedAt: new Date().toISOString(),
  }, null, 2), 'utf8')
  log(`模型就绪（${(totalBytes / 1024 / 1024).toFixed(0)}MB）`)
  return { bytes: totalBytes }
}

/**
 * 删掉模型与运行库。
 * @param {ReturnType<typeof localPaths>} paths 路径。
 * @returns {{removed:boolean}}
 */
export function removeLocalFiles(paths) {
  let removed = false
  for (const dir of [paths.modelDir, paths.runtimeDir]) {
    if (!existsSync(dir)) continue
    rmSync(dir, { recursive: true, force: true })
    removed = true
  }
  // 顺手清掉空的上层目录
  for (const dir of [join(paths.modelDir, '..'), join(paths.runtimeDir, '..')]) {
    try { if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
  return { removed }
}

/**
 * 找一个空闲端口。
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * 等一下再试（轮询健康检查用）。
 * @param {number} ms 毫秒。
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 当前运行的 llama-server。 */
let current = null

/**
 * 启动 llama-server（已启动就直接复用）。
 * @param {object} params 参数。
 * @param {ReturnType<typeof localPaths>} params.paths 路径。
 * @param {(line:string)=>void} [params.log] 日志。
 * @returns {Promise<{port:number}>}
 */
export async function startServer(params) {
  const { paths, log = () => {} } = params
  if (current && current.child.exitCode === null) {
    current.lastUsed = Date.now()
    return { port: current.port }
  }
  const runtime = runtimeStatus(paths)
  const model = modelStatus(paths)
  if (!runtime.installed) throw new Error('还没下载本地 OCR 运行库，请先在设置里点「下载模型」')
  if (!model.installed) throw new Error('还没下载 Xiaomi-OCR-0 模型，请先在设置里点「下载模型」')

  const port = await freePort()
  const threads = Math.max(2, Math.floor(cpus().length / 2))
  const args = [
    '-m', paths.modelFile,
    '--mmproj', paths.mmprojFile,
    '-c', '8192',
    '--host', '127.0.0.1',
    '--port', String(port),
    '-ngl', '0',
    '-t', String(threads),
    '--jinja',
  ]
  log(`启动本地 OCR 服务（127.0.0.1:${port}，${threads} 线程）`)
  const child = spawn(runtime.exe, args, {
    cwd: paths.runtimeDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tail = []
  const collect = chunk => {
    const text = String(chunk)
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      tail.push(trimmed)
      if (tail.length > 40) tail.shift()
    }
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  const server = { port, child, startedAt: Date.now(), lastUsed: Date.now(), timer: null, tail }
  current = server

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      current = null
      throw new Error(`llama-server 启动失败（退出码 ${child.exitCode}）：${tail.slice(-3).join(' / ')}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })
      if (response.ok) {
        log('本地 OCR 服务就绪')
        return { port }
      }
    } catch { /* 还在加载模型 */ }
    await sleep(1000)
  }
  stopServer()
  throw new Error(`本地 OCR 服务 ${START_TIMEOUT_MS / 1000}s 内没有就绪：${tail.slice(-3).join(' / ')}`)
}

/**
 * 停掉 llama-server。
 * @returns {Promise<void>}
 */
export async function stopServer() {
  const server = current
  current = null
  if (!server) return
  if (server.timer) clearTimeout(server.timer)
  try { server.child.kill() } catch { /* 已经退出 */ }
  await sleep(200)
}

/**
 * 空闲一段时间后自动停服务，省内存。
 * @param {number} [idleMs] 空闲时长。
 */
function scheduleIdleStop(idleMs = IDLE_STOP_MS) {
  if (!current) return
  if (current.timer) clearTimeout(current.timer)
  current.timer = setTimeout(() => {
    if (!current) return
    if (Date.now() - current.lastUsed >= idleMs) {
      stopServer().catch(() => {})
    } else {
      scheduleIdleStop(idleMs)
    }
  }, idleMs)
  current.timer.unref?.()
}

/**
 * 服务当前是否在跑。
 * @returns {boolean}
 */
export function isServerRunning() {
  return Boolean(current && current.child.exitCode === null)
}

/**
 * 用本地模型识别一页图。
 * @param {object} params 参数。
 * @param {Buffer|Uint8Array} params.png 页面 PNG。
 * @param {'text'|'document'} [params.mode] 识别模式。
 * @param {AbortSignal} [params.signal] 取消信号。
 * @returns {Promise<string>}
 */
export async function recognizePage(params) {
  const { png, mode = 'text', signal } = params
  if (!isServerRunning()) throw new Error('本地 OCR 服务没有运行')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('本地识别超时')), OCR_TIMEOUT_MS)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(`http://127.0.0.1:${current.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL_INFO.id,
        temperature: 0,
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(png).toString('base64')}` } },
            { type: 'text', text: PROMPTS[mode] ?? PROMPTS.text },
          ],
        }],
      }),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`本地识别失败 HTTP ${response.status}：${text.slice(0, 200)}`)
    }
    const data = await response.json()
    const content = data?.choices?.[0]?.message?.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.map(part => part?.text ?? '').join('') : ''
    if (current) current.lastUsed = Date.now()
    scheduleIdleStop()
    return text.trim()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 本地 OCR 的完整状态（给设置页用）。
 * @param {ReturnType<typeof localPaths>} paths 路径。
 * @param {{enabled:boolean, mode:string}} settings 设置。
 * @returns {object}
 */
export function localStatus(paths, settings) {
  const runtime = runtimeStatus(paths)
  const model = modelStatus(paths)
  return {
    enabled: settings.enabled === true,
    mode: settings.mode === 'document' ? 'document' : 'text',
    model: {
      id: MODEL_INFO.id,
      label: MODEL_INFO.label,
      params: MODEL_INFO.params,
      installed: model.installed,
      bytes: model.bytes,
      installedAt: model.installedAt,
    },
    runtime: {
      version: runtime.version,
      installed: runtime.installed,
      bytes: runtime.bytes,
    },
    ready: runtime.installed && model.installed,
    running: isServerRunning(),
    platform: process.platform,
  }
}
