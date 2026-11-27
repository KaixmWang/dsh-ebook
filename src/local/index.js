/**
 * 本地 OCR 管理器：把「下载 / 删除 / 起服务 / 识别」捏在一起，
 * 给设置页的接口层和入库管线共用。
 */
import {
  MODEL_INFO,
  RUNTIME_INFO,
  localPaths,
  localStatus,
  fetchModelMetadata,
  downloadRuntime,
  downloadModel,
  removeLocalFiles,
  startServer,
  stopServer,
  isServerRunning,
  recognizePage,
  supportsAutoRuntime,
} from './llamacpp.js'

/**
 * 本地 OCR（Xiaomi-OCR-0）管理器。
 */
export class LocalOcr {
  /**
   * @param {object} deps 依赖。
   * @param {string} deps.dataDir 插件数据目录。
   * @param {object} deps.settings Settings 实例。
   * @param {(line:string)=>void} [deps.log] 日志。
   */
  constructor(deps) {
    this.dataDir = deps.dataDir
    this.settings = deps.settings
    this.log = deps.log ?? (() => {})
    this.paths = localPaths(deps.dataDir)
    /** 下载进度：idle / downloading / done / error */
    this.progress = { state: 'idle', phase: '', file: '', received: 0, total: 0, percent: 0, message: '', startedAt: 0 }
    this.controller = null
    /** 正在跑的下载 promise（删除 / 卸载前要等它收尾，避免 Windows 上 EBUSY） */
    this.downloadPromise = null
  }

  /** @returns {{enabled:boolean, mode:'text'|'document'}} 当前设置。 */
  get options() {
    return this.settings.localOcr
  }

  /** @returns {boolean} 模型与运行库是否都就绪。 */
  get ready() {
    return this.status().ready
  }

  /**
   * 状态快照，给设置页与工具输出用。
   * @returns {object}
   */
  status() {
    return {
      ...localStatus(this.paths, this.options),
      progress: { ...this.progress },
      paths: { modelDir: this.paths.modelDir, runtimeDir: this.paths.runtimeDir },
      modelInfo: { id: MODEL_INFO.id, label: MODEL_INFO.label, params: MODEL_INFO.params, files: MODEL_INFO.files },
    }
  }

  /**
   * 打开/关闭本地 OCR。关闭时顺手停掉服务，把内存还回去。
   * @param {boolean} enabled 开关。
   * @returns {object} 保存后的设置。
   */
  setEnabled(enabled) {
    const saved = this.settings.setLocalOcr({ enabled })
    if (!saved.enabled) stopServer().catch(() => {})
    return saved
  }

  /**
   * 设置识别模式。
   * @param {'text'|'document'} mode 模式。
   * @returns {object}
   */
  setMode(mode) {
    return this.settings.setLocalOcr({ mode })
  }

  /**
   * 下载运行库与模型（后台跑，进度看 status().progress）。
   * 重复调用会直接返回已在进行的下载。
   * @returns {{started:boolean, message:string}}
   */
  startDownload() {
    if (this.progress.state === 'downloading') return { started: false, message: '已经在下载了' }
    if (!supportsAutoRuntime()) {
      throw new Error('本地 OCR 的自动运行库目前只支持 Windows x64；其他平台请自行安装 llama.cpp 并让它出现在 PATH')
    }
    this.controller = new AbortController()
    const startedAt = Date.now()
    this.progress = { state: 'downloading', phase: 'runtime', file: '', received: 0, total: 0, percent: 0, message: '准备下载', startedAt }
    const run = this.runDownload(this.controller.signal)
      .catch(error => {
        if (this.controller?.signal.aborted) {
          this.progress = { ...this.progress, state: 'idle', phase: '', message: '已取消', percent: 0 }
          return
        }
        this.log(`本地 OCR 下载失败：${error.message}`)
        this.progress = { ...this.progress, state: 'error', message: error.message }
      })
      .finally(() => { this.downloadPromise = null })
    this.downloadPromise = run
    return { started: true, message: '开始下载' }
  }

