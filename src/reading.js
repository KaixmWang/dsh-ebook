/**
 * 「阅读」：在本地读书，只把答案带回主对话。
 *
 * 为什么要有这一层：`ebook_read` 不调用模型，它把章节原文放进工具结果，
 * 这些 token 会留在主对话里并随每一轮重发——书越大越贵。这里改成
 * 「本地读原文 → 用可单独配置的阅读模型整理 → 只回答案」，
 * 原文不进入主对话，成本只花在阅读模型那一次（或几次）调用上。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 单批送给模型的原文上限（字符）。 */
const DEFAULT_BATCH_CHARS = 24000

/** 整本书默认最多读多少字，防止一本超长合集把费用拉爆。 */
const DEFAULT_MAX_CHARS = 240000

/** 摘录阶段每批最多产出多少字。 */
const EXTRACT_CHARS = 900

/**
 * 按字数把章节切成若干批，章节不跨批。
 * @param {Array<{index:number, title:string, text:string}>} chapters 章节。
 * @param {number} batchChars 单批字数上限。
 * @returns {Array<Array<{index:number, title:string, text:string}>>}
 */
function batchChapters(chapters, batchChars) {
  const batches = []
  let current = []
  let size = 0
  for (const chapter of chapters) {
    const length = chapter.text.length
    if (current.length > 0 && size + length > batchChars) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(chapter)
    size += length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * 把一批章节拼成给模型看的文本。
 * @param {Array<{index:number, title:string, text:string}>} batch 一批章节。
 * @returns {string}
 */
function renderBatch(batch) {
  return batch
    .map(chapter => `【第 ${chapter.index} 章 ${chapter.title}】\n${chapter.text}`)
    .join('\n\n')
}

/**
 * 就一本书提问：本地读原文，用阅读模型整理，只返回答案。
 *
 * @param {object} deps 依赖。
 * @param {object} deps.library 书库实例。
 * @param {object} deps.ai AI 客户端（route/complete）。
 * @param {(line:string)=>void} [deps.log] 日志。
 * @param {AbortSignal} [deps.signal] 取消信号。
 * @param {string} name 书名（可为片段）。
 * @param {string} question 问题。
 * @param {object} [options] 选项。
 * @param {number} [options.start] 起始章（1 起）。
 * @param {number} [options.end] 结束章。
 * @param {number} [options.maxChars] 全书读取上限。
 * @param {number} [options.batchChars] 单批字符上限。
 * @returns {Promise<object>}
 */
export async function askBook(deps, name, question, options = {}) {
  const { library, ai, log = () => {}, signal } = deps
  if (!ai) throw new Error('当前环境没有可用的 llm 服务')
  const prompt = String(question ?? '').trim()
  if (!prompt) throw new Error('请给出要问的问题')

  const dir = library.find(name)
  if (!dir) throw new Error(`书库里没有《${name}》`)
  const manifest = library.readManifest(dir)
  if (!manifest) throw new Error(`《${name}》还没有整理过（缺 manifest.json）`)

  const total = manifest.chapters.length
  const from = Math.max(1, Number(options.start ?? 1))
  const to = Math.min(total, Number(options.end ?? total))
  const maxChars = Math.max(4000, Number(options.maxChars ?? DEFAULT_MAX_CHARS))
  const batchChars = Math.max(4000, Number(options.batchChars ?? DEFAULT_BATCH_CHARS))

  // 只读指定范围内的章节，并且受总字数预算限制
  const chapters = []
  let budget = maxChars
  let truncated = false
  for (let i = from; i <= to; i++) {
    const entry = manifest.chapters[i - 1]
    if (!entry) continue
    const path = join(dir, entry.file)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    if (text.length > budget) {
      chapters.push({ index: i, title: entry.title, text: text.slice(0, budget) })
      truncated = true
      break
    }
    chapters.push({ index: i, title: entry.title, text })
    budget -= text.length
    if (budget <= 0) { truncated = true; break }
  }
  if (chapters.length === 0) throw new Error(`《${name}》在指定范围内没有可读的章节`)

  const readChars = chapters.reduce((sum, chapter) => sum + chapter.text.length, 0)
  const batches = batchChapters(chapters, batchChars)
  const used = ai.route('read')
  log(`阅读《${manifest.title}》第 ${chapters[0].index}-${chapters[chapters.length - 1].index} 章，共 ${readChars} 字，${batches.length} 批（模型 ${used.provider}/${used.model}）`)

  const system = '你是严谨的读书助手。只依据用户提供的书稿内容回答，不要引入书外知识；'
    + '引用时标注章号；书稿里没有依据就直说「书中没有提到」。'

  let answer
  if (batches.length === 1) {
    answer = await ai.complete({
      system,
      prompt: [
        `下面是《${manifest.title}》的正文。`,
        '',
        renderBatch(batches[0]),
        '',
        '---',
        `问题：${prompt}`,
        '',
        '要求：先给结论，再给依据（引用第几章），最后可给一句延伸提醒。总长控制在 800 字以内。',
      ].join('\n'),
      maxTokens: 2048,
      temperature: 0.2,
      role: 'read',
      signal,
    })
  } else {
    // 多批：先让模型逐批摘录与问题相关的信息，再基于摘录作答
    const extracts = []
    for (let i = 0; i < batches.length; i++) {
      if (signal?.aborted) throw signal.reason ?? new Error('已取消')
      log(`摘录第 ${i + 1}/${batches.length} 批`)
      const extract = await ai.complete({
        system,
        prompt: [
          `下面是《${manifest.title}》的一部分正文（第 ${batches[i][0].index}-${batches[i][batches[i].length - 1].index} 章）。`,
          '',
          renderBatch(batches[i]),
          '',
          '---',
          `问题：${prompt}`,
          '',
          `要求：只摘出与问题相关的原文要点，逐条写，每条尽量带章号；与本问题无关就只回「无关」。最多 ${EXTRACT_CHARS} 字。`,
        ].join('\n'),
        maxTokens: 1024,
        temperature: 0.1,
        role: 'read',
        signal,
      })
      if (extract && !/^无关[。.]?$/.test(extract.trim())) extracts.push(extract)
    }

    if (extracts.length === 0) {
      answer = '读完指定范围后没有找到与该问题相关的内容。可以换个问法，或用 ebook_read 直接看原文。'
    } else {
      const merged = extracts.join('\n\n').slice(0, Math.max(8000, batchChars))
      answer = await ai.complete({
        system,
        prompt: [
          `下面是《${manifest.title}》的若干摘录（已由前一步从原文中挑出）。`,
          '',
          merged,
          '',
          '---',
          `问题：${prompt}`,
          '',
          '要求：只依据摘录作答，先给结论再给依据（引用章号）；摘录不足就说明不足。总长控制在 800 字以内。',
        ].join('\n'),
        maxTokens: 2048,
        temperature: 0.2,
        role: 'read',
        signal,
      })
    }
    log(`摘录完成：${extracts.length}/${batches.length} 批有相关内容`)
  }

  return {
    title: manifest.title,
    question: prompt,
    answer,
    chapterRange: [chapters[0].index, chapters[chapters.length - 1].index],
    totalChapters: total,
    chars: readChars,
    batches: batches.length,
    truncated,
    model: { provider: used.provider, model: used.model },
    note: '原文只在插件内部读取，未进入主对话；答案由「阅读模型」生成。',
  }
}
