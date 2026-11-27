# dsh-ebook

**给人和 AI 读的电子书库**：搜书 → 取书 → OCR → 翻译 → 推送微信读书。

DSH（DeepSeek Harness）插件。EPUB / PDF 解析后产出 Markdown 分章给模型读、EPUB 给人读，前端带一个封面书库；
扫描件可以走视觉模型，也可以**下载 0.8B 的 Xiaomi-OCR-0 在本地离线识别**。

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.7.0-blue)](https://github.com/KaixmWang/dsh-ebook/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#已知限制)

## 功能

| 能力 | 说明 |
| --- | --- |
| 取书 | LibGen（多镜像池、延迟排序、失败冷却、断点续传、MD5 校验）、Z-Library（eAPI，需账号）、Internet Archive |
| OCR | 扫描版 PDF 逐页渲染后识别：默认交视觉模型，也可用本地 Xiaomi-OCR-0 离线识别；失败自动回退 |
| 翻译 | 逐章翻译、断点续跑、可选子代理模式；OCR / 翻译 / 阅读各配一套模型 |
| 阅读 | `ebook_ask` 只把答案带回主对话（省 token），`ebook_read` 需要逐字原文时用 |
| 书库 | 封面（内嵌图 / PDF 首页 / 豆瓣候选）、简介与评分（微信读书优先、豆瓣兜底）、删除、系统程序打开 |
| 推送 | 一键推到微信读书书架（COS 三段导入）；有译本时先选推哪个版本；扫码登录 + 今日配额 |
| 更新 | 设置页「关于与更新」查 GitHub Releases，有新版本给提示与发布页入口（不自动安装） |
| 阅读器 | OPDS 目录，KOReader / 静读天下 / Moon+ 直接拉书 |

## 安装

插件以 DSH bundle 形式分发，装进 profile 后重启 DSH 生效。

**从 GitHub Release 安装（推荐）** —— 在 profile 目录（`~/.dsh/profiles/<name>`，Windows 下是 `C:\Users\<你>\.dsh\profiles\desktop`）里：

```bash
pnpm add https://github.com/KaixmWang/dsh-ebook/releases/download/v0.7.0/dsh-ebook-0.7.0.tgz
```

再把 `dsh-ebook` 加进同目录 `package.json` 的 `dsh.profile.bundles`：

```json
{ "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-ebook"] } } }
```

**直接从仓库安装**（会拉整个仓库，适合追最新提交）：

```bash
pnpm add github:KaixmWang/dsh-ebook
```

**发布到 npm 之后**：`pnpm add dsh-ebook`。

装好重启，侧栏出现「书库」图标；设置在该插件的详情页（插件 → 电子书库）。

## 六个工具

| 工具 | 作用 |
| --- | --- |
| `ebook_search` | 聚合检索，按可读性排序（epub 优先、重复条目合并、超大合集降权） |
| `ebook_fetch` | 下载或读本地文件 → 解析 → 补封面简介 → 自动 OCR → 切章 → 生成 EPUB / Markdown |
| `ebook_translate` | 按章翻译，逐章落盘、可断点续跑 |
| `ebook_ask` | 就一本书提问：本地读章节，交给阅读模型整理，只回答案，原文不进主对话 |
| `ebook_read` | 按章把原文读给模型，带字数预算与 `nextStart`（原文会进主对话，费 token） |
| `ebook_library` | 书架状态：章节数、字数、是否已 OCR / 已翻译、`sourcePath`、OPDS 地址 |

OPDS 不占工具位：`opds.autoStart: true` 时插件加载即启动，阅读器加地址就能拉书。

## 典型流程

```
找书    ebook_search({ query: '置身事内' })
入库    ebook_fetch({ md5, source: 'libgen' })        或  ebook_fetch({ path: 'D:/books/x.pdf' })
提问    ebook_ask({ title: '置身事内', question: '作者怎么解释土地财政？' })
翻译    ebook_translate({ title: '置身事内', target: 'English' })
推送    书库详情页 → 推送到微信读书 → 选原书或译本
```

`path` 也能接 `ebook_library` 返回的 `sourcePath`，用来对已入库的书重做 OCR：

```
ebook_fetch({ path: '…/书名.pdf', ocr: 'force', pages: '3-9' })
```

## 取书层为什么不容易失败

单镜像取书在 LibGen 上经常失败（镜像抽风、下载 key 过期、传一半断连、慢到超时）。取书层按下面几层兜底：

| 机制 | 作用 |
| --- | --- |
| 镜像池 | 从 shadowlibraries 权威目录拉实时镜像列表（缓存在插件数据目录，24h） |
| 延迟探测 | 下载前并发探一遍，按实际延迟排序，不盲试第一个 |
| 失败冷却 | 瞬时故障（超时 / 5xx / 429）冷却 45 秒；确定性故障（403/404）本轮摘除 |
| 启动重试 | 拿不到第一个字节就退避重试，**每次重新解析直链**——镜像发的一次性 key 会过期 |
| stall guard | 不设全局超时。连续 45 秒没有新字节才判死；慢速传输不会被误杀 |
| 断点续传 | 中断保留 `.part`，重下时用 `Range` 续传 |
| 完整性校验 | 下完比对 MD5；返回 HTML 错误页会被识别并丢弃 |

Z-Library 走 `/eapi`（官方客户端 JSON 通道），绕开网页端的 DiamWall 验证墙：填邮箱密码直接登录，不需要粘 Cookie。

## OCR

| 步骤 | 做法 |
| --- | --- |
| 1. 文本层优先 | PDF 自带文本层就直接用 `pdfjs-dist` 提取，绝不渲染 |
| 2. 渲染 | 无文本层的页用 `@napi-rs/canvas` 渲染成 PNG（2.2 倍缩放，上限 1700px 宽） |
| 3. 识别 | 默认交视觉模型逐页识别；开了本地模型就交给本地的 Xiaomi-OCR-0 |
| 4. 并发 | 多页并行（3 并发）；某页返回空文本时同页重试一次再记失败 |

`ocr` 参数三档：`auto` 只补无文本层的页、`force` 全本重做、`off` 关闭。
省钱的两条路：把 **设置 → 任务模型 → OCR 模型** 指到便宜的视觉模型，或者用下面的本地模型（不花 token）。

### 本地 OCR（Xiaomi-OCR-0）

小米开源的 [Xiaomi-OCR-0](https://huggingface.co/xiaomi-research/Xiaomi-OCR-0) 是 0.8B 文档理解模型（Apache-2.0，
文档解析 + OCR 理解，Real5-OmniDocBench 95.24）。设置页在 **OCR 模型** 下方有「使用本地模型」开关：
勾上并点「下载模型」，扫描件 OCR 就完全在本地跑，离线、不消耗 token。

| 项 | 说明 |
| --- | --- |
| 权重 | 社区 GGUF 版 [prithivMLmods/Xiaomi-OCR-0-GGUF](https://huggingface.co/prithivMLmods/Xiaomi-OCR-0-GGUF)：Q4_K_M（约 505MB）+ mmproj-bf16 视觉投影器（约 198MB） |
| 运行库 | llama.cpp `b12800` Windows x64 CPU 版（约 24MB），插件自动下载解压 |
| 识别模式 | 纯文本（默认，按阅读顺序抽文字）／整页 Markdown（表格 OTSL、公式 LaTeX） |
| 提示词 | 沿用模型卡推荐的两条（文本区域 / 整页 document） |
| 回退 | 本地服务异常时**自动退回**上面配置的视觉模型，入库不中断；两者都不可用才报错 |
| 体积 | 模型 + 运行库约 730MB，删一次就干净（`models/` 与 `runtime/`） |

CPU 推理：首次加载数秒到十几秒（看磁盘缓存），之后按需常驻、**空闲 10 分钟自动退出**把内存还回去。
llama-server 默认单 slot，所以本地识别是逐页串行（远端视觉模型才 3 页并发）。
实测（Q4_K_M，一页 1000×1300 扫描图）**约 11 秒**，中文整段还原、中英混排也正常。
识别用的引擎会记在 `meta.json` 的 `ocr.engine`（`local-Xiaomi-OCR-0` / `llm-vision` / `mixed`）。

## 读书怎么省 token

`ebook_read` 不调用任何模型，它把章节原文放进工具结果——这些 token 留在主对话里、之后每轮都重发，所以「整本读」很贵。
DSH 的工具层没有「按工具换模型」的开关，但插件自己调 `llm` 时可以指定模型，于是多了一条路：

| 方式 | 原文去哪 | token 花在哪 | 适合 |
| --- | --- | --- | --- |
| `ebook_read` | 进主对话 | 会话模型，且随每轮重发 | 要逐字原文、逐段精读 |
| `ebook_ask` | 只在插件进程内 | 「阅读模型」的调用（长书分批） | 提问、总结、定位论点 |

`ebook_ask` 的做法：读章节 → 超过单批上限（默认 24000 字）就分批让模型摘录与问题相关的内容 → 再基于摘录汇总作答。
返回里带 `model`、`chars`、`batches`、`truncated`，能看出这次读了多少；默认最多读 240000 字，避免超长合集把费用拉爆。

## 推到微信读书

书库详情页点「推送到微信读书」，走墨水屏端接口（COS 三段导入：取凭证 → 上传 → notify）。

**有译本时先选版本**：列「原书（EPUB）／中文译本（EPUB）」等选项，点一个才推；只有一个版本就直接推，不打断操作。
译本在微信读书里按「书名（语言）」入库，原书按书名入库。

前置条件是 `refreshToken` 与 `deviceId`：

- **扫码**：设置页「微信读书」点「显示二维码」，手机微信扫码确认，凭据自动保存
- **手填**：从微信读书 App / 墨水屏端抓包拿到后填进去

Kindle 推送没有实现：生成 `book.epub` 后用邮箱发到你的 `@kindle.com` 地址即可。

## 书库界面

侧栏「书库」图标打开封面网格，点书进详情：

- **封面**：EPUB 内嵌图 / PDF 首页提取；提取不到可联网从豆瓣搜候选
- **简介与评分**：入库时自动补，微信读书优先、豆瓣兜底，缺了可手动重取
- **操作**：打开文件、推送到微信读书、联网找封面、删除
- 顶部显示进行中的后台任务（OCR / 翻译 / 推送），关掉面板再打开也不丢

## 设置面板

配置界面在**插件页 → 电子书库**的详情里（不占用 DSH 通用设置页）。

**下载目录**

- 「选择目录…」调系统目录对话框，选完**先校验再保存**
- 也可以直接填路径，回车或点「保存并切换」
- 切换只影响后续下载，已有的书留在原处

**任务模型**

- OCR、翻译、阅读各用一套模型，只影响插件内部调用，不改你当前会话的模型
- OCR 下拉只列声明支持图片的模型
- **阅读模型**给 `ebook_ask` 用：插件本地读章节，只把答案交回主对话
- **「翻译交给子代理执行」**：每章在独立会话里翻译，可多轮自查，明显更慢；失败自动回退到直接调用

**本地模型**

- 「使用本地模型（Xiaomi-OCR-0 · 0.8B）」开关 → 下载 / 取消 / 删除，带进度条
- 装好后可选识别模式：纯文本 / 整页 Markdown

**微信读书**

- 扫码登录、手动填凭据、删除凭据；账号卡片显示今日配额（如 `今日 4/10`）

**取书平台账号**

- 只列需要登录的平台（Z-Library）；LibGen 与 Internet Archive 无需账号，照样参与搜索
- 账号存本机 `$DSH_HOME/dsh-ebook/settings.json`；接口返回的账号信息不含密码与 cookie

**书源可达性**

- 一键探测各书源的**实际接口**（不是首页）：LibGen 每个镜像单独列，Z-Library 探 eAPI，Internet Archive 探搜索 API

**关于与更新**

- 显示当前版本，点「检查更新」查 GitHub Releases；有新版本时列出发布说明并可打开发布页
- 只提示不自动安装：升级照旧走 `pnpm add <release tgz>` 或插件管理（本地模型、书库都不受影响）
- 结果缓存 6 小时，打开设置页时后台静默检查一次，失败不打扰

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
          read: { provider: '', model: '' }  # ebook_ask 的阅读模型
        zlib:                                # 设置面板里配了账号时，账号优先
          domain: ''
          cookie: ''
        opds: { port: 8899, host: 127.0.0.1, autoStart: true }
```

本地模型的开关、识别模式、下载状态不走 YAML，存在设置页里（`settings.json` 的 `localOcr`）。

## 产物结构

```
书库/{书名}/
  source.epub | 书名.pdf      原始文件（保留服务器给的原名，重名加序号）
  cover.png|jpg               封面（EPUB 内嵌图 / PDF 首页 / 联网选图）
  book.md                     给 AI 读（全书）
  book.epub                   仅 PDF 源生成；EPUB 源直接用原文件，不复制一份
  book.zh.md / book.zh.epub   译本（语言后缀随目标语言）
  .dsh-ebook/
    meta.json                 书名、作者、简介、评分、OCR 记录、源文件记录
    manifest.json             章节索引
    chapters/0001-*.md        分章正文
    translated/0001.md        译文缓存
```

`book.epub` 与 `book.<lang>.epub` 都会**内嵌封面**（EPUB3 `cover-image` + EPUB2 `meta name="cover"` + 封面页），
推到微信读书、用 KOReader 打开时都有封面，不是白板。

插件自己的数据都在 `$DSH_HOME/dsh-ebook/`：

| 路径 | 内容 |
| --- | --- |
| `settings.json` | 书库目录、账号、模型、本地 OCR 开关、微信读书凭据 |
| `cache/` | 镜像列表缓存 |
| `models/xiaomi-ocr-0/` | 本地 OCR 的 GGUF 权重（按需下载） |
| `runtime/llama-b12800/` | llama.cpp CPU 运行库（按需下载） |

## 本地接口与安全

- 设置与书库接口挂在 `/dsh-ebook/api`，**只接受本机回环或同源请求**；写操作还要求 `x-dsh-ebook: 1` 请求头（浏览器跨站请求带它会触发预检，从而被挡住）
- 账号密码、cookie、微信读书令牌保存在本机 `settings.json`；接口不回传密码、cookie 与 refreshToken，只回「有没有存过」
- 书目录相关接口只接受书库根下的一级目录名，`..`、`.` 与含分隔符的名字一律拒绝
- OPDS **没有鉴权**，默认只监听 `127.0.0.1`；要给手机 / 阅读器用才改成 `0.0.0.0`
- 本地模型下载会校验字节数与 sha256；`llama-server` 只监听 `127.0.0.1` 的随机端口，插件退出时关闭

## 已知限制

- **本地 OCR 的自动运行库只提供 Windows x64**；macOS / Linux 需要自己装 llama.cpp 并让 `llama-server` 出现在 PATH（没装则自动用视觉模型）
- OCR 质量取决于所选模型；认不出的字由模型用 `▢` 占位，失败页码记入 `meta.json`
- Z-Library 需要账号，额度用完会直接给明确提示
- mobi / azw3 只登记不解析，要正文请选 epub 或 pdf
- 直连境外书源通常需要代理

## 开发

```bash
pnpm install
# 插件通过 profile 的 link: 依赖加载，改完在插件页关掉再打开即可重载
```

- 源码全部 ESM，无构建步骤
- 改 `client.js` 后重载插件并刷新页面（插件页会显示界面构建时间，用来确认浏览器加载的是新代码）
- 打 tag `v*` 会触发 GitHub Actions 自动打包并挂到 Release

## 更新日志

| 版本 | 变化 |
| --- | --- |
| 0.7.0 | 新增「检查更新」；修复本地 OCR 冷启动并发回退、localhost 被代理、spawn 异常、下载中删除竞态；本地块不再依赖模型列表；支持 PATH 里的 llama-server；清理死代码与仓库杂物 |
| 0.6.0 | 接入本地 OCR（Xiaomi-OCR-0）：设置里开关 + 下载/删除模型、纯文本/整页 Markdown 两种模式、失败自动回退 |
| 0.5.3 | 译本与 PDF 成品内嵌封面；新增「阅读模型」与 `ebook_ask`；LICENSE 版权人改为 KaixmWang |
| 0.5.2 | 推送微信读书时可选原书 / 译本版本，按版本生成入库文件名 |
| 0.5.x | 修复 OCR 与模型选择失效、章节切分、`.cache` 被当成书、OPDS 看不到 EPUB 源、路径穿越、CSRF、凭据回显等一批问题 |

## 许可证

本项目以 **MIT** 许可证发布，见 [LICENSE](LICENSE)。Copyright © 2026 KaixmWang。

第三方与模型：

| 组件 | 许可证 | 用途 |
| --- | --- | --- |
| `pdfjs-dist` | Apache-2.0 | PDF 文本层与页面渲染 |
| `@napi-rs/canvas` | MIT | 把 PDF 页渲染成图片交给 OCR |
| `undici` | MIT | HTTP 客户端与代理 |
| `qrcode` | MIT | 微信读书扫码登录二维码 |
| `@deepseek-ai/schemastery` | MIT | 插件配置校验 |
| Xiaomi-OCR-0（模型权重） | Apache-2.0 | 本地 OCR 识别 |
| Xiaomi-OCR-0-GGUF（社区转换） | 随模型 Apache-2.0 / 转换脚本 MIT | 本地 OCR 的 GGUF 权重与 mmproj |
| llama.cpp（运行时） | MIT | 本地推理服务 |

MIT 项目分发 Apache-2.0 依赖是允许的；Apache-2.0 只要求保留其许可证与版权声明，上游没有额外的 NOTICE 文件需要转发。