  /**
   * 真正的下载流程：先运行库，再模型；进度按总字节数算，不按单文件重置。
   * @param {AbortSignal} signal 取消信号。
   * @returns {Promise<void>}
   */
  async runDownload(signal) {
    const meta = await fetchModelMetadata(signal)
    const modelTotal = MODEL_INFO.files.reduce((sum, name) => sum + (meta.files.get(name)?.size ?? 0), 0)
    const total = RUNTIME_INFO.size + modelTotal
    const steps = MODEL_INFO.files.length + 1

    /**
     * 更新一次进度。
     * @param {number} received 已下载总量。
     * @param {number} step 第几个文件（1 起）。
     * @param {string} message 展示文案。
     * @param {'runtime'|'model'} phase 阶段。
     * @param {string} [file] 当前文件名。
     */
    const report = (received, step, message, phase, file = '') => {
      this.progress = {
        ...this.progress,
        phase,
        file,
        received,
        total,
        percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
        message: `${message}（${step}/${steps}）`,
      }
    }

    report(0, 1, '下载 llama.cpp 运行库', 'runtime')
    await downloadRuntime({
      paths: this.paths,
      log: this.log,
      signal,
      onProgress: info => {
        const received = Math.min(RUNTIME_INFO.size, Number(info.received ?? 0))
        report(received, 1, '下载 llama.cpp 运行库', 'runtime')
      },
    })

    let doneBytes = RUNTIME_INFO.size
    await downloadModel({
      paths: this.paths,
      log: this.log,
      signal,
      meta,
      onProgress: info => {
        const before = MODEL_INFO.files.slice(0, Math.max(0, (info.fileIndex ?? 1) - 1))
        const offset = RUNTIME_INFO.size + before.reduce((sum, name) => sum + (meta.files.get(name)?.size ?? 0), 0)
        report(offset + Number(info.received ?? 0), (info.fileIndex ?? 1) + 1, `下载 ${info.file ?? '模型'}`, 'model', info.file ?? '')
      },
    })
    doneBytes = total

    this.progress = { ...this.progress, state: 'done', phase: '', percent: 100, received: doneBytes, total, message: '下载完成' }
    this.log('本地 OCR 模型已就绪')
  }

  /**
   * 取消下载。
   * @returns {boolean}
   */
  cancelDownload() {
    if (!this.controller || this.progress.state !== 'downloading') return false
    this.controller.abort(new Error('用户取消'))
    this.controller = null
    return true
  }

  /**
   * 删除模型与运行库，并停掉服务。
   * @returns {Promise<{removed:boolean, message:string}>}
   */
  async remove() {
    this.cancelDownload()
    // 等下载流真正关闭再删，否则 Windows 上可能 EBUSY
    if (this.downloadPromise) await this.downloadPromise.catch(() => {})
    await stopServer()
    const result = removeLocalFiles(this.paths)
    this.progress = { state: 'idle', phase: '', file: '', received: 0, total: 0, percent: 0, message: '', startedAt: 0 }
    this.log(result.removed ? '本地 OCR 模型已删除' : '本地 OCR 模型本来就没下载')
    return { removed: result.removed, message: result.removed ? '已删除本地模型与运行库' : '没有可删除的本地文件' }
  }

  /**
   * 识别一页图：确保服务在跑，然后请求一次。
   * @param {Buffer|Uint8Array} png 页面图。
   * @param {object} [options] 选项。
   * @param {AbortSignal} [options.signal] 取消信号。
   * @returns {Promise<string>}
   */
  async recognize(png, options = {}) {
    if (!this.ready) throw new Error('本地 OCR 模型还没下载完')
    const { port } = await startServer({ paths: this.paths, log: this.log })
    return recognizePage({ png, port, mode: this.options.mode, signal: options.signal })
  }

  /**
   * 插件卸载时收尾。
   * @returns {Promise<void>}
   */
  async dispose() {
    this.cancelDownload()
    if (this.downloadPromise) await this.downloadPromise.catch(() => {})
    await stopServer()
  }
}
