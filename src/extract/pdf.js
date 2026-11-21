/**
 * PDF 处理：文本层提取 + 页面渲染成图（供视觉 OCR）。
 * 依赖 pdfjs-dist 与 @napi-rs/canvas，均在插件包内声明。
 */
import { createCanvas } from '@napi-rs/canvas'

let pdfjsPromise = null
/**
 * 懒加载 pdfjs legacy 构建（Node 环境可用）。
 * @returns {Promise<any>}
 */
async function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjsPromise
}

/**
 * 打开 PDF 文档。
 * @param {string|Buffer|Uint8Array} source 路径或字节。
 * @returns {Promise<any>}
 */
export async function openPdf(source) {
  const { getDocument } = await loadPdfjs()
  const data = typeof source === 'string'
    ? undefined
    : (Buffer.isBuffer(source) ? new Uint8Array(source) : source)
  const task = getDocument({
    ...(data ? { data } : { url: source }),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
  })
  return task.promise
}

/**
 * 抽取每页文本层。
 * @param {any} doc pdfjs 文档。
 * @param {object} [options] 选项。
 * @param {number[]} [options.pages] 指定页码（1 起）。
 * @returns {Promise<Array<{page:number, text:string, chars:number}>>}
 */
export async function extractText(doc, options = {}) {
  const total = doc.numPages
  const targets = options.pages?.length ? options.pages.filter(p => p >= 1 && p <= total) : range(1, total)
  const out = []
  for (const pageNo of targets) {
    const page = await doc.getPage(pageNo)
    const content = await page.getTextContent()
    let text = ''
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue
      text += item.str
      if (item.hasEOL) text += '\n'
    }
    const cleaned = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    out.push({ page: pageNo, text: cleaned, chars: cleaned.replace(/\s/g, '').length })
    page.cleanup()
  }
  return out
}

/**
 * 判断 PDF 是否缺文本层（扫描件）。
 * @param {Array<{chars:number}>} pages 文本抽取结果。
 * @param {number} [threshold] 每页最少字数。
 * @returns {{scanned:boolean, blankPages:number[]}}
 */
export function detectScanned(pages, threshold = 15) {
  const blankPages = pages.filter(p => p.chars < threshold).map(p => p.page)
  return { scanned: blankPages.length > pages.length / 2, blankPages }
}

/**
 * 把指定页渲染成 PNG。
 * @param {any} doc pdfjs 文档。
 * @param {object} options 选项。
 * @param {number[]} options.pages 页码（1 起）。
 * @param {number} [options.scale] 缩放倍数，控制清晰度与体积。
 * @param {number} [options.maxWidth] 最大像素宽。
 * @returns {Promise<Array<{page:number, png:Buffer, width:number, height:number}>>}
 */
export async function renderPages(doc, options) {
  const { pages, scale = 2, maxWidth = 1600 } = options
  const out = []
  for (const pageNo of pages) {
    if (pageNo < 1 || pageNo > doc.numPages) continue
    const page = await doc.getPage(pageNo)
    let viewport = page.getViewport({ scale })
    if (viewport.width > maxWidth) {
      viewport = page.getViewport({ scale: scale * (maxWidth / viewport.width) })
    }
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const context = canvas.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: context, viewport, canvas }).promise
    out.push({
      page: pageNo,
      png: canvas.toBuffer('image/png'),
      width: canvas.width,
      height: canvas.height,
    })
    page.cleanup()
  }
  return out
}

/**
 * 生成 [from, to] 整数数组。
 * @param {number} from 起始。
 * @param {number} to 结束（含）。
 * @returns {number[]}
 */
function range(from, to) {
  const out = []
  for (let i = from; i <= to; i++) out.push(i)
  return out
}

/**
 * 解析 "1-5,8,10-12" 形式的页码。
 * @param {string} spec 页码描述。
 * @param {number} total 总页数。
 * @returns {number[]}
 */
export function parsePageSpec(spec, total) {
  if (!spec) return range(1, total)
  const out = new Set()
  for (const part of String(spec).split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed)
    if (rangeMatch) {
      const start = Math.max(1, Number(rangeMatch[1]))
      const end = Math.min(total, Number(rangeMatch[2]))
      for (let i = start; i <= end; i++) out.add(i)
    } else if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed)
      if (n >= 1 && n <= total) out.add(n)
    }
  }
  return [...out].sort((a, b) => a - b)
}
