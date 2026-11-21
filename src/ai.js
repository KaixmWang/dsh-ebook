/**
 * AI 能力：OCR 识别与翻译，统一走 DSH 的 llm 服务。
 * 不自己存 API key，复用用户在 DSH 里已配置的模型与凭据。
 */

/**
 * 把流式输出拼成完整文本。
 * 正常情况下文本在每个 text-delta 里；个别适配器只在 block-end 给整块，
 * 所以两条路都收，逐块优先用 delta。
 * @param {AsyncIterable<any>} stream llm.stream 返回的块流。
 * @returns {Promise<string>}
 */
async function collect(stream) {
  let deltas = ''
  const blocks = new Map()
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      deltas += chunk.text
    } else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
      blocks.set(chunk.index ?? blocks.size, chunk.block.text)
    }
  }
  return (deltas || [...blocks.values()].join('')).trim()
}

/**
 * 读取一个可能未声明的 Cordis 服务。
 * Cordis 对未 inject 的服务会直接抛错，所以不能靠 `?.` 兜底。
 * @param {() => any} getter 服务取值函数。
 * @returns {any} 服务实例，或 undefined。
 */
function safeCall(getter) {
  try {
    return getter()
  } catch {
    return undefined
  }
}

/**
 * 创建 AI 客户端。
 * @param {object} deps 依赖。
 * @param {any} deps.ctx 插件上下文（需要 llm 已 inject）。
 * @param {object} deps.config 插件静态配置。
 * @param {() => object} [deps.getConfig] 取当前配置（设置页的模型指定优先）。
 * @param {() => any} [deps.getAttachments] 取 attachments 服务（未就绪时返回 undefined）。
 * @param {() => {provider:string, model:string}|undefined} [deps.getDefaultSelection] 取会话默认模型。
 * @param {(msg:string)=>void} [deps.log] 日志。
 * @returns {object}
 */
export function createAi(deps) {
  const { ctx, config, getConfig, getAttachments, getDefaultSelection, log = () => {} } = deps

  /**
   * 当前生效的配置：运行时配置（设置页）优先于静态 Config。
   * @returns {object}
   */
  function currentConfig() {
    return (getConfig ? safeCall(getConfig) : undefined) ?? config ?? {}
  }

  /**
   * 解析实际使用的 provider 与 model。
   *
   * 按用途分层：该用途的专属指定（设置页里配的）→ 通用配置 → 会话默认模型。
   * 留空一律表示「跟随上一级」。
   *
   * @param {'ocr'|'translate'|undefined} [role] 用途。
   * @returns {{provider:string, model:string}}
   */
  function route(role) {
    const llm = currentConfig()?.llm ?? {}
    const specific = role ? llm[role] : undefined
    const fallback = (getDefaultSelection ? safeCall(getDefaultSelection) : undefined) ?? {}
    const provider = specific?.provider || llm.provider || fallback.provider || ''
    const model = specific?.model || llm.model || fallback.model || ''
    if (!provider || !model) {
      const where = role === 'ocr' ? 'OCR 模型' : role === 'translate' ? '翻译模型' : '模型'
      throw new Error(`没有可用的${where}：请在插件设置 → 任务模型里选一个${role === 'ocr' ? '支持图片的' : ''}模型`)
    }
    return { provider, model }
  }

  /**
   * 取 attachments 服务；不可用时给出明确错误。
   * @returns {any}
   */
  function attachmentsOrThrow() {
    const attachments = getAttachments ? safeCall(getAttachments) : undefined
    if (!attachments?.saveImages) {
      throw new Error('当前环境没有 attachments 服务，无法把图片交给视觉模型（OCR 需要它）')
    }
    return attachments
  }

  /**
   * 纯文本补全。
   * @param {object} request 请求。
   * @param {string} request.system 系统提示。
   * @param {string} request.prompt 用户提示。
   * @param {number} [request.maxTokens] 输出上限。
   * @param {number} [request.temperature] 温度。
   * @param {'ocr'|'translate'} [request.role] 用途，决定用哪套模型指定。默认 translate。
   * @param {AbortSignal} [request.signal] 取消信号。
   * @returns {Promise<string>}
   */
  async function complete(request) {
    const { system, prompt, maxTokens = 4096, temperature, role = 'translate', signal } = request
    const { provider, model } = route(role)
    const stream = ctx.llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
      ...(temperature === undefined ? {} : { temperature }),
      ...(signal ? { signal } : {}),
    })
    return collect(stream)
  }

  /**
   * 多模态补全：提示词 + 若干图片。
   * @param {object} request 请求。
   * @param {string} request.prompt 提示词。
   * @param {string} [request.system] 系统提示。
   * @param {Array<{data:Buffer|Uint8Array, mediaType?:string}>} request.images 图片。
   * @param {number} [request.maxTokens] 输出上限。
   * @param {'ocr'|'translate'} [request.role] 用途，决定用哪套模型指定。默认 ocr。
   * @param {AbortSignal} [request.signal] 取消信号。
   * @returns {Promise<string>}
   */
  async function vision(request) {
    const { prompt, system, images, maxTokens = 4096, role = 'ocr', signal } = request
    const attachments = attachmentsOrThrow()
    const { provider, model } = route(role)
    const refs = await attachments.saveImages(
      images.map(image => ({
        data: image.data instanceof Uint8Array ? image.data : new Uint8Array(image.data),
        mediaType: image.mediaType ?? 'image/png',
      })),
    )
    const content = [{ type: 'text', text: prompt }]
    for (const ref of refs) content.push({ type: 'image', attachment: ref })
    const stream = ctx.llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content }],
      maxTokens,
      ...(signal ? { signal } : {}),
    })
    return collect(stream)
  }

  return { complete, vision, route }
}

