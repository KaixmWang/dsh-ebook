/** 把抽取出来的正文整理成人类可读 EPUB 与 AI 可读 Markdown。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeZip } from './zip.js'

/** 章节文本的落盘目录（相对书目录）。 */
export const CHAPTER_DIR = '.dsh-ebook/chapters'

/** 章标题的识别模式：整行就是标题，命中即开新章。 */
const HEADING_RE = /^(第[0-9零一二三四五六七八九十百千]+[章节回篇卷部].{0,40}|Chapter\s+\d+.{0,60}|(?:序言|前言|引言|楔子|后记|尾声|目录|附录)(?:[ 　:：].{0,20})?)$/

/**
 * 这一行是否像章节标题。
 * 「前言内容」这种以标题词开头的正文不算：模式要求整行匹配。
 * @param {string} line 原始行。
 * @returns {boolean}
 */
function isHeading(line) {
  const text = line.trim()
  if (!text || text.length > 62) return false
  return HEADING_RE.test(text)
}

/**
 * 清洗章节文本。
 * @param {string} text 文本。
 * @returns {string}
 */
function cleanText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 章节文件名：序号 + 安全化的标题。
 * @param {number} index 从 1 开始的章序号。
 * @param {string} title 章标题。
 * @returns {string}
 */
export function chapterFilename(index, title) {
  const number = String(index).padStart(4, '0')
  const safe = String(title).replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim().slice(0, 40)
  return `${number}-${safe || `ch${number}`}.md`
}

/**
 * 把逐页文本合并并按章节标题切分。
 *
 * 标题既可能跟在上一段之后，也可能正好落在新一页的开头（扫描件常见），
 * 两种都要切开；标题行本身不进正文，避免和 Markdown 的小标题重复。
 *
 * @param {Array<{page:number, text:string}>} pages 每页文本。
 * @param {object} [options] 选项。
 * @param {number} [options.maxCharsPerChapter] 单章上限，超长时按段落再切。
 * @returns {Array<{title:string, text:string, pages:number[]}>}
 */
export function splitChapters(pages, options = {}) {
  const { maxCharsPerChapter = 40000 } = options
  const chapters = []
  let current = { title: '', text: '', pages: [] }

  /**
   * 收尾当前章节：有正文才落，超长按段落再切。
   */
  const flush = () => {
    const text = cleanText(current.text)
    if (!text) {
      current = { title: current.title, text: '', pages: [] }
      return
    }
    const title = current.title.trim() || `第 ${chapters.length + 1} 节`
    const pageList = [...current.pages]
    if (text.length <= maxCharsPerChapter) {
      chapters.push({ title, text, pages: pageList })
    } else {
      // 超长章节按段落再切，避免单章过大
      let buffer = ''
      let part = 1
      for (const paragraph of text.split(/\n{2,}/)) {
        if (buffer.length + paragraph.length > maxCharsPerChapter && buffer) {
          chapters.push({ title: `${title}（${part}）`, text: buffer.trim(), pages: pageList })
          buffer = ''
          part++
        }
        buffer += `${paragraph}\n\n`
      }
      if (buffer.trim()) {
        chapters.push({ title: part > 1 ? `${title}（${part}）` : title, text: buffer.trim(), pages: pageList })
      }
    }
    current = { title: '', text: '', pages: [] }
  }

  for (const page of pages) {
    for (const line of page.text.split('\n')) {
      const trimmed = line.trim()
      if (isHeading(trimmed)) {
        if (current.text.trim()) {
          // 上一章已经有正文：先收尾，这一行作为新章标题
          flush()
          current.title = trimmed
          if (!current.pages.includes(page.page)) current.pages.push(page.page)
          continue
        }
        if (!current.title) {
          // 全书第一行 / 新页开头的标题
          current.title = trimmed
          if (!current.pages.includes(page.page)) current.pages.push(page.page)
          continue
        }
        // 已有标题但还没有正文：重复的标题行，丢掉
        continue
      }
      current.text += `${line}\n`
      if (!current.pages.includes(page.page)) current.pages.push(page.page)
    }
    current.text += '\n'
  }
  flush()

  return chapters.filter(chapter => chapter.text.trim().length > 0)
}

/**
 * 写 Markdown 全书与分章文件。
 * @param {string} bookDir 书目录。
 * @param {object} book 书信息。
 * @param {Array<{title:string, text:string}>} chapters 章节。
 * @returns {{markdownPath:string, chapterFiles:string[]}} 章节文件为相对书目录的路径。
 */
