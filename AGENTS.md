# 开发约定

## 环境事实（实测，别再猜）

- 本机 shell 是 **Windows PowerShell 5.1**（`5.1.26100`，Desktop 版），不是 PowerShell 7。
- DSH 以 **`-NoProfile -NonInteractive`** 启动 shell，所以 `$PROFILE` 不会被加载，
  往 profile 里写设置对自动化命令无效（对用户手动开的窗口有效）。
- 5.1 的 `Get-Content` / `Set-Content` / `Out-File` 默认使用**系统 ANSI 代码页**，
  简体中文环境即 GBK/CP936。

## 读文件的硬规则

**读任何可能含中文的文本文件（JSON / MD / JS / YAML / 配置），必须显式指定 UTF-8。**

不指定编码时 5.1 会用 GBK 解码 UTF-8 字节，得到 `鐢靛瓙涔︽彃浠` 这类乱码。
后果会连锁：乱码字符串让 `ConvertFrom-Json` 解析失败，看起来像"配置文件损坏"，
而文件其实完好——这个问题已经浪费过一次排查时间。

安全写法二选一：

```powershell
# 推荐：.NET API，不受 PowerShell 编码设置影响
[IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)

# 或者显式声明
Get-Content $path -Raw -Encoding utf8
```

写文件同理：

```powershell
[IO.File]::WriteAllText($path, $content, [Text.UTF8Encoding]::new($false))
```

## 例外：`.ps1` 脚本必须带 BOM

PowerShell 5.1 对**无 BOM** 的 UTF-8 脚本按 ANSI 解析。脚本里只要有中文注释，
字符数就会错位、行号对不上、报 `意外的标记` 语法错误。所以本机任何含中文的 `.ps1`
都要存成 **UTF-8 with BOM**：

```powershell
[IO.File]::WriteAllText($path, $content, [Text.UTF8Encoding]::new($true))
```

## Node 侧不受影响

插件运行在 Node 里，`fs.readFileSync(p, 'utf8')` 与 `writeFileSync(..., 'utf8')`
都是正确的。上面这些规则只约束**用 PowerShell 操作文件**的时候。

## Cordis 服务注入（踩过两次）

- **访问未声明 inject 的服务会抛错**，不是返回 `undefined`。`?.` 和 `if (ctx.xxx)` 都拦不住。
  所以 `if (ctx.webServer) { ... }` 这种写法本身就是错的，要用条件注入。
- **inject 不展开点号路径**。`'remote.directoryPicker'` 和 `'remote'` 是两个独立的 key，
  都要写。只声明前者，访问 `ctx.remote` 时照样抛 `cannot get property "remote" without inject`。
  官方例子见 `dsh-client-ui-workspace/src/client/index.ts` 的 inject 列表。
- **Host 侧可选依赖用条件注入**：

  ```js
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({ ... }), 'label')
  })
  ```

  服务不存在时回调不执行，插件其余部分照常工作。
- **Client 侧访问 Remote 命名空间**：

  ```js
  ctx.inject(['remote', 'remote.directoryPicker'], scoped => {
    pick = () => scoped.remote.directoryPicker.pick(new AbortController().signal)
  })
  ```

## 避免用 PowerShell 改源码

历史教训：用 `Get-Content -Raw` 读 JS 源码再 `Set-Content` 写回，
会因编码问题把中文变乱码、甚至截断字符串导致语法错误。
**改源码用编辑器工具（write / edit），不要用 PowerShell 做文本替换。**
