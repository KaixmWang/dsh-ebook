/** dsh-ebook：电子书插件入口。 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { Library } from './src/store.js'
import { Settings } from './src/settings.js'
import { createAi, translateText } from './src/ai.js'
import { createTools } from './src/tools.js'
import { startOpds } from './src/opds.js'
import { registerSettingsApi } from './src/api.js'
import { configureNetwork } from './src/http.js'
import { ingest, translateBook } from './src/pipeline.js'
import { LocalOcr } from './src/local/index.js'
import { ReleaseChecker } from './src/update.js'

export const name = 'dsh-ebook'
export const inject = ['tools', 'llm', 'subagents']

/**
 * 插件配置。
 * libraryDir 是「首次启动时的默认书库」，之后以设置页保存的目录为准；
 * llm 留空则跟随会话默认模型；zlib 可用设置页里的账号覆盖。
 */
export const Config = z.object({
  libraryDir: z.string().default(join(homedir(), 'Documents', 'dsh-ebook-library')),
  proxy: z.string().default('auto'),
  maxBytes: z.number().default(300 * 1024 * 1024),
  maxCharsPerChapter: z.number().default(40000),
  llm: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    // 按用途的模型指定；空值表示跟随上面的通用配置 / 会话默认
    ocr: z.object({
      provider: z.string().default(''),
      model: z.string().default(''),
    }),
    translate: z.object({
      provider: z.string().default(''),
      model: z.string().default(''),
    }),
    // 阅读模型：ebook_ask 用它读书并整理答案，原文不进主对话
    read: z.object({
      provider: z.string().default(''),
      model: z.string().default(''),
    }),
  }),
  zlib: z.object({
    domain: z.string().default(''),
    cookie: z.string().default(''),
  }),
  opds: z.object({
    port: z.number().default(8899),
    // 默认只听本机；要给手机/阅读器用就把 host 改成 0.0.0.0（无鉴权，注意网络环境）
    host: z.string().default('127.0.0.1'),
    autoStart: z.boolean().default(false),
  }),
})

/**
 * 插件自己的配置目录（与 DSH 主目录并列，不污染 profile）。
 * @returns {string}
 */
function pluginDataDir() {
  const home = process.env.DSH_HOME
  return home ? join(home, 'dsh-ebook') : join(homedir(), '.dsh', 'dsh-ebook')
}

/**
 * 插件装配。
 * @param {any} ctx 插件上下文。
 * @param {any} config 已校验配置。
 */
