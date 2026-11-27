/**
 * 本地 OCR 管理器：把「下载 / 删除 / 起服务 / 识别」捏在一起，
 * 给设置页的接口层和入库管线共用。
 */
import {
  MODEL_INFO,
  localPaths,
  localStatus,
  downloadRuntime,
  downloadModel,
  removeLocalFiles,
  startServer,
  stopServer,
  isServerRunning,
  recognizePage,
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
      server: { running: isServerRunning() },
      paths: { modelDir: this.paths.modelDir, runtimeDir: this.paths.runtimeDir },
      modelInfo: { id: MODEL_INFO.id, label: MODEL_INFO.label, params: MODEL_INFO.params, files: MODEL_INFO.files },
    }
  }

  /**
   * 打开/关闭本地 OCR。
   * @param {boolean} enabled 开关。
   * @returns {object} 保存后的设置。
   */
  setEnabled(enabled) {
    return this.settings.setLocalOcr({ enabled })
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
    if (process.platform !== 'win32') {
      throw new Error('本地 OCR 的自动运行库目前只支持 Windows x64；其他平台请自行安装 llama.cpp 并让它出现在 PATH')
    }
    this.controller = new AbortController()
    const startedAt = Date.now()
    this.progress = { state: 'downloading', phase: 'runtime', file: '', received: 0, total: 0, percent: 0, message: '准备下载', startedAt }
    this.runDownload(this.controller.signal).catch(error => {
      if (this.controller?.signal.aborted) {
        this.progress = { ...this.progress, state: 'idle', phase: '', message: '已取消', percent: 0 }
        return
      }
      this.log(`本地 OCR 下载失败：${error.message}`)
      this.progress = { ...this.progress, state: 'error', message: error.message }
    })
    return { started: true, message: '开始下载' }
  }

  /**
   * 真正的下载流程：先运行库，再模型。
   * @param {AbortSignal} signal 取消信号。
   * @returns {Promise<void>}
   */
  async runDownload(signal) {
    const onProgress = info => {
      const total = Number(info.total ?? 0)
      const received = Number(info.received ?? 0)
      this.progress = {
        ...this.progress,
        phase: info.phase === 'runtime' ? 'runtime' : 'model',
        file: info.file ?? this.progress.file,
        received,
        total,
        percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
        message: info.phase === 'runtime'
          ? '下载 llama.cpp 运行库'
          : `下载 ${info.file ?? '模型'}${info.fileCount ? `（${info.fileIndex}/${info.fileCount}）` : ''}`,
      }
    }
    await downloadRuntime({ paths: this.paths, log: this.log, onProgress, signal })
    await downloadModel({ paths: this.paths, log: this.log, onProgress, signal })
    this.progress = { ...this.progress, state: 'done', phase: '', percent: 100, message: '下载完成' }
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
    await startServer({ paths: this.paths, log: this.log })
    return recognizePage({ png, mode: this.options.mode, signal: options.signal })
  }

  /**
   * 插件卸载时收尾。
   * @returns {Promise<void>}
   */
  async dispose() {
    this.cancelDownload()
    await stopServer()
  }
}