/**
 * OCR 一页图像。
 * @param {object} ai createAi 返回值。
 * @param {{png:Buffer, page:number}} page 页面图。
 * @param {object} [options] 选项。
 * @param {string} [options.language] 语言提示。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @returns {Promise<string>}
 */
export async function ocrPage(ai, page, options = {}) {
  const language = options.language ? `主要语言：${options.language}。` : ''
  const prompt = [
    '你是排版还原极严格的 OCR 引擎。请把这张书页图片转成纯文本。',
    language,
    '规则：',
    '1. 只输出正文，不要任何解释、前言、markdown 代码块。',
    '2. 保留原文段落划分，段间空一行；不要合并段落。',
    '3. 双栏排版按「左栏读完再读右栏」的顺序输出。',
    '4. 删除页眉、页脚、页码、水印、装订线残留。',
    '5. 表格用制表符对齐逐行输出。',
    '6. 认不出的字用 ▢ 占位，不要猜测性编造内容。',
    '7. 原文是竖排时按从上到下、从右到左的顺序转换为横排。',
  ].filter(Boolean).join('\n')
  return ai.vision({
    prompt,
    images: [{ data: page.png, mediaType: 'image/png' }],
    maxTokens: 4096,
    signal: options.signal,
  })
}

/**
 * 翻译一段文本。
 * @param {object} ai createAi 返回值。
 * @param {string} text 原文。
 * @param {object} [options] 选项。
 * @param {string} [options.target] 目标语言，默认简体中文。
 * @param {string} [options.style] 风格要求。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @returns {Promise<string>}
 */
export async function translateText(ai, text, options = {}) {
  const target = options.target ?? '简体中文'
  const style = options.style ?? '译文通顺可读，保留术语原文（首次出现时加括号），不省略、不改写、不添加译注。'
  const system = `你是专业图书译者，目标语言是${target}。${style}只输出译文正文，不要任何说明。`
  return ai.complete({
    system,
    prompt: text,
    maxTokens: 8192,
    temperature: 0.2,
    signal: options.signal,
  })
}
