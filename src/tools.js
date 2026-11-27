/** 工具定义：给 Agent 调用的能力。 */
import { join } from 'node:path'
import { searchAll, sourceNames } from './sources/index.js'
import { ingest, readChapters, translateBook } from './pipeline.js'
import { askBook } from './reading.js'

/**
 * 统一的文本输出渲染。
 * @param {unknown} _args 参数。
 * @param {any} value 结果值。
 * @returns {Array<object>}
 */
function textRender(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * 构造对象 schema。
 * @param {Record<string, unknown>} properties 属性。
 * @param {string[]} [required] 必填项。
 * @returns {object}
 */
function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * 构造全部工具。
 * @param {object} deps 依赖。
 * @param {() => object} deps.getConfig 取当前配置（设置页的账号与目录会覆盖静态配置）。
 * @param {() => object} deps.getLibrary 取当前书库（设置里可切换目录，所以每次现取）。
 * @param {object} deps.ai AI 客户端。
 * @param {(line:string)=>void} deps.log 日志。
 * @param {Map<string, any>} deps.servers 运行中的 OPDS 服务。
 * @returns {Array<object>}
 */
export function createTools(deps) {
  const { getConfig, getLibrary, ai, subagents, log, servers, localOcr } = deps
  const lib = () => getLibrary()
  const cfg = () => getConfig()

  return [
    {
      name: 'ebook_search',
      description:
        '搜书：LibGen / Internet Archive / 可选 Z-Library，中文书名直接搜，结果按可读性排序（epub 优先、超大全集降权）。把结果的 md5 与 source 原样交给 ebook_fetch。',
      parameters: objectSchema({
        query: { type: 'string', description: '书名、作者或 ISBN' },
        sources: { type: 'array', items: { type: 'string', enum: sourceNames() }, description: '限定书源，默认全部' },
        format: { type: 'string', description: '只要某格式，如 epub' },
        limit: { type: 'number', description: '条数，默认 10' },
      }, ['query']),
      output: { schema: { type: 'object' }, render: textRender },
      execute: async (args, exec) => {
        const { results, errors } = await searchAll(String(args.query), cfg(), {
          sources: args.sources,
          format: args.format,
          limit: args.limit ?? 10,
          signal: exec.signal,
        })
        return { query: args.query, count: results.length, results, errors }
      },
    },

    {
      name: 'ebook_fetch',
      description:
        '把一本书整理进书库：解析 EPUB / PDF，扫描件自动走 AI OCR，切章后产出 book.md 与分章；PDF 源另存一份 book.epub（EPUB 源直接用原文件，不复制）。来源三选一：md5 + source（从书源下载）、path（本地文件，如 ebook_library 返回的 sourcePath，可用于重做 OCR）。',
      parameters: objectSchema({
        md5: { type: 'string', description: 'ebook_search 返回的 md5 / archive identifier' },
        source: { type: 'string', enum: sourceNames(), description: '来源书源，与 md5 配对' },
        path: { type: 'string', description: '本地 PDF/EPUB 绝对路径，或库内书的 sourcePath' },
        title: { type: 'string', description: '入库书名，省略用检索到的标题' },
        ocr: { type: 'string', enum: ['auto', 'force', 'off'], description: 'auto 只补无文本层的页（默认），force 全本，off 关闭' },
        pages: { type: 'string', description: '限定 OCR 页码，如 "1-20,35"；省略则按 ocr 策略' },
      }),
      output: { schema: { type: 'object' }, render: textRender },
      timeoutMs: 1_800_000,
      execute: async (args, exec) => {
        const hasRemote = Boolean(args.md5)
        const hasPath = Boolean(args.path)
        if (!hasRemote && !hasPath) throw new Error('需要 md5 + source，或 path 之一')

        const row = hasPath
          ? { path: String(args.path), source: 'local', md5: String(args.path), title: args.title ?? '' }
          : {
              md5: String(args.md5),
              source: String(args.source ?? ''),
              title: args.title ?? '',
              extension: '',
            }
        if (hasRemote && !args.source) throw new Error('从书源下载时必须同时给 source')

        return ingest({ library: lib(), config: cfg(), ai, localOcr, log, signal: exec.signal }, row, {
          title: args.title,
          ocr: args.ocr ?? 'auto',
          pages: args.pages,
        })
      },
    },

    {
      name: 'ebook_translate',
      description:
        '把库内一本书整本翻译成目标语言：逐章落盘、可断点续跑（重跑自动跳过已译章节），产出 book.<lang>.md 与 book.<lang>.epub。只翻一两段时不必用它，直接读原文自己译更省。',
      parameters: objectSchema({
        title: { type: 'string', description: '书名，可只给片段' },
        target: { type: 'string', description: '目标语言，默认简体中文' },
      }, ['title']),
      output: { schema: { type: 'object' }, render: textRender },
      timeoutMs: 3_600_000,
      execute: async (args, exec) => translateBook(
        {
          library: lib(),
          ai,
          // 子代理模式需要服务与发起方；缺任一条件 translateBook 会自动退回直接调用
          subagents,
          agent: exec.agent,
          log,
          signal: exec.signal,
        },
        String(args.title),
        { target: args.target, viaSubagent: cfg().viaSubagent === true },
      ),
    },

    {
      name: 'ebook_ask',
      description:
        '就书库里的一本书提问：插件在本地读章节，交给「阅读模型」整理后只把答案带回来，原文不占主对话 token。'
        + '适合「这本书讲了什么」「作者怎么论证 X」「第三部分的关键结论」这类问题；'
        + '需要逐字原文时才用 ebook_read。阅读模型在插件设置里单独指定（默认跟随会话模型），'
        + '长书会分批摘录再汇总。',
      parameters: objectSchema({
        title: { type: 'string', description: '书名，可只给片段' },
        question: { type: 'string', description: '要问的问题' },
        start: { type: 'number', description: '起始章（1 起），默认全书' },
        end: { type: 'number', description: '结束章' },
        maxChars: { type: 'number', description: '最多读多少字，默认 240000' },
      }, ['title', 'question']),
      output: { schema: { type: 'object' }, render: textRender },
      timeoutMs: 900_000,
      execute: async (args, exec) => askBook(
        { library: lib(), ai, log, signal: exec.signal },
        String(args.title),
        String(args.question),
        { start: args.start, end: args.end, maxChars: args.maxChars },
      ),
    },

    {
      name: 'ebook_read',
      description:
        '按章读取库内的书给模型读。默认一次 3 章、上限 30000 字，返回 nextStart 供继续。'
        + '注意：原文会进入主对话并随每轮重发，读整本很费 token；只想问问题请用 ebook_ask。',
      parameters: objectSchema({
        title: { type: 'string', description: '书名，可只给片段' },
        start: { type: 'number', description: '起始章（1 起），默认 1' },
        end: { type: 'number', description: '结束章，省略按 start 起 3 章' },
        maxChars: { type: 'number', description: '字数预算，默认 30000，上限 60000' },
      }, ['title']),
      output: { schema: { type: 'object' }, render: textRender },
      execute: async args => readChapters(lib(), String(args.title), {
        start: Number(args.start ?? 1),
        end: args.end === undefined ? undefined : Number(args.end),
        maxChars: Math.min(60000, Number(args.maxChars ?? 30000)),
      }),
    },

    {
      name: 'ebook_library',
      description:
        '书架状态：每本书的章节数、字数、是否已 OCR / 已翻译、sourcePath（可用于 ebook_fetch 重做 OCR）、epubFile（可读 EPUB 文件名），以及 OPDS 地址。',
      parameters: objectSchema({}),
      output: { schema: { type: 'object' }, render: textRender },
      execute: async () => {
        const current = lib()
        const books = current.list().map(book => {
          const dir = join(current.root, book.dir)
          const meta = current.readMeta(dir)
          // 优先用入库时记录的实际文件名；老数据回退到 source.<format>
          const sourceFile = meta.sourceFile ?? `source.${meta.format ?? 'epub'}`
          return { ...book, sourcePath: join(dir, sourceFile) }
        })
        return {
          root: current.root,
          count: books.length,
          books,
          opds: [...new Set([...servers.values()].map(server => server.url))],
        }
      },
    },
  ]
}