export function apply(ctx, config) {
  // logger 不是必 inject 的服务，包一层防止宿主差异导致整个插件挂掉
  const log = line => {
    try { ctx.logger?.info?.(line) } catch { /* 没有 logger 就静默 */ }
  }
  const network = configureNetwork(config.proxy ?? 'auto')
  const dataDir = pluginDataDir()
  const settings = new Settings(dataDir)

  // 书库可运行时切换，用可变引用而不是固定实例
  let current = new Library(settings.libraryDir || config.libraryDir)
  mkdirSync(current.root, { recursive: true })
  const getLibrary = () => current

  /**
   * 每次取配置时把设置页里的账号合并进来，账号优先于 Config 里的静态值。
   * @returns {object}
   */
  const getConfig = () => {
    const account = settings.accountFor('zlibrary')
    const models = settings.allModels()
    // 设置页的值优先；没配就回退到 Config 里的同名项
    const pickModel = (fromSettings, fromConfig) => ({
      provider: fromSettings?.provider || fromConfig?.provider || '',
      model: fromSettings?.model || fromConfig?.model || '',
    })
    return {
      ...config,
      libraryDir: current.root,
      cacheDir: join(dataDir, 'cache'),
      zlib: {
        domain: account?.domain || config.zlib?.domain || '',
        cookie: account?.cookie || config.zlib?.cookie || '',
      },
      llm: {
        provider: config.llm?.provider ?? '',
        model: config.llm?.model ?? '',
        ocr: pickModel(models.ocr, config.llm?.ocr),
        translate: pickModel(models.translate, config.llm?.translate),
        // 「阅读」模型：ebook_ask 在本地读书后只把答案带回，原文不进主对话
        read: pickModel(models.read, config.llm?.read),
      },
      // 翻译是否走子代理（设置页开关）
      viaSubagent: settings.translateViaSubagent,
      // 微信读书凭据：入库时用它补简介、查评分
      weread: settings.weread,
    }
  }

  // attachments（视觉 OCR 存图）与 agentDefaultModel（会话默认模型）都不是必需服务：
  // Cordis 对未 inject 的服务直接抛错，所以用条件注入，服务就绪时才拿到实例。
  let attachments
  let defaultSelection
  ctx.inject(['attachments'], scoped => {
    scoped.effect(() => {
      attachments = scoped.attachments
      return () => { attachments = undefined }
    }, 'dsh-ebook: attachments')
  })
  ctx.inject(['agentDefaultModel'], scoped => {
    scoped.effect(() => {
      defaultSelection = () => scoped.agentDefaultModel.currentSelection()
      return () => { defaultSelection = undefined }
    }, 'dsh-ebook: default model')
  })

  const ai = createAi({
    ctx,
    config,
    getConfig,
    log,
    getAttachments: () => attachments,
    getDefaultSelection: () => defaultSelection?.(),
  })
  const servers = new Map()
  // 本地 OCR（Xiaomi-OCR-0）：模型与 llama.cpp 都由插件自己下载、自己起服务
  const localOcr = new LocalOcr({ dataDir, settings, log })
  // 检查更新：只查 GitHub Releases 并提示，不自动安装
  const updateChecker = new ReleaseChecker({ log })
  const tools = createTools({ getConfig, getLibrary, ai, subagents: ctx.subagents, log, servers, localOcr })

  ctx.effect(() => {
    const disposers = tools.map(definition => ctx.tools.register(definition))
    let disposed = false

    if (config.opds?.autoStart) {
      const port = config.opds.port ?? 8899
      // 传 getter 而不是实例：切换书库后 OPDS 也要跟着换目录
      startOpds({ library: getLibrary, port, host: config.opds.host ?? '127.0.0.1' })
        .then(server => {
          if (disposed) {
            server.close().catch(() => {})
            return
          }
          servers.set(String(port), server)
          servers.set(String(server.port), server)
          log(`OPDS 已启动：${server.url}`)
        })
        .catch(error => log(`OPDS 自启动失败（端口 ${port}）：${error.message}`))
    }

    return () => {
      disposed = true
      for (const dispose of disposers) {
        try { dispose() } catch { /* 注册器已卸载 */ }
      }
      for (const server of new Set(servers.values())) server.close().catch(() => {})
      servers.clear()
      // 本地 OCR 的 llama-server 是自己起的子进程，卸载时要收掉
      localOcr.dispose().catch(() => {})
    }
  })

  // 设置面板接口依赖 webServer。它不是本插件的必需服务——纯 CLI 宿主没有它，
  // 而 Cordis 对未 inject 的服务是直接抛错而不是返回 undefined，
  // 所以这里用条件注入：webServer 就绪时才注册路由，否则跳过。
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => {
      try {
        return registerSettingsApi(webCtx, {
          settings,
          getLibrary,
          dataDir,
          llm: ctx.llm,
          ai,
          translateText,
          localOcr,
          updateChecker,
          switchLibrary: dir => {
            current = new Library(dir)
            mkdirSync(current.root, { recursive: true })
          },
          log,
        })
      } catch (error) {
        log(`设置接口注册失败：${error.message}`)
        return () => {}
      }
    }, 'dsh-ebook: settings api')
  })

  ctx.logger?.info?.(
    `dsh-ebook 已加载：书库 ${current.root}，网络 ${network.mode}${network.proxy ? `（${network.proxy}）` : ''}，` +
    `工具 ${tools.length} 个，账号 ${settings.listAccounts().length} 个，数据目录 ${dataDir}`,
  )
}
