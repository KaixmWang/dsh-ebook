/** 处理管线：下载 → 解析 → OCR → 切章 → 产出 EPUB/Markdown → 元数据。 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadImage, createCanvas } from '@napi-rs/canvas'
import { downloadRow } from './sources/index.js'
import { extractEpub, isEpub, extractCover } from './extract/epub.js'
import { openPdf, extractText, detectScanned, renderPages, parsePageSpec } from './extract/pdf.js'
import { splitChapters, writeMarkdown, writeEpub, stats } from './build.js'
import { ocrPage, translateText } from './ai.js'
import { safeFilename } from './http.js'
import { lookupBookInfo } from './bookinfo.js'
/** OCR 并发页数。pdfjs 渲染与本地识别都能并行，但不宜过高挤占内存。 */
const OCR_CONCURRENCY = 3

/**
 * 按并发额度跑一组异步任务，结果顺序与输入一致。
 * 单个任务失败不会拖垮整批：失败项以 {__error} 返回，由调用方计入失败列表。
 * @param {Array<any>} items 输入。
 * @param {number} limit 并发数。
 * @param {(item:any, index:number)=>Promise<any>} worker 任务。
 * @returns {Promise<Array<any>>}
 */
async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      try {
        results[index] = await worker(items[index], index)
      } catch (error) {
        results[index] = { __error: error.message, page: items[index] }
      }
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 判断下载到的字节是什么格式。
 * @param {Buffer} buffer 字节。
 * @param {string} hint 提示扩展名。
 * @returns {string}
 */
export function detectFormat(buffer, hint) {
  if (isEpub(buffer)) return 'epub'
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  const lower = String(hint ?? '').toLowerCase()
  if (['epub', 'pdf', 'mobi', 'azw3', 'txt'].includes(lower)) return lower
  return 'unknown'
}

/**
 * 提取 PDF 正文：有文本层就用文本层，缺失页走 AI OCR。
 * @param {object} deps 依赖。
 * @param {Buffer} buffer PDF 字节。
 * @param {object} options 选项。
 * @returns {Promise<{pages:Array<{page:number,text:string}>, ocr:object}>}
 */
async function extractPdfContent(deps, buffer, options) {
  const { ai, log, signal, localOcr } = deps
  const doc = await openPdf(buffer)
  try {
    const total = doc.numPages
    const textPages = await extractText(doc)
    const { blankPages } = detectScanned(textPages)

    let ocrPages = []
    if (options.ocr === 'force') ocrPages = textPages.map(p => p.page)
    else if (options.ocr === 'auto') ocrPages = blankPages
    else if (options.ocr === 'off') ocrPages = []

    if (options.pages) {
      const wanted = new Set(parsePageSpec(options.pages, total))
      ocrPages = ocrPages.filter(p => wanted.has(p))
    }

    const pages = textPages.map(p => ({ page: p.page, text: p.text }))
    const ocrRecord = { applied: false, engine: 'llm-vision', pages: [], failed: [] }

    if (ocrPages.length > 0) {
      // 本地模型可用时优先用它：不花 token，慢一点但离线
      const wantLocal = Boolean(localOcr?.options?.enabled && localOcr.ready)
      let useLocal = wantLocal
      if (!wantLocal && !ai) throw new Error('当前环境没有可用的 llm 服务，无法识别扫描页')
      if (wantLocal) log(`OCR：本地 ${localOcr.status().model.label} 识别 ${ocrPages.length} 页（共 ${total} 页）`)
      else log(`OCR：视觉模型识别 ${ocrPages.length} 页（共 ${total} 页，并发 ${OCR_CONCURRENCY}）`)

      const engines = new Set()
      const results = await mapConcurrent(ocrPages, OCR_CONCURRENCY, async pageNo => {
        if (signal?.aborted) throw signal.reason ?? new Error('已取消')
        const [rendered] = await renderPages(doc, { pages: [pageNo], scale: 2.2, maxWidth: 1700 })
        if (!rendered) return { page: pageNo, text: '', engine: 'skip' }

        if (useLocal) {
          try {
            const text = await localOcr.recognize(rendered.png, { signal })
            return { page: pageNo, text, engine: 'local' }
          } catch (error) {
            if (signal?.aborted) throw signal.reason ?? error
            if (!ai) throw new Error(`本地 OCR 失败（${error.message}），且没有可用的 llm 服务兜底`)
            // 本地服务挂了不该让整本书中断：退回视觉模型，后面几页也直接走远端
            useLocal = false
            log(`本地 OCR 第 ${pageNo} 页失败（${error.message}），改用视觉模型`)
          }
        }

        let text = await ocrPage(ai, rendered, { signal })
        if (!text) {
          // 空结果多半是模型瞬时抖动（限流/截断），同一页再试一次再判失败
          log(`OCR 第 ${pageNo} 页返回空文本，重试一次`)
          text = await ocrPage(ai, rendered, { signal }).catch(() => '')
        }
        return { page: pageNo, text, engine: 'llm' }
      })

      for (const item of results) {
        if (!item) continue
        if (item.__error) {
          ocrRecord.failed.push(item.page)
          if (!ocrRecord.firstError) ocrRecord.firstError = String(item.__error)
          log(`OCR 第 ${item.page} 页失败：${item.__error}`)
          continue
        }
        if (item.engine === 'skip') continue
        if (item.engine) engines.add(item.engine)
        const target = pages.find(p => p.page === item.page)
        if (target && item.text) target.text = item.text
        if (item.text) {
          ocrRecord.pages.push(item.page)
          log(`OCR 第 ${item.page} 页完成（${item.text.length} 字）`)
        } else {
          ocrRecord.failed.push(item.page)
        }
      }
      if (engines.size === 1) {
        ocrRecord.engine = engines.has('local') ? `local-${localOcr.status().model.label}` : 'llm-vision'
      } else if (engines.size > 1) {
        ocrRecord.engine = 'mixed'
      }
      ocrRecord.applied = ocrRecord.pages.length > 0
    }

    return { pages: pages.filter(p => p.text.trim().length > 0), ocr: ocrRecord, totalPages: total }
  } finally {
    await doc.destroy().catch(() => {})
  }
}

