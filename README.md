# dsh-ebook

DeepSeek Harness插件，给人和 AI 读的电子书库：**搜书 → 取书 → OCR → 翻译 → 推送微信读书**。
EPUB / PDF 解析后产出 Markdown 分章（给模型读）与人可读的 EPUB，前端有一个封面书库。

## 安装

插件以 DSH bundle 形式分发，装进 profile 后重启 DSH 生效。

**从 GitHub Release 安装（推荐）**，在 profile 目录（`~/.dsh/profiles/<name>`）里：

```bash
pnpm add https://github.com/KaixmWang/dsh-ebook/releases/download/v0.5.2/dsh-ebook-0.5.2.tgz
```

然后把 `dsh-ebook` 加进该目录 `package.json` 的 `dsh.profile.bundles`：

```json
{ "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-ebook"] } } }
```

**直接从仓库安装**（不带 release 也能跑，会拉整个仓库）：

```bash
pnpm add github:KaixmWang/dsh-ebook
```

**发布到 npm 后**：`pnpm add dsh-ebook`。

装好后侧栏出现「书库」图标；设置在该插件的详情页（插件 → 电子书库）。

## 能力

| 能力 | 说明 |
| --- | --- |
| 取书 | LibGen（多镜像池 + 延迟排序 + 失败冷却 + 断点续传 + MD5 校验）、Z-Library（eAPI，需账号）、Internet Archive（advancedsearch + metadata） |
| OCR | 扫描版 PDF 逐页渲染成图，交视觉模型识别；并发 3 页；空结果自动重试一次 |
| 翻译 | 逐章翻译、断点续跑、可选子代理模式；OCR 与翻译可各配一套模型 |
| 书库 | 封面（内嵌图 / PDF 首页 / 豆瓣候选）、简介与评分（微信读书优先、豆瓣兜底）、删除、用系统程序打开 |
| 推送 | 一键推到微信读书书架（COS 三段导入）；有译本时先选推原书还是译本，支持扫码登录与今日配额查询 |
| 阅读 | 5 个工具供模型按章读；另有 OPDS 目录，KOReader 等阅读器直接拉书 |

## 工具

| 工具 | 作用 |
| --- | --- |
| `ebook_search` | 聚合检索，按可读性排序（epub 优先、重复条目合并、超大合集降权） |
| `ebook_fetch` | 下载或读本地文件 → 解析 → 补封面与简介 → 自动 OCR → 切章 |
| `ebook_translate` | 按章翻译，逐章落盘、可断点续跑 |
| `ebook_read` | 按章读书给模型，带字数预算与 `nextStart` |
| `ebook_library` | 书架状态：章节数、字数、是否已 OCR / 已翻译、`sourcePath`、OPDS 地址 |

OPDS 不占工具位：`opds.autoStart: true` 时插件加载即启动，阅读器加地址就能拉书。

## 取书的两条路

```
书源路线：ebook_search → 拿 md5 + source → ebook_fetch
本地路线：ebook_fetch({ path: 'D:/books/x.pdf' })
```

`path` 也能接 `ebook_library` 返回的 `sourcePath`，用于对已入库的书重做 OCR：

```
ebook_fetch({ path: '…/source.pdf', ocr: 'force', pages: '3-9' })
```

## 推到微信读书

书库详情页点「推送到微信读书」即可，走墨水屏端接口（COS 三段导入：取凭证 → 上传 → notify）。

**有多个版本时先选版本**：如果这本书已经翻译过，点推送会先列出「原书（EPUB）／中文译本（EPUB）」等选项，点一个才推。
只有一个版本时直接推送，不打断操作。译本在微信读书里按「书名（语言）」入库，原书按书名入库。

前置条件是 `refreshToken` 与 `deviceId`：

- **扫码**：设置页的「微信读书」里点「显示二维码」，手机微信扫码确认，凭据自动保存
- **手填**：从微信读书 App / 墨水屏端抓包拿到 `refreshToken` 与 `deviceId` 后填进去

Kindle 推送没有实现：生成 `book.epub` 后用邮箱发到你的 `@kindle.com` 地址即可。

## 关键实现

- **零外部工具依赖**：EPUB 解析与生成用自写 ZIP 读写器（`src/zip.js`，只依赖 `node:zlib`）。
- **PDF**：`pdfjs-dist` 取文本层；无文本层的页用 `@napi-rs/canvas` 渲染成 PNG 交给视觉模型。
- **OCR / 翻译**：走 DSH 的 `llm` 服务，复用你已在 DSH 配好的模型与凭据，插件自己不留 key。
- **视觉 OCR** 还需要 DSH 的 `attachments` 服务把图片存成附件引用；宿主没有该服务时 OCR 会明确报错而不是静默失败。
- **网络**：默认读 Windows 系统代理（Clash/V2Ray 之类），因为 Node 的 fetch 不会自动走系统代理；可用 `proxy` 配置项覆盖。

## 取书层为什么不容易失败

单镜像取书在 LibGen 上经常失败（镜像抽风、下载 key 过期、服务器传一半断连、慢到超时）。取书层按下面几层兜底：

| 机制 | 作用 |
| --- | --- |
| **镜像池** | 从 shadowlibraries 权威目录拉实时镜像列表（缓存在插件数据目录，24h） |
| **延迟探测** | 下载前并发探一遍，按实际延迟排序，不盲试第一个 |
| **失败冷却** | 瞬时故障（超时 / 5xx / 429）冷却 45 秒；确定性故障（403/404）本轮摘除 |
| **启动重试** | 拿不到第一个字节就退避重试，**每次重新解析直链**——镜像发的一次性 key 会过期 |
| **stall guard** | 不设全局超时。只有连续 45 秒没有新字节才判死；慢速传输不会被误杀 |
| **断点续传** | 中断保留 `.part`，重下时用 `Range` 续传 |
| **完整性校验** | 下完比对 MD5；返回 HTML 错误页会被识别并丢弃 |

