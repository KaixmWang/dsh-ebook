/** 书库：磁盘布局、索引、元数据。 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 插件私有数据子目录，存放元数据、章节索引、分章正文与译本。 */
const DATA_DIR = '.dsh-ebook'

/** 会被当作「原始文件」的扩展名。 */
const SOURCE_EXT = /\.(epub|pdf|mobi|azw3|txt)$/i

/**
 * 书名转目录名：保留中文，去掉路径非法字符。
 * @param {string} title 书名。
 * @returns {string}
 */
function slugify(title) {
  const cleaned = String(title)
    .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || 'untitled').slice(0, 80)
}

/**
 * 目录里所有可当原始文件的条目。
 * @param {string} dir 书目录。
 * @returns {string[]}
 */
function sourceCandidates(dir) {
  try {
    return readdirSync(dir).filter(name => SOURCE_EXT.test(name) && name !== 'book.epub')
  } catch {
    return []
  }
}

/**
 * 书库对象。
 */
export class Library {
  /**
   * @param {string} root 书库根目录。
   */
  constructor(root) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true })
  }

  /**
   * 某本书的目录。
   * @param {string} name 书名或目录名。
   * @returns {string}
   */
  bookDir(name) {
    return join(this.root, slugify(name))
  }

  /**
   * 确保书目录存在。
   * @param {string} name 书名。
   * @returns {string}
   */
  ensure(name) {
    const dir = this.bookDir(name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * 插件私有数据目录（元数据、章节索引、分章正文、译本）。
   * 放在书目录下的隐藏子目录里，书库文件夹里只看得到书本身。
   * @param {string} dir 书目录。
   * @returns {string}
   */
  dataDir(dir) {
    return join(dir, DATA_DIR)
  }

  /**
   * 找元数据文件，兼容早期的 `_meta.json` 平铺结构。
   * @param {string} dir 书目录。
   * @returns {string|null}
   */
  metaPath(dir) {
    const nested = join(dir, DATA_DIR, 'meta.json')
    if (existsSync(nested)) return nested
    const legacy = join(dir, '_meta.json')
    if (existsSync(legacy)) return legacy
    return null
  }

  /**
   * 写元数据。
   * @param {string} dir 书目录。
   * @param {object} meta 元数据。
   */
  writeMeta(dir, meta) {
    const dataDir = this.dataDir(dir)
    mkdirSync(dataDir, { recursive: true })
    const path = join(dataDir, 'meta.json')
    let previous = {}
    // 老结构里的内容要先读出来，避免迁移时丢字段
    const legacy = join(dir, '_meta.json')
    if (existsSync(legacy)) {
      try { previous = JSON.parse(readFileSync(legacy, 'utf8')) } catch { /* 忽略损坏 */ }
    }
    if (existsSync(path)) {
      try { previous = { ...previous, ...JSON.parse(readFileSync(path, 'utf8')) } } catch { /* 忽略损坏 */ }
    }
    writeFileSync(path, JSON.stringify({ ...previous, ...meta, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
  }

  /**
   * 读元数据。
   * @param {string} dir 书目录。
   * @returns {object}
   */
  readMeta(dir) {
    const path = this.metaPath(dir)
    if (!path) return {}
    try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
  }

  /**
   * 读章节索引。
   * @param {string} dir 书目录。
   * @returns {object|null}
   */
  readManifest(dir) {
    const nested = join(dir, DATA_DIR, 'manifest.json')
    const legacy = join(dir, 'manifest.json')
    const path = existsSync(nested) ? nested : (existsSync(legacy) ? legacy : null)
    if (!path) return null
    try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  }

  /**
   * 书目录里的全部书目录名。跳过 `.cache` 这类隐藏目录（插件的缓存与私有数据）。
   * @returns {string[]}
   */
  dirNames() {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
  }

  /**
   * 是否是一本书的目录：有元数据、有章节索引，或至少有一个原始文件。
   * 空目录（下载失败留下的）与缓存目录不算。
   * @param {string} dir 书目录。
   * @returns {boolean}
   */
  isBookDir(dir) {
    return Boolean(this.metaPath(dir))
      || existsSync(join(dir, DATA_DIR, 'manifest.json'))
      || existsSync(join(dir, 'manifest.json'))
      || sourceCandidates(dir).length > 0
  }

  /**
   * 书架列表。不含目录体积（对每本书递归 stat 太贵，界面也不需要）。
   * @returns {Array<object>}
   */
  list() {
    const rows = []
    for (const name of this.dirNames()) {
      const dir = join(this.root, name)
      if (!this.isBookDir(dir)) continue
      const manifest = this.readManifest(dir)
      const meta = this.readMeta(dir)
      const bookEpub = join(dir, 'book.epub')
      const sources = sourceCandidates(dir)
      const sourceFile = meta.sourceFile && existsSync(join(dir, meta.sourceFile))
        ? meta.sourceFile
        : (sources[0] ?? '')
      // 能给人读的 EPUB：优先生成的 book.epub，其次原始 EPUB
      const epubFile = existsSync(bookEpub) ? 'book.epub' : (sourceFile.toLowerCase().endsWith('.epub') ? sourceFile : '')
      rows.push({
        dir: name,
        path: dir,
        title: meta.title ?? manifest?.title ?? name,
        creator: meta.creator ?? '',
        language: meta.language ?? '',
        chapters: manifest?.chapters?.length ?? 0,
        chars: manifest?.chars ?? 0,
        translated: Boolean(meta.translated),
        ocr: Boolean(meta.ocr?.applied),
        sourceFile,
        epubFile,
        hasEpub: Boolean(epubFile),
        hasMarkdown: existsSync(join(dir, 'book.md')),
        updatedAt: meta.updatedAt ?? null,
      })
    }
    return rows.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  }

  /**
   * 书的数量（只做存在性检查，不解析 JSON，给状态接口用）。
   * @returns {number}
   */
  count() {
    return this.dirNames().filter(name => this.isBookDir(join(this.root, name))).length
  }

  /**
   * 找到某本书的目录：先精确目录名，再目录名互相包含，最后比对元数据标题。
   * 这样「置身事内」也能命中「置身事内 中国政府与经济发展【…】」这种超长书名。
   * @param {string} name 书名片段或目录名。
   * @returns {string|null}
   */
  find(name) {
    const exact = this.bookDir(name)
    if (existsSync(exact)) return exact
    const dirs = this.dirNames()
    if (dirs.length === 0) return null

    const needle = slugify(name).toLowerCase()

    // 目录名包含关系
    const byDir = dirs.find(dir => dir.toLowerCase().includes(needle))
    if (byDir) return join(this.root, byDir)

    // 反向包含：用户给了完整长名，目录是它的截断
    const byReverse = dirs.find(dir => needle.includes(dir.toLowerCase()))
    if (byReverse) return join(this.root, byReverse)

    // 比对元数据标题与逐字命中率
    const chars = [...needle].filter(char => /[\u4e00-\u9fa5a-z0-9]/.test(char))
    if (chars.length === 0) return null
    let best = null
    let bestScore = 0
    for (const dir of dirs) {
      const meta = this.readMeta(join(this.root, dir))
      const title = String(meta.title ?? dir).toLowerCase()
      if (title.includes(needle)) return join(this.root, dir)
      const score = chars.filter(char => title.includes(char)).length / chars.length
      if (score > bestScore) { bestScore = score; best = dir }
    }
    return bestScore >= 0.6 ? join(this.root, best) : null
  }
}