/**
 * 为书目录准备封面图。
 *
 * 生成的 book.epub 本身不带封面，所以从原始文件取：
 * EPUB 抽内嵌封面图，PDF 渲染第一页。已有封面就不重复做。
 *
 * @param {object} params 参数。
 * @param {string} params.dir 书目录。
 * @param {string} params.format 原始格式。
 * @param {Buffer} params.buffer 原始文件字节。
 * @returns {Promise<string|null>} 封面文件路径，或 null。
 */
export async function ensureCover(params) {
  const { dir, format, buffer } = params

  // 已有任意 cover.* 就直接用
  for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'gif']) {
    const existing = join(dir, `cover.${ext}`)
    if (existsSync(existing)) return existing
  }

  if (format === 'epub') {
    const cover = extractCover(buffer)
    if (!cover) return null
    const ext = /png/i.test(cover.mediaType) ? 'png'
      : /gif/i.test(cover.mediaType) ? 'gif'
        : /webp/i.test(cover.mediaType) ? 'webp'
          : 'jpg'
    const target = join(dir, `cover.${ext}`)
    writeFileSync(target, cover.data)
    return target
  }

  if (format === 'pdf') {
    let doc
    try {
      doc = await openPdf(buffer)
      if (doc.numPages < 1) return null
      const [page] = await renderPages(doc, { pages: [1], scale: 1.2, maxWidth: 600 })
      if (!page) return null
      const target = join(dir, 'cover.png')
      writeFileSync(target, page.png)
      return target
    } catch {
      return null
    } finally {
      await doc?.destroy?.().catch(() => {})
    }
  }

  return null
}

/**
 * 读出书目录里的封面，转成 EPUB 能用的格式（只认 JPEG / PNG）。
 *
 * 封面可能来自 EPUB 内嵌图、PDF 首页渲染，或联网选的豆瓣图（webp / gif 都有），
 * 所以这里统一转一道：遇到 webp / gif 用 canvas 转成 PNG，转不了就放弃封面。
 *
 * @param {string} dir 书目录。
 * @returns {Promise<{data:Buffer, mediaType:string, name:string}|null>}
 */
export async function loadEpubCover(dir) {
  for (const ext of ['jpg', 'jpeg', 'png']) {
    const file = join(dir, `cover.${ext}`)
    if (!existsSync(file)) continue
    try {
      return {
        data: readFileSync(file),
        mediaType: ext === 'png' ? 'image/png' : 'image/jpeg',
        name: `cover.${ext}`,
      }
    } catch { /* 读不了就看下一张 */ }
  }
  for (const ext of ['webp', 'gif']) {
    const file = join(dir, `cover.${ext}`)
    if (!existsSync(file)) continue
    try {
      const image = await loadImage(readFileSync(file))
      const canvas = createCanvas(image.width, image.height)
      canvas.getContext('2d').drawImage(image, 0, 0)
      return { data: canvas.toBuffer('image/png'), mediaType: 'image/png', name: 'cover.png' }
    } catch { /* 转不了就放弃封面 */ }
  }
  return null
}

