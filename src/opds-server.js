/**
 * 阅读器（OPDS）服务的管理层：启停、端口/监听地址、给设置页用的地址列表。
 *
 * 服务本身在 opds.js（纯 HTTP，无鉴权）；这里只负责「听哪个地址、开还是关、
 * 怎么把地址告诉用户」。默认只听回环，要让手机 / 墨水屏阅读器连，
 * 得显式打开「局域网访问」——UI 上会给出无鉴权提醒。
 */
import { networkInterfaces } from 'node:os'
import { startOpds } from './opds.js'

/** 通配监听地址。 */
const WILDCARD = new Set(['0.0.0.0', '::', ''])

/**
 * 本机的局域网 IPv4 地址。
 * @returns {string[]}
 */
function lanAddresses() {
  const out = []
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue
      if (item.address.startsWith('169.254.')) continue
      out.push(item.address)
    }
  }
  return out
}

/**
 * OPDS 服务管理器。
 */
export class OpdsServer {
  /**
   * @param {object} deps 依赖。
   * @param {object} deps.settings Settings 实例。
   * @param {object} deps.config 插件配置（Config，提供默认端口/地址/是否自启）。
   * @param {() => object} deps.getLibrary 取当前书库（切换目录后跟着变）。
   * @param {(line:string)=>void} [deps.log] 日志。
   */
  constructor(deps) {
    this.settings = deps.settings
    this.config = deps.config ?? {}
    this.getLibrary = deps.getLibrary
    this.log = deps.log ?? (() => {})
    /** @type {{port:number, close:()=>Promise<void>}|null} */
    this.server = null
    this.error = ''
  }

  /**
   * 当前生效的设置：设置页的值优先，没改过就跟随 Config。
   * @returns {{host:string, port:number, autoStart:boolean}}
   */
  get options() {
    const saved = this.settings.opds
    const config = this.config.opds ?? {}
    return {
      host: saved.host || config.host || '127.0.0.1',
      port: saved.port || config.port || 8899,
      autoStart: saved.autoStart === null ? config.autoStart === true : saved.autoStart === true,
    }
  }

  /** @returns {boolean} 服务是否在跑。 */
  get running() {
    return Boolean(this.server)
  }

  /**
   * 给阅读器用的地址（0.0.0.0 时展开成本机回环 + 各局域网地址）。
   * @returns {string[]}
   */
  urls() {
    const port = this.server?.port ?? this.options.port
    const host = this.options.host
    if (WILDCARD.has(host)) {
      return [
        `http://127.0.0.1:${port}/opds`,
        ...lanAddresses().map(address => `http://${address}:${port}/opds`),
      ]
    }
    return [`http://${host}:${port}/opds`]
  }

  /**
   * 状态快照。
   * @returns {object}
   */
  status() {
    const options = this.options
    return {
      running: this.running,
      host: options.host,
      port: this.server?.port ?? options.port,
      configuredPort: options.port,
      autoStart: options.autoStart,
      lan: WILDCARD.has(options.host),
      urls: this.running ? this.urls() : [],
      previewUrls: this.urls(),
      error: this.error,
    }
  }

  /**
   * 启动服务。
   * @returns {Promise<object>} 状态快照。
   */
  async start() {
    if (this.server) return this.status()
    const { host, port } = this.options
    this.error = ''
    try {
      // 传 getter 而不是实例：切换书库后 OPDS 也要跟着换目录
      const server = await startOpds({ library: this.getLibrary, port, host })
      this.server = server
      this.log(`OPDS 已启动：${this.urls().join(' / ')}`)
    } catch (error) {
      this.error = error.code === 'EADDRINUSE'
        ? `端口 ${port} 已被占用，换一个端口再试`
        : error.message
      this.log(`OPDS 启动失败：${this.error}`)
      throw new Error(this.error)
    }
    return this.status()
  }

  /**
   * 停服务。
   * @returns {Promise<object>} 状态快照。
   */
  async stop() {
    const server = this.server
    this.server = null
    if (server) {
      await server.close().catch(() => {})
      this.log('OPDS 已停止')
    }
    return this.status()
  }

  /**
   * 应用新设置：保存到 settings，必要时重启服务。
   * @param {object} patch 变更（host / port / autoStart）。
   * @returns {Promise<object>} 状态快照。
   */
  async apply(patch) {
    const before = this.options
    this.settings.setOpds(patch)
    const after = this.options
    const changed = before.host !== after.host || before.port !== after.port
    if (this.running) {
      if (changed) {
        await this.stop()
        await this.start()
      }
    } else if (after.autoStart && patch.autoStart !== undefined) {
      // 用户刚把「开机自启」打开，顺手起一次
      await this.start()
    }
    return this.status()
  }

  /**
   * 插件加载时按 autoStart 决定要不要起。
   * @returns {Promise<void>}
   */
  async ensureAutoStart() {
    if (!this.options.autoStart || this.server) return
    try {
      await this.start()
    } catch { /* 端口被占之类，状态里已经有 error */ }
  }

  /**
   * 插件卸载：关掉服务。
   * @returns {Promise<void>}
   */
  async dispose() {
    await this.stop()
  }
}