export function writeMarkdown(bookDir, book, chapters) {
  const chapterDir = join(bookDir, '.dsh-ebook', 'chapters')
  mkdirSync(chapterDir, { recursive: true })

  const header = [
    `# ${book.title}`,
    book.creator ? `作者：${book.creator}` : '',
    book.language ? `语言：${book.language}` : '',
    book.translated ? `译本语言：${book.translated}` : '',
  ].filter(Boolean).join('\n\n')

  const chapterFiles = []
  const parts = []
  chapters.forEach((chapter, index) => {
    const filename = chapterFilename(index + 1, chapter.title)
    const body = `## ${chapter.title}\n\n${chapter.text}\n`
    writeFileSync(join(chapterDir, filename), body, 'utf8')
    chapterFiles.push(`${CHAPTER_DIR}/${filename}`)
    parts.push(body)
  })

  const markdownPath = join(bookDir, 'book.md')
  writeFileSync(markdownPath, `${header}\n\n---\n\n${parts.join('\n\n')}`, 'utf8')
  return { markdownPath, chapterFiles }
}

/**
 * 生成 EPUB。
 * @param {string} outPath 输出路径。
 * @param {object} book 书信息。
 * @param {Array<{title:string, text:string}>} chapters 章节。
 * @param {object} [options] 选项。
 * @param {{data:Buffer, mediaType:string, name?:string}} [options.cover] 封面图（只支持 png/jpeg）。
 */
export function writeEpub(outPath, book, chapters, options = {}) {
  const esc = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  const cover = options.cover && options.cover.data?.length ? options.cover : null
  const coverHref = cover
    ? `images/cover.${cover.mediaType === 'image/png' ? 'png' : 'jpg'}`
    : ''

  const uuid = `urn:uuid:${book.id ?? '00000000-0000-4000-8000-000000000000'}`
  const files = [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    {
      name: 'META-INF/container.xml',
      data: '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>\n',
    },
    {
      name: 'OEBPS/style.css',
      data: `body{font-family:serif;line-height:1.7;margin:1em}
h1,h2,h3{font-weight:600;margin:1.2em 0 .6em}
p{margin:0 0 .8em;text-indent:2em}
p.noindent{text-indent:0}
.cover{display:block;margin:0 auto;max-width:100%;height:auto}`,
    },
  ]
  if (cover) files.push({ name: `OEBPS/${coverHref}`, data: cover.data })

  const manifestItems = []
  const spineItems = []
  chapters.forEach((chapter, index) => {
    const number = String(index + 1).padStart(4, '0')
    const href = `text/ch${number}.xhtml`
    const paragraphs = chapter.text.split(/\n{2,}/)
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => `<p>${esc(p).replace(/\n/g, '<br/>')}</p>`)
      .join('\n')
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${esc(book.language || 'zh')}">
<head><meta charset="utf-8"/><title>${esc(chapter.title)}</title><link rel="stylesheet" type="text/css" href="../style.css"/></head>
<body>
<h2>${esc(chapter.title)}</h2>
${paragraphs}
</body>
</html>`
    files.push({ name: `OEBPS/${href}`, data: xhtml })
    manifestItems.push(`<item id="ch${number}" href="${href}" media-type="application/xhtml+xml"/>`)
    spineItems.push(`<itemref idref="ch${number}"/>`)
  })

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>目录</title></head>
<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>
${chapters.map((c, i) => `<li><a href="text/ch${String(i + 1).padStart(4, '0')}.xhtml">${esc(c.title)}</a></li>`).join('\n')}
</ol></nav></body></html>`
  files.push({ name: 'OEBPS/nav.xhtml', data: nav })
  manifestItems.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')
  manifestItems.push('<item id="css" href="style.css" media-type="text/css"/>')

  // 封面：EPUB3 用 properties="cover-image"，同时保留 EPUB2 的 meta name="cover"，
  // 再加一页 cover.xhtml 放在 spine 最前，阅读器一打开就是封面
  if (cover) {
    files.push({
      name: 'OEBPS/cover.xhtml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(book.language || 'zh')}">
<head><meta charset="utf-8"/><title>封面</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><section epub:type="cover"><img class="cover" src="${coverHref}" alt="${esc(book.title)}"/></section></body>
</html>`,
    })
    manifestItems.push(`<item id="cover-image" href="${coverHref}" media-type="${cover.mediaType}" properties="cover-image"/>`)
    manifestItems.push('<item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>')
    spineItems.unshift('<itemref idref="cover-page" linear="yes"/>')
  }

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${esc(uuid)}</dc:identifier>
    <dc:title>${esc(book.title)}</dc:title>
    ${book.creator ? `<dc:creator>${esc(book.creator)}</dc:creator>` : ''}
    <dc:language>${esc(book.language || 'zh')}</dc:language>
    ${book.source ? `<dc:source>${esc(book.source)}</dc:source>` : ''}
    ${cover ? '<meta name="cover" content="cover-image"/>' : ''}
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine>
    ${spineItems.join('\n    ')}
  </spine>
</package>`
  files.push({ name: 'OEBPS/content.opf', data: opf })

  writeFileSync(outPath, writeZip(files))
}

/**
 * 统计文本信息。
 * @param {Array<{title:string, text:string}>} chapters 章节。
 * @returns {{chapters:number, chars:number}}
 */
export function stats(chapters) {
  const chars = chapters.reduce((sum, c) => sum + c.text.replace(/\s/g, '').length, 0)
  return { chapters: chapters.length, chars }
}