/**
 * 决定原始文件的落盘名。
 *
 * 优先用服务器 Content-Disposition 给的名字（最接近「原名」），
 * 其次用检索到的书名。重名时加序号，避免后下的版本覆盖先前的。
 *
 * @param {object} params 参数。
 * @param {string[]} params.candidates 候选名，按优先级。
 * @param {string} params.extension 扩展名（不含点）。
 * @param {string} params.dir 目标目录。
 * @returns {string} 最终文件名。
 */
function pickSourceFilename(params) {
  const { candidates, extension, dir } = params
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') continue
    const name = safeFilename(candidate, extension)
    if (!name) continue
    if (!existsSync(join(dir, name))) return name
    // 重名：书名 (2).pdf
    const stem = name.replace(new RegExp(`\\.${extension}$`, 'i'), '')
    for (let i = 2; i < 200; i++) {
      const alt = `${stem} (${i}).${extension}`
      if (!existsSync(join(dir, alt))) return alt
    }
  }
  return `source.${extension}`
}

/**
 * 入库一本书。
 * @param {object} deps 依赖。
 * @param {object} row 搜索结果行。
 * @param {object} options 选项。
 * @returns {Promise<object>}
 */
export async function ingest(deps, row, options = {}) {
  const { library, config, ai, log = () => {}, signal } = deps
  const title = options.title || row.title || '未命名'
  // 指定 dir 时落到已有目录（重做 OCR、重新解析都走这条路），否则按书名新建
  const dir = options.dir ? options.dir : library.ensure(title)
  mkdirSync(dir, { recursive: true })

  let download
  let formatHint = row.extension || ''

  if (row.path) {
    // 本地文件：用于把硬盘上的书入库，或对已入库的书重做 OCR
    if (!existsSync(row.path)) throw new Error(`本地文件不存在：${row.path}`)
    const buffer = readFileSync(row.path)
    if (buffer.length === 0) throw new Error(`本地文件为空：${row.path}`)
    if (buffer.length > config.maxBytes) throw new Error(`文件体积 ${buffer.length} 超过上限 ${config.maxBytes}`)
    download = { buffer, url: `file://${row.path}` }
    formatHint = extname(row.path).replace(/^\./, '') || formatHint
    log(`读取本地文件《${title}》`)
  } else {
    log(`下载《${title}》（来源 ${row.source}）`)
    download = await downloadRow(row, config, { signal, maxBytes: config.maxBytes, log })
    formatHint = row.extension || download.format
  }

  const format = detectFormat(download.buffer, formatHint)
  if (format === 'unknown') throw new Error(`无法识别的文件格式（${download.buffer.subarray(0, 8).toString('latin1')}）`)
  if (!['epub', 'pdf'].includes(format)) {
    throw new Error(`暂不支持 ${format} 格式的解析：请改选 epub 或 pdf 版本`)
  }

  // 下载可能耗时数分钟，期间目录可能被外部清理，落盘前重新确保存在
  mkdirSync(dir, { recursive: true })
  // 保留原始文件名：服务器给的名字 > 检索到的书名 > source.<ext>
  const sourceFile = pickSourceFilename({
    candidates: [download.filename, row.title, title],
    extension: format,
    dir,
  })
  writeFileSync(join(dir, sourceFile), download.buffer)
  if (sourceFile !== `source.${format}`) log(`原始文件保存为 ${sourceFile}`)

  let chapters
  let meta = { title, creator: row.author ?? '', language: row.language ?? '' }
  let ocr = null

  if (format === 'epub') {
    const parsed = extractEpub(download.buffer)
    meta = {
      // 调用方显式给了书名就用它（用户意图），否则用 EPUB 内嵌标题
      title: options.title || parsed.title || title,
      creator: parsed.creator || row.author || '',
      language: parsed.language || row.language || '',
      description: parsed.description || '',
    }
    chapters = parsed.chapters.map(chapter => ({
      title: chapter.title || '未命名章节',
      // EPUB 的 h1 标题被抽进正文了，去掉首行重复的标题
      text: stripLeadingTitle(chapter.text, chapter.title),
    }))
    if (chapters.length === 0) throw new Error('EPUB 里没有解析出正文')
  } else {
    const extracted = await extractPdfContent(deps, download.buffer, { ocr: options.ocr ?? 'auto', pages: options.pages })
    ocr = extracted.ocr
    chapters = splitChapters(extracted.pages, { maxCharsPerChapter: config.maxCharsPerChapter })
    if (chapters.length === 0) {
      // 把实际发生了什么说清楚：OCR 有没有跑、失败了几页、第一条错误是什么
      const tried = ocr?.pages?.length ?? 0
      const failed = ocr?.failed?.length ?? 0
      const firstError = ocr?.firstError ? `；首个错误：${ocr.firstError}` : ''
      throw new Error(
        `PDF 里没有解析出正文。OCR 识别成功 ${tried} 页，失败 ${failed} 页${firstError}。`
        + '常见原因：所配 OCR 模型不支持图片输入，或它的返回里没有文本。',
      )
    }
  }

  const summary = stats(chapters)

  // 简介：EPUB 内嵌的 dc:description 优先；没有就联网查（微信读书优先，豆瓣兜底）
  if (!meta.description && config.weread) {
    try {
      log('内嵌简介为空，尝试联网补齐…')
      const info = await lookupBookInfo({
        title: meta.title || title,
        author: meta.creator,
        credentials: config.weread,
        signal,
      })
      if (info?.intro) {
        meta.description = info.intro
        meta.summarySource = info.source
        meta.summaryMatchedTitle = info.matchedTitle
        if (info.publisher) meta.publisher = info.publisher
        if (info.translator) meta.translator = info.translator
        meta.rating = info.rating ?? 0
        meta.ratingCount = info.ratingCount ?? 0
        meta.ratingSource = info.source
        log(`简介已从${info.source}补齐（${info.intro.length} 字）`)
      }
    } catch (error) {
      log(`联网补简介失败（${error.message.slice(0, 60)}），先跳过`)
    }
  }

  // 封面：EPUB 抽内嵌图、PDF 渲染首页，供书库界面展示；它也要嵌进生成的 EPUB
  const coverPath = await ensureCover({ dir, format, buffer: download.buffer })
  if (coverPath) log(`封面已生成：${basename(coverPath)}`)
  const cover = await loadEpubCover(dir)

  const markdown = writeMarkdown(dir, { ...meta, translated: options.translated }, chapters)
  // 原始文件本身就是 EPUB 时不再生成一份内容重复的成品，省一半磁盘
  const epubPath = format === 'epub' ? null : join(dir, 'book.epub')
  if (epubPath) writeEpub(epubPath, { ...meta, id: randomUUID(), source: download.url }, chapters, { cover })
  if (epubPath && cover) log('封面已写入 book.epub')

  // 内部数据统一放私有子目录，书目录里只看得到书本身
  const dataDir = library.dataDir(dir)
  mkdirSync(dataDir, { recursive: true })

  const manifest = {
    title: meta.title,
    creator: meta.creator,
    language: meta.language,
    confirmedAt: new Date().toISOString(),
    source: { kind: row.source, id: row.md5, url: download.url, format },
    ocr,
    chapters: chapters.map((chapter, index) => ({
      index: index + 1,
      title: chapter.title,
      chars: chapter.text.replace(/\s/g, '').length,
      file: markdown.chapterFiles[index],
    })),
    chars: summary.chars,
  }
  writeFileSync(join(dataDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  library.writeMeta(dir, {
    ...meta,
    source: row.source,
    sourceId: row.md5,
    sourceUrl: download.url,
    format,
    // 原始文件的实际文件名，重做 OCR / 重新解析时靠它定位
    sourceFile,
    chars: summary.chars,
    chapters: chapters.length,
    ocr,
  })

  return {
    title: meta.title,
    dir,
    format,
    chapters: summary.chapters,
    chars: summary.chars,
    ocrPages: ocr?.pages?.length ?? 0,
    ocrFailed: ocr?.failed ?? [],
    // 只有 PDF 会另存一份 book.epub；EPUB 源直接用原文件
    epub: epubPath,
    sourceFile: join(dir, sourceFile),
    markdown: markdown.markdownPath,
  }
}

/**
 * 去掉正文开头与章节标题重复的那一行（EPUB 的 h1 会被抽进正文）。
 * @param {string} text 正文。
 * @param {string} title 章节标题。
 * @returns {string}
 */
function stripLeadingTitle(text, title) {
  const needle = String(title ?? '').replace(/\s+/g, '')
  if (!needle) return text
  const lines = text.split('\n')
  const firstIndex = lines.findIndex(line => line.trim().length > 0)
  if (firstIndex < 0) return text
  if (lines[firstIndex].replace(/\s+/g, '') !== needle) return text
  lines.splice(firstIndex, 1)
  return lines.join('\n').replace(/^\n+/, '')
}

/**
 * 按章读取书籍内容，给模型用。
 * @param {object} library 书库实例。
 * @param {string} name 书名。
 * @param {object} [options] 选项。
 * @param {number} [options.start] 起始章（1 起）。
 * @param {number} [options.end] 结束章。
 * @param {number} [options.maxChars] 总字数预算。
 * @returns {object}
 */
export function readChapters(library, name, options = {}) {
  const { start = 1, end, maxChars = 30000 } = options
  const dir = library.find(name)
  if (!dir) throw new Error(`书库里没有《${name}》`)
  const manifest = library.readManifest(dir)
  if (!manifest) throw new Error(`《${name}》还没有整理过（缺 manifest.json）`)

  const total = manifest.chapters.length
  const from = Math.max(1, start)
  const to = Math.min(total, end ?? from + 2)
  const parts = []
  let used = 0
  let lastChapter = from

  for (let i = from; i <= to; i++) {
    const entry = manifest.chapters[i - 1]
    if (!entry) break
    const path = join(dir, entry.file)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    if (used + text.length > maxChars && parts.length > 0) break
    parts.push(text)
    used += text.length
    lastChapter = i
  }

  return {
    title: manifest.title,
    chapterRange: [from, lastChapter],
    totalChapters: total,
    chars: used,
    truncated: lastChapter < to,
    content: parts.join('\n\n'),
    nextStart: lastChapter + 1 > total ? null : lastChapter + 1,
  }
}

/**
 * 去掉分章文件开头的 `## 标题` 行。
 * @param {string} text 章节文件内容。
 * @returns {string}
 */
function stripChapterHeading(text) {
  const lines = text.split('\n')
  let index = 0
  while (index < lines.length && lines[index].trim() === '') index++
  if (lines[index]?.startsWith('## ')) {
    return lines.slice(index + 1).join('\n').replace(/^\n+/, '')
  }
  return text
}

/**
 * 用子代理翻译一章。
 *
 * 子代理是一个完整 agent（自带系统提示与工具循环），适合需要「翻完自查再改」的场景；
 * 代价是比单次 llm.stream() 慢很多。它跑在独立会话里，主对话只看到完成后的一行日志。
 *
 * @param {object} params 参数。
 * @param {any} params.subagents ctx.subagents 服务。
 * @param {any} params.agent 发起方 agent（必须来自工具执行的 exec.agent）。
 * @param {string} params.text 原文。
 * @param {string} params.title 章节标题。
 * @param {string} params.target 目标语言。
 * @param {AbortSignal} [params.signal] 取消信号。
 * @returns {Promise<string>} 译文。
 */
async function translateChapterViaSubagent(params) {
  const { subagents, agent, text, title, target, signal } = params
  const prompt = [
    `把下面这一章翻译成${target}。`,
    '要求：',
    '1. 只输出译文正文，不要任何解释、前言、总结或「以下是译文」之类的话。',
    '2. 不要调用任何工具，也不要读取文件——原文已经完整给在下面。',
    '3. 保持原有段落划分，术语前后一致。',
    '',
    `章节标题：${title}`,
    '',
    '原文：',
    text,
  ].join('\n')

  const activation = await subagents.startActivation({
    provider: 'spawn',
    label: `翻译：${title}`.slice(0, 40),
    prompt: [{ type: 'text', text: prompt }],
    parent: agent,
    signal,
    // 回给调用方，不往主会话塞通知
    delivery: 'caller',
  })

  try {
    const result = await activation.result
    const output = Array.isArray(result?.output) ? result.output : []
    const translated = output
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (!translated) throw new Error('子代理没有返回文本')
    return translated
  } finally {
    await activation.dispose().catch(() => {})
  }
}

/**
 * 翻译整本或指定章节。
 * @param {object} deps 依赖。
 * @param {string} name 书名。
 * @param {object} [options] 选项。
 * @returns {Promise<object>}
 */
export async function translateBook(deps, name, options = {}) {
  const { library, ai, subagents, agent, log = () => {}, signal } = deps
  if (!ai) throw new Error('当前环境没有可用的 llm 服务，无法翻译')
  const dir = library.find(name)
  if (!dir) throw new Error(`书库里没有《${name}》`)
  const manifest = library.readManifest(dir)
  if (!manifest) throw new Error(`《${name}》还没有整理过`)

  const target = options.target ?? '简体中文'
  const from = Math.max(1, options.start ?? 1)
  const to = Math.min(manifest.chapters.length, options.end ?? manifest.chapters.length)

  // 子代理模式需要服务与发起方都在；缺任何一个就自动退回直接调用
  const wantSubagent = options.viaSubagent === true
  const canSubagent = Boolean(subagents?.startActivation && agent)
  const useSubagent = wantSubagent && canSubagent
  if (wantSubagent && !canSubagent) {
    log('子代理不可用（缺少 subagents 服务或发起方 agent），本次仍用直接调用')
  } else if (useSubagent) {
    log('翻译将通过子代理执行，主会话不参与正文')
  }

  const outDir = join(library.dataDir(dir), 'translated')
  mkdirSync(outDir, { recursive: true })

  const records = []
  for (let i = from; i <= to; i++) {
    if (signal?.aborted) throw signal.reason ?? new Error('已取消')
    const entry = manifest.chapters[i - 1]
    if (!entry) continue
    const sourcePath = join(dir, entry.file)
    if (!existsSync(sourcePath)) continue
    const cachePath = join(outDir, `${String(i).padStart(4, '0')}.md`)
    if (existsSync(cachePath) && !options.force) {
      records.push({ index: i, cached: true })
      continue
    }
    // 分章文件第一行是 `## 标题`，翻译时要去掉，否则译文里会重复一次标题
    const text = stripChapterHeading(readFileSync(sourcePath, 'utf8'))
    log(`翻译第 ${i}/${to} 章：${entry.title}${useSubagent ? '（子代理）' : ''}`)
    try {
      let translated
      if (useSubagent) {
        try {
          translated = await translateChapterViaSubagent({
            subagents, agent, text, title: entry.title, target, signal,
          })
        } catch (error) {
          // 子代理失败不该让整本翻译中断，退回直接调用
          log(`第 ${i} 章子代理失败（${error.message}），改用直接调用`)
          translated = await translateText(ai, text, { target, signal })
        }
      } else {
        translated = await translateText(ai, text, { target, signal })
      }
      writeFileSync(cachePath, `## ${entry.title}\n\n${translated}\n`, 'utf8')
      records.push({ index: i, ok: true, chars: translated.length })
    } catch (error) {
      records.push({ index: i, ok: false, error: error.message })
      log(`第 ${i} 章翻译失败：${error.message}`)
    }
  }

  // 汇总成译本
  const parts = []
  for (let i = from; i <= to; i++) {
    const path = join(outDir, `${String(i).padStart(4, '0')}.md`)
    if (!existsSync(path)) continue
    parts.push(readFileSync(path, 'utf8'))
  }
  if (parts.length > 0) {
    const translatedChapters = parts.map(part => {
      const match = /^## (.+)\n\n([\s\S]*)$/.exec(part.trim())
      return match ? { title: match[1], text: match[2] } : { title: '译文', text: part.trim() }
    })
    const targetLang = /^(简体中文|繁体中文|中文)$/.test(target) ? 'zh' : target
    writeFileSync(join(dir, `book.${targetLang}.md`),
      `# ${manifest.title}（${target}译本）\n\n${parts.join('\n\n')}`, 'utf8')
    // 译本沿用原书封面，否则推送到微信读书 / 打开阅读器时是一张白板
    const cover = await loadEpubCover(dir)
    writeEpub(join(dir, `book.${targetLang}.epub`), {
      title: `${manifest.title}（${target}译本）`,
      creator: manifest.creator,
      language: /中文/.test(target) ? 'zh' : 'en',
      id: randomUUID(),
    }, translatedChapters, { cover })
    if (cover) log('译本已嵌入封面')
    library.writeMeta(dir, { translated: target, translatedChapters: parts.length })
  }

  return {
    title: manifest.title,
    target,
    range: [from, to],
    translated: records.filter(r => r.ok).length,
    cached: records.filter(r => r.cached).length,
    failed: records.filter(r => r.ok === false),
    markdown: join(dir, `book.${/^(简体中文|繁体中文|中文)$/.test(target) ? 'zh' : target}.md`),
  }
}
