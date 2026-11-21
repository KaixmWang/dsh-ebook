/**
 * OPDS 1.2 目录服务：让 KOReader / 静读天下 / Moon+ / Thorium 等阅读器直接拉书。
 * 纯本地 HTTP，无需任何账号。
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * 转义 XML。
 * @param {string} text 文本。
 * @returns {string}
 */
function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * child 是否落在 root 之内（含 root 自身判定由调用方决定）。
 * 用 relative 而不是 startsWith：后者会把 `E:\Books-backup` 当成 `E:\Books` 的子路径。
 * @param {string} root 根目录（绝对路径）。
 * @param {string} child 待判断路径。
 * @returns {boolean}
 */
function isInside(root, child) {
  const rel = relative(root, child)
  return rel !== '' && !rel.startsWith('..') && !rel.includes(`..${sep}`)
}

/**
 * 生成导航根目录 Atom。
 * @param {string} origin 服务地址。
 * @returns {string}
 */
function navFeed(origin) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:dsh-ebook:root</id>
  <title>本地书库</title>
  <updated>${new Date().toISOString()}</updated>
  <author><name>dsh-ebook</name></author>
  <link rel="self" href="${origin}/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="start" href="${origin}/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <entry>
    <title>全部书籍</title>
    <id>urn:dsh-ebook:all</id>
    <updated>${new Date().toISOString()}</updated>
    <content type="text">书库中的全部 EPUB</content>
    <link rel="subsection" href="${origin}/opds/all" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  </entry>
</feed>`
}

/**
 * 生成书籍列表 Atom。
 * @param {string} origin 服务地址。
 * @param {Array<object>} books 书架行（含 epubFile）。
 * @returns {string}
 */
function acquisitionFeed(origin, books) {
  const entries = books
    .filter(book => book.epubFile)
    .map(book => {
      const href = `${origin}/opds/book/${encodeURIComponent(book.dir)}/${encodeURIComponent(book.epubFile)}`
      return `  <entry>
    <title>${esc(book.title)}</title>
    <id>urn:dsh-ebook:${esc(book.dir)}</id>
    <updated>${esc(book.updatedAt ?? new Date().toISOString())}</updated>
    <author><name>${esc(book.creator || '未知')}</name></author>
    <dc:language xmlns:dc="http://purl.org/dc/elements/1.1/">${esc(book.language || 'zh')}</dc:language>
    <content type="text">${esc(`${book.chapters} 章 / ${book.chars} 字`)}</content>
    <link rel="http://opds-spec.org/acquisition/open-access" href="${href}" type="application/epub+zip"/>
  </entry>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:dsh-ebook:all</id>
  <title>全部书籍</title>
  <updated>${new Date().toISOString()}</updated>
  <author><name>dsh-ebook</name></author>
  <link rel="self" href="${origin}/opds/all" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  <link rel="start" href="${origin}/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
${entries}
</feed>`
}

/**
 * 启动 OPDS 服务。
 * @param {object} options 选项。
 * @param {object|(() => object)} options.library 书库实例，或返回当前书库的函数（切换目录后跟着变）。
 * @param {number} [options.port] 端口。
 * @param {string} [options.host] 监听地址。
 * @param {string} [options.publicOrigin] 对外地址覆盖。
 * @returns {Promise<{url:string, port:number, close:()=>Promise<void>}>}
 */
export async function startOpds(options) {
  const { library, port = 8899, host = '127.0.0.1', publicOrigin } = options
  const currentLibrary = typeof library === 'function' ? library : () => library

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const origin = publicOrigin ?? `http://${req.headers.host ?? `127.0.0.1:${port}`}`
      const path = decodeURIComponent(url.pathname)
      const lib = currentLibrary()

      if (path === '/opds' || path === '/opds/') {
        const body = navFeed(origin)
        res.writeHead(200, { 'Content-Type': 'application/atom+xml;profile=opds-catalog;kind=navigation; charset=utf-8' })
        res.end(body)
        return
      }

      if (path === '/opds/all') {
        const body = acquisitionFeed(origin, lib.list())
        res.writeHead(200, { 'Content-Type': 'application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8' })
        res.end(body)
        return
      }

      const bookMatch = /^\/opds\/book\/([^/]+)\/([^/]+)$/.exec(path)
      if (bookMatch) {
        const dir = join(lib.root, bookMatch[1])
        const file = join(dir, bookMatch[2])
        // 只允许书库目录内的 epub；relative() 判定避免同前缀兄弟目录穿透
        if (!isInside(lib.root, dir) || !isInside(dir, file) || !/\.epub$/i.test(file) || !existsSync(file)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('未找到该文件')
          return
        }
        const stat = statSync(file)
        res.writeHead(200, {
          'Content-Type': 'application/epub+zip',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(bookMatch[2])}`,
        })
        createReadStream(file).pipe(res)
        return
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('未找到')
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`服务错误: ${error.message}`)
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })
  const actualPort = server.address().port

  return {
    url: `${publicOrigin ?? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`}/opds`,
    port: actualPort,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}