## OCR 怎么做

| 步骤 | 做法 |
| --- | --- |
| 1. 文本层优先 | PDF 自带文本层就直接用 `pdfjs-dist` 提取，绝不渲染 |
| 2. 渲染 | 无文本层的页用 `@napi-rs/canvas` 渲染成 PNG（2.2 倍缩放，上限 1700px 宽） |
| 3. 视觉识别 | 交给视觉模型逐页识别，提示词里约束了双栏顺序、页眉页脚剔除、竖排转换 |
| 4. 并发 | 多页并行（3 并发）；某页返回空文本时同页重试一次再记失败 |

**每页一次模型调用**，按页计费。想控成本就把 **设置 → 任务模型 → OCR 模型** 指到一个便宜的视觉模型。
`ocr` 参数三档：`auto` 只补无文本层的页、`force` 全本重做、`off` 关闭。

## 设置面板

配置界面在**插件页 → 电子书库**的详情里（不占用 DSH 通用设置页）。

**下载目录**
- 「选择目录…」调 Windows 原生目录对话框，选完**先校验再保存**
- 也可以直接填路径，回车或点「保存并切换」
- 切换只影响后续下载，已有的书留在原处

**任务模型**
- OCR 与翻译各用一套模型，只影响插件内部调用，不改你当前会话的模型
- OCR 下拉只列声明支持图片的模型
- **「翻译交给子代理执行」**：开启后每章在独立会话里翻译，可多轮自查，代价是明显更慢；子代理失败会自动回退到直接调用

**微信读书**
- 扫码登录（插件内直接出二维码）、手动填凭据、删除凭据
- 账号卡片显示今日配额（如 `今日 4/10`）

**取书平台账号**
- 只列需要登录的平台（Z-Library）。LibGen 与 Internet Archive 无需账号，照样参与搜索
- Z-Library 走 eAPI，填邮箱密码直接登录，不需要浏览器、不需要粘 Cookie
- 账号存本机 `$DSH_HOME/dsh-ebook/settings.json`；接口返回的账号信息不含密码与 cookie

**书源可达性**
- 一键探测各书源的**实际接口**（不是首页）：LibGen 每个镜像单独列，Z-Library 探 eAPI，Internet Archive 探搜索 API

## 配置

`libraryDir` 只是**首次启动的默认值**，之后以设置面板保存的目录为准。

```yaml
- insert:
    - id: dsh-ebook
      name: dsh-ebook
      config:
        libraryDir: ''                       # 留空用默认（~/Documents/dsh-ebook-library）
        proxy: 'auto'                        # auto 读系统代理；'' 直连；或 http://host:port
        maxBytes: 314572800                  # 单本书体积上限
        maxCharsPerChapter: 40000            # 单章字数上限，超长按段落再切
        llm:
          provider: ''                       # 留空跟随会话默认模型
          model: ''
          ocr: { provider: '', model: '' }   # 视觉 OCR 专用模型（需支持图片）
          translate: { provider: '', model: '' }
        zlib:                                # 设置面板里配了账号时，账号优先
          domain: ''
          cookie: ''
        opds: { port: 8899, host: 127.0.0.1, autoStart: true }
```

## 产物结构

```
书库/{书名}/
  source.epub | 书名.pdf      原始文件（保留服务器给的原名，重名加序号）
  cover.png|jpg               封面（EPUB 内嵌图 / PDF 首页 / 联网选图）
  book.md                     给 AI 读（全书）
  book.epub                   仅 PDF 源生成；EPUB 源直接用原文件，不复制一份
  book.zh.md / book.zh.epub   译本（语言后缀随目标语言）
  .dsh-ebook/
    meta.json                 书名、作者、简介、评分、源文件记录
    manifest.json             章节索引
    chapters/0001-*.md        分章正文
    translated/0001.md        译文缓存
```

插件自己的数据在 `$DSH_HOME/dsh-ebook/`：`settings.json`（目录、账号、模型、凭据）与 `cache/`（镜像列表缓存）。

## 本地接口与安全

- 设置与书库接口挂在 `/dsh-ebook/api`，**只接受本机回环或同源请求**，写操作还要求 `x-dsh-ebook: 1` 请求头（浏览器跨站请求带它会触发预检，从而被挡住）
- 账号密码、cookie、微信读书令牌保存在本机 `settings.json`；接口不回传密码、cookie 与 refreshToken，只回「有没有存过」
- 书目录相关接口只接受书库根下的一级目录名，`..`、`.` 与含分隔符的名字一律拒绝
- OPDS **没有鉴权**，默认只监听 `127.0.0.1`；要给手机 / 阅读器用才改成 `0.0.0.0`

## 限制

- Z-Library 需要账号；额度用完会直接给明确提示
- OCR 质量取决于所配视觉模型；认不出的字由模型用 `▢` 占位，失败页码记入 `meta.json`
- mobi / azw3 只登记不解析，要正文请选 epub 或 pdf
- 直连境外书源通常需要代理

## 开发

```bash
pnpm install
# 插件通过 profile 的 link: 依赖加载，改完在插件页关闭再开启即可重载
```

- 源码全部 ESM，无构建步骤
- 改 `client.js` 后重载插件并刷新页面（插件页底部会显示界面构建时间，用来确认浏览器加载的是新代码）
