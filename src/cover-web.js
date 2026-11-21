/**
 * 从互联网找封面。
 *
 * 中文书只走豆瓣：实测 200 + 每条 10~15 张候选，图片直链可取大图。
 * Google Books 无 key 时常被 429 限流，OpenLibrary 对中文书命中率很低，
 * 所以顺序是 豆瓣 → 都不行再让用户手填图片地址。
 */
import { request } from './http.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 豆瓣图片直链的匹配。 */
const COVER_PATTERN = /https:\/\/img\d\.doubanio\.com\/view\/subject\/[a-z]\/public\/s\d+\.jpg/g

/**
 * 把任意尺寸的豆瓣封面地址换到大图。
 * s = 小图、m = 中图、l = 大图、raw = 原图。
 * @param {string} url 原始地址。
 * @param {'l'|'raw'} size 目标尺寸。
 * @returns {string}
 */
function upgradeSize(url, size = 'l') {
  return url.replace(/\/view\/subject\/[a-z]\//, `/view/subject/${size}/`)
}

/**
 * 按书名（可带作者）搜索封面候选。
 * @param {object} params 参数。
 * @param {string} params.title 书名。
 * @param {string} [params.author] 作者。
 * @param {AbortSignal} [params.signal] 取消信号。
 * @returns {Promise<Array<{url:string, thumb:string, source:string}>>}
 */
export async function findCovers(params) {
  const { title, author, signal } = params
  const query = [title, author].filter(Boolean).join(' ').trim()
  if (!query) return []

  const response = await request(
    `https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(query)}`,
    {
      signal,
      timeout: 25_000,
      retries: 1,
      maxRedirects: 5,
      headers: {
        'user-agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    },
  )
  if (!response.ok) throw new Error(`豆瓣搜索返回 HTTP ${response.status}`)

  const html = Buffer.from(await response.arrayBuffer()).toString('utf8')
  const found = new Set()
  for (const match of html.matchAll(COVER_PATTERN)) {
    found.add(match[0])
    if (found.size >= 12) break
  }

  return [...found].map(url => ({
    // 大图用于保存，中图用于列表预览（省流量）
    url: upgradeSize(url, 'l'),
    thumb: url,
    source: '豆瓣',
  }))
}

/**
 * 下载一张封面图并落盘。
 * @param {object} params 参数。
 * @param {string} params.url 图片地址。
 * @param {string} params.targetPath 保存路径（含扩展名）。
 * @param {AbortSignal} [params.signal] 取消信号。
 * @returns {Promise<{bytes:number, mediaType:string}>}
 */
export async function downloadCover(params) {
  const { url, targetPath, signal } = params
  const response = await request(url, {
    signal,
    timeout: 45_000,
    retries: 1,
    maxRedirects: 5,
    headers: {
      'user-agent': UA,
      // 豆瓣图床会校验来源页
      Referer: 'https://book.douban.com/',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  })
  if (!response.ok) throw new Error(`取图返回 HTTP ${response.status}`)

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length < 1024) throw new Error('图片内容过小，可能被拦截')
  // JPEG / PNG / WebP 的文件头校验，防止把错误页当成图存下来
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50
  const isWebp = buffer.subarray(0, 4).toString('ascii') === 'RIFF'
  if (!isJpeg && !isPng && !isWebp) throw new Error('返回的不是图片')

  const { writeFileSync } = await import('node:fs')
  writeFileSync(targetPath, buffer)
  return {
    bytes: buffer.length,
    mediaType: isPng ? 'image/png' : isWebp ? 'image/webp' : 'image/jpeg',
  }
}
