/**
 * 联网查书籍信息（简介、评分、出版社、封面）。
 *
 * 主源是微信读书书城：中文书覆盖全，`intro` 字段就是完整内容简介，
 * 还附带评分、出版社、译者。而且用户已经在插件里登录了微信读书，
 * 这条通道天然可用。
 *
 * 兜底是豆瓣：不需要凭据，但简介常常是空的或只有元数据。
 */
import { request } from './http.js'
import { mintAccessToken } from './push/weread.js'

const BASE = 'https://i.weread.qq.com'
const UA = 'WeRead/2.1.2 WRBrand/Onyx wr_eink Dalvik/2.1.0 (Linux; U; Android 11; BOOX Build/onyx)'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 固定的墨水屏请求头。
 * @returns {Record<string,string>}
 */
function versionHeaders() {
  return {
    baseapi: '30',
    appver: '2.1.2.10245900',
    basever: '2.1.2.10245900',
    osver: '11',
    channelId: '900',
    'User-Agent': UA,
  }
}

/**
 * 书名相似度打分，用来在搜索结果里挑最像的一本。
 * @param {string} a 书名。
 * @param {string} b 书名。
 * @returns {number} 0~1。
 */
function similarity(a, b) {
  const clean = text => String(text ?? '').toLowerCase().replace(/[\s:：·・,，.。()（）\[\]【】\-—_]/g, '')
  const x = clean(a)
  const y = clean(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.includes(y) || y.includes(x)) return Math.min(x.length, y.length) / Math.max(x.length, y.length)
  // 按字符重合度兜底
  const setY = new Set(y)
  let hit = 0
  for (const ch of new Set(x)) if (setY.has(ch)) hit++
  return hit / Math.max(new Set(x).size, setY.size)
}

/**
 * 用微信读书书城查书籍信息。
 * @param {object} params 参数。
 * @param {string} params.title 书名。
 * @param {string} [params.author] 作者。
 * @param {object} params.credentials 微信读书凭据。
 * @param {AbortSignal} [params.signal] 取消信号。
 * @returns {Promise<object|null>}
 */
async function lookupViaWeread(params) {
  const { title, author, credentials, signal } = params
  if (!credentials?.refreshToken || !credentials?.deviceId) return null

  const auth = await mintAccessToken(credentials, { signal })
  const url = `${BASE}/store/search?keyword=${encodeURIComponent(title)}&scope=10&count=5&maxIdx=0`
  const response = await request(url, {
    timeout: 25_000,
    retries: 1,
    maxRedirects: 3,
    signal,
    headers: {
      ...versionHeaders(),
      vid: auth.vid || credentials.vid,
      accessToken: auth.accessToken,
    },
  })
  if (!response.ok) return null

  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }

  const books = data.books ?? []
  if (books.length === 0) return null

  // 挑书名最接近的；作者能对上再加一点分
  let best = null
  let bestScore = 0
  for (const book of books) {
    const info = book.bookInfo ?? book
    let score = similarity(title, info.title)
    if (author && info.author && similarity(author, info.author) > 0.5) score += 0.15
    if (score > bestScore) {
      bestScore = score
      best = info
    }
  }
  if (!best || bestScore < 0.35) return null

  const rating = Number(best.newRating ?? 0)
  // newRating 是推荐值整数：常见为 0~1000（也有 0~100 的旧数据），统一换算成 5 星制
  const stars = rating > 0
    ? Math.round((rating > 100 ? rating / 200 : rating / 20) * 10) / 10
    : 0
  return {
    source: '微信读书',
    matchedTitle: best.title ?? '',
    matchedAuthor: best.author ?? '',
    intro: String(best.intro ?? '').replace(/\s+/g, ' ').trim(),
    publisher: String(best.publisher ?? ''),
    translator: String(best.translator ?? ''),
    rating: Math.min(5, stars),
    ratingCount: Number(best.newRatingCount ?? 0),
    cover: String(best.cover ?? ''),
    deepLink: String(best.deepLink ?? ''),
  }
}

/**
 * 用豆瓣兜底（不需要凭据）。
 * @param {object} params 参数。
 * @returns {Promise<object|null>}
 */
async function lookupViaDouban(params) {
  const { title, author, signal } = params
  const query = [title, author].filter(Boolean).join(' ')
  const searchResponse = await request(
    `https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(query)}`,
    {
      timeout: 20_000, retries: 1, maxRedirects: 5, signal,
      headers: { 'user-agent': BROWSER_UA, Accept: 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' },
    },
  )
  if (!searchResponse.ok) return null
  const searchHtml = Buffer.from(await searchResponse.arrayBuffer()).toString('utf8')
  const id = /subject\/(\d{6,})\//.exec(searchHtml)?.[1]
  if (!id) return null

  const detailResponse = await request(`https://book.douban.com/subject/${id}/`, {
    timeout: 20_000, retries: 0, maxRedirects: 5, signal,
    headers: { 'user-agent': BROWSER_UA, Accept: 'text/html', Referer: 'https://book.douban.com/' },
  })
  if (!detailResponse.ok) return null
  const html = Buffer.from(await detailResponse.arrayBuffer()).toString('utf8')

  // 简介在 <div class="intro"> 里，可能有多段
  const introBlock = /<div class="intro">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ''
  const intro = introBlock
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
  if (!intro) return null

  const rating = /<strong[^>]*class="[^"]*rating_num[^"]*"[^>]*>([\d.]+)</.exec(html)?.[1]
  return {
    source: '豆瓣',
    matchedTitle: title,
    matchedAuthor: author ?? '',
    intro,
    publisher: '',
    translator: '',
    rating: rating ? Number(rating) : 0,
    ratingCount: 0,
    cover: '',
    deepLink: `https://book.douban.com/subject/${id}/`,
  }
}

/**
 * 查一本书的信息：先微信读书，再豆瓣。
 * @param {object} params 参数。
 * @param {string} params.title 书名。
 * @param {string} [params.author] 作者。
 * @param {object} [params.credentials] 微信读书凭据。
 * @param {AbortSignal} [params.signal] 取消信号。
 * @returns {Promise<object|null>}
 */
export async function lookupBookInfo(params) {
  const errors = []
  if (params.credentials?.refreshToken) {
    try {
      const hit = await lookupViaWeread(params)
      if (hit?.intro) return hit
    } catch (error) {
      errors.push(`微信读书：${error.message}`)
    }
  }
  try {
    const hit = await lookupViaDouban(params)
    if (hit?.intro) return hit
  } catch (error) {
    errors.push(`豆瓣：${error.message}`)
  }
  if (errors.length) throw new Error(errors.join('；'))
  return null
}
