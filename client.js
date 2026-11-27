window.__ModuleLoader__.load({
  id: 'dsh-ebook',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/dsh-ebook/api'

    /** 语义色板：全部取自宿主主题 token，跟随明暗切换。 */
    const C = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '7px 10px',
      fontSize: 13,
      color: C.text,
      background: C.layer2,
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      outline: 'none',
      fontFamily: 'inherit',
    }

    /**
     * 按钮样式。
     * 主按钮刻意不用「填充色 + 白字」：brand-primary 在暗色主题下是浅色强调色，
     * 拿它做底再配白字会变成白底白字。改用品牌色的描边与文字，任何主题下都成立。
     * @param {string} [variant] primary 或空。
     * @returns {object} 样式对象。
     */
    const button = (variant) => ({
      padding: '6px 14px',
      fontSize: 13,
      fontFamily: 'inherit',
      cursor: 'pointer',
      borderRadius: 6,
      border: `1px solid ${variant === 'primary' ? C.brand : C.border}`,
      background: 'transparent',
      color: variant === 'primary' ? C.brand : C.text,
      fontWeight: variant === 'primary' ? 600 : 400,
      whiteSpace: 'nowrap',
    })

    /**
     * 从 directoryPicker 的返回值里取出目录路径。
     *
     * Host 侧签名是 `pick(): Promise<string | null>`，但经 Remote 传输后可能被包一层
     * （实测拿到的是对象，直接塞进输入框就变成 [object Object]）。
     * 这里按几种常见形状提取，都不匹配就返回空串，由调用方提示「没有选择目录」。
     *
     * @param {unknown} value 原始返回值。
     * @returns {string} 目录路径，取不到为空串。
     */
    function extractPickedDir(value) {
      if (typeof value === 'string') return value
      if (!value || typeof value !== 'object') return ''
      for (const key of ['path', 'directory', 'dir', 'value', 'result', 'selected', 'uri']) {
        const candidate = value[key]
        if (typeof candidate === 'string' && candidate) return candidate
      }
      // 兜底：对象里唯一像路径的字符串
      for (const candidate of Object.values(value)) {
        if (typeof candidate === 'string' && /[\\/]/.test(candidate)) return candidate
      }
      return ''
    }

    /**
     * 模型模态的展示标签。
     * `inputModalities` 三态要分清：true 支持图片、false 明确不支持、null 未声明。
     * @param {{image:boolean|null}} item 模型条目。
     * @returns {string}
     */
    function modalityTag(item) {
      if (item.image === true) return ' · 支持图片'
      if (item.image === false) return ' · 不支持图片'
      return ' · 未声明模态'
    }

    /**
     * 侧栏顶部的书库图标。
     *
     * `sidebar.panellist` 是图标工厂：宿主传入 `size`（像素边长）与 `active`（是否选中），
     * 只负责画图标，按钮和标题由侧栏自己渲染。
     *
     * @param {{size?: number, active?: boolean}} [props] 宿主传入的图标状态。
     */
    function LibraryIcon(props) {
      const size = Number(props?.size) || 20
      const active = props?.active === true
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        'aria-hidden': true,
        style: {
          display: 'block',
          color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
        },
      },
        h('path', {
          d: 'M2 2.5h5.5v11H2zM8.5 2.5H14v11H8.5z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
        }),
      )
    }

    /**
     * 格式化字数。
     * @param {number} n 字数。
     * @returns {string}
     */
    function formatChars(n) {
      const value = Number(n) || 0
      if (value >= 10000) return `${(value / 10000).toFixed(1)} 万字`
      return `${value} 字`
    }

    /**
     * 格式化文件体积。
     * @param {number} bytes 字节数。
     * @returns {string}
     */
    function formatBytes(bytes) {
      const value = Number(bytes) || 0
      if (value <= 0) return ''
      if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
      return `${Math.max(1, Math.round(value / 1024))} KB`
    }

    /** 书库面板：网格 + 详情。作为 main 面板常驻渲染，由侧栏图标切换。 */
    function LibraryPanel(props) {
      // 由 apply 注入：跳到插件详情页（设置在那里）
      const openSettings = props?.openSettings
      const [books, setBooks] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [selected, setSelected] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [confirmDelete, setConfirmDelete] = React.useState(false)
      const [tasks, setTasks] = React.useState([])
      const [logFor, setLogFor] = React.useState('')
      const [coverCandidates, setCoverCandidates] = React.useState([])
      const [coverVersion, setCoverVersion] = React.useState(0)
      const [showWereadQr, setShowWereadQr] = React.useState(false)
      // 推送版本选择：null 表示没有在选，对象形如 { dir, options }
      const [pushOptions, setPushOptions] = React.useState(null)

      const load = React.useCallback(async () => {
        try {
          const data = await callApi('/books')
          setBooks(data.books ?? [])
          setError('')
          return data.books ?? []
        } catch (e) {
          // 失败也要结束加载态，否则界面永远停在「正在读取书库…」
          setBooks([])
          setError(e.message)
          return []
        }
      }, [])

      /**
       * 拉后台任务列表。面板重开后靠它恢复「还有任务在跑」的可见性。
       * 失败返回 null：调用方据此跳过本轮，不要误判成「任务都结束了」。
       * @returns {Promise<Array<object>|null>}
       */
      const loadTasks = React.useCallback(async () => {
        try {
          const data = await callApi('/book/tasks')
          const list = data.tasks ?? []
          setTasks(list)
          return list
        } catch {
          return null
        }
      }, [])

      React.useEffect(() => {
        load()
        loadTasks()
      }, [load, loadTasks])

      // 有任务在跑就持续轮询；全部结束后刷新书库
      React.useEffect(() => {
        const running = tasks.filter(t => t.status === 'running')
        if (running.length === 0) return
        const timer = setInterval(async () => {
          const list = await loadTasks()
          if (!list) return
          if (!list.some(t => t.status === 'running')) {
            clearInterval(timer)
            await load()
            if (selected) {
              try { setDetail(await callApi(`/book?dir=${encodeURIComponent(selected.dir)}`)) } catch { /* 忽略 */ }
            }
          }
        }, 3000)
        return () => clearInterval(timer)
      }, [tasks, loadTasks, load, selected])

      // 详情请求序号：快速点两本书时，先发的慢响应不能覆盖后点的书
      const detailSeq = React.useRef(0)

      /**
       * 打开一本书的详情。
       * @param {object} book 列表项。
       */
      const openDetail = async book => {
        const seq = ++detailSeq.current
        setSelected(book)
        setDetail(null)
        setConfirmDelete(false)
        // 换书时清掉上一本的面板状态，避免把 A 的候选封面写到 B 上
        setCoverCandidates([])
        setShowWereadQr(false)
        setPushOptions(null)
        setNotice('')
        setBusy('detail')
        try {
          const next = await callApi(`/book?dir=${encodeURIComponent(book.dir)}`)
          if (seq === detailSeq.current) setDetail(next)
        } catch (e) {
          if (seq === detailSeq.current) setError(e.message)
        } finally {
          if (seq === detailSeq.current) setBusy('')
        }
      }

      /**
       * 跑一个会改动书籍的动作，完成后刷新列表与详情。
       * @param {string} tag 忙碌标记。
       * @param {Function} action 动作。
       */
      const act = async (tag, action) => {
        const seq = ++detailSeq.current
        setBusy(tag)
        setError('')
        setNotice('')
        try {
          const result = await action()
          if (result?.ok === false) {
            setError(result.message || '操作没有成功')
          } else if (result?.message) {
            setNotice(result.message)
          }
          await load()
          if (selected && seq === detailSeq.current) {
            try { setDetail(await callApi(`/book?dir=${encodeURIComponent(selected.dir)}`)) } catch { /* 已删除 */ }
          }
          return result
        } catch (e) {
          setError(e.message)
          return null
        } finally {
          if (seq === detailSeq.current) setBusy('')
        }
      }

      /**
       * 任务已提交：立刻拉一次任务列表，之后交给上面的全局轮询。
       * 面板关掉再打开时，进度会从 /book/tasks 重新读出来，不会丢。
       */
      const watchTask = async () => {
        await loadTasks()
        setLogFor('')
      }

      /**
       * 推送指定版本到微信读书。
       * @param {string} dir 书目录名。
       * @param {string} file 版本文件（原书或译本）。
       */
      const startPush = (dir, file) => act('weread', async () => {
        try {
          const result = await callApi('/book/push-weread', {
            method: 'POST',
            body: JSON.stringify({ dir, file }),
          })
          setPushOptions(null)
          watchTask()
          return result
        } catch (e) {
          // 没配凭据时不报错，就地展开扫码面板
          if (/凭据|refreshToken|deviceId/i.test(e.message)) {
            setShowWereadQr(true)
            return { message: '还没登录微信读书，扫码后即可推送' }
          }
          throw e
        }
      })

      /**
       * 点「推送到微信读书」：先问后端有哪几个版本可推。
       * 只有一个就直接推；有译本、有多种版本时先让用户选。
       */
      const openPush = async () => {
        if (!current) return
        setBusy('weread-pick')
        setError('')
        setNotice('')
        try {
          const result = await callApi(`/book/push-options?dir=${encodeURIComponent(current.dir)}`)
          const options = result.options ?? []
          if (options.length === 0) {
            setError('这本书没有可推送的 EPUB/PDF 文件')
            return
          }
          if (options.length === 1) {
            await startPush(current.dir, options[0].file)
            return
          }
          // 多个版本：展开选择面板，等用户点一个
          setPushOptions({ dir: current.dir, options })
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy('')
        }
      }

      const current = detail ?? selected
      const description = current?.descriptionZh || current?.description || ''

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column',
          height: '100%', color: C.text, background: C.layer1,
        },
      },
        h('div', {
          style: {
            flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
          },
        },
          // 顶栏
          h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '14px 18px', borderBottom: `1px solid ${C.border}`, flex: 'none',
            },
          },
            selected
              ? h('button', {
                type: 'button',
                style: { ...button(), padding: '4px 10px' },
                onClick: () => { setSelected(null); setDetail(null); setConfirmDelete(false); setNotice(''); setError(''); setPushOptions(null) },
              }, '‹ 返回')
              : h('span', { style: { fontSize: 15, fontWeight: 600 } }, '书库'),
            h('span', { style: { flex: 1 } }),
            h('span', { style: { fontSize: 11.5, color: C.dim } },
              books ? `共 ${books.length} 本` : ''),
            h('button', {
              type: 'button',
              style: { ...button(), padding: '4px 10px' },
              onClick: () => { load(); loadTasks() },
            }, '刷新'),
            openSettings
              ? h('button', {
                type: 'button',
                style: { ...button(), padding: '4px 10px' },
                title: '打开插件设置',
                onClick: () => openSettings(),
              }, '设置')
              : null,
          ),

          error ? h('div', {
            style: { margin: '12px 18px 0', padding: '8px 12px', fontSize: 12, color: C.err, border: `1px solid ${C.err}`, borderRadius: 6 },
          }, error) : null,
          notice ? h('div', {
            style: { margin: '12px 18px 0', padding: '8px 12px', fontSize: 12, color: C.ok, border: `1px solid ${C.border}`, borderRadius: 6 },
          }, notice) : null,

          // 进行中的任务：关掉面板再打开也在这里，不会丢
          tasks.filter(t => t.status === 'running').map(task => {
            const seconds = Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000))
            const label = taskLabel(task.kind)
            const open = logFor === task.id
            return h('div', {
              key: task.id,
              style: {
                margin: '12px 18px 0', padding: '10px 12px',
                border: `1px solid ${C.brand}`, borderRadius: 8,
                background: C.layer2, display: 'flex', flexDirection: 'column', gap: 6,
              },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 } },
                h('span', {
                  style: {
                    width: 8, height: 8, borderRadius: 999, background: C.brand,
                    flex: 'none', animation: 'none',
                  },
                }),
                h('span', { style: { color: C.text, fontWeight: 600 } }, `正在${label}`),
                h('span', { style: { color: C.dim } }, `《${task.dir}》`),
                h('span', { style: { flex: 1 } }),
                h('span', { style: { color: C.dim, fontSize: 11.5, fontVariantNumeric: 'tabular-nums' } },
                  `${seconds}s`),
                task.log.length
                  ? h('button', {
                    type: 'button',
                    style: { ...button(), padding: '2px 8px', fontSize: 11.5 },
                    onClick: () => setLogFor(open ? '' : task.id),
                  }, open ? '收起日志' : '看日志')
                  : null,
              ),
              task.log.length
                ? h('div', {
                  style: {
                    fontSize: 11, color: C.dim, lineHeight: 1.6,
                    fontFamily: 'ui-monospace, monospace',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                  },
                },
                  open
                    ? task.log.slice(-12).join('\n')
                    : (task.log[task.log.length - 1] ?? ''),
                )
                : h('div', { style: { fontSize: 11.5, color: C.dim } }, '已启动，等待第一页结果…'),
            )
          }),

          // 最近结束的任务（失败的要让人看见）
          tasks.filter(t => t.status === 'failed').slice(0, 2).map(task => h('div', {
            key: `f-${task.id}`,
            style: {
              margin: '12px 18px 0', padding: '8px 12px', fontSize: 12,
              color: C.err, border: `1px solid ${C.err}`, borderRadius: 6,
            },
          }, `${taskLabel(task.kind)}失败（${task.dir}）：${task.message || '未知原因'}`)),

          // 主体
          h('div', { style: { flex: 1, overflowY: 'auto', padding: 18 } },
            // 详情视图
            selected
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
                h('div', { style: { display: 'flex', gap: 18, alignItems: 'flex-start' } },
                  selected.hasCover
                    ? h(BookCover, {
                      dir: selected.dir,
                      title: current.title,
                      width: 160,
                      height: 224,
                      radius: 6,
                      version: coverVersion,
                    })
                    : h('div', {
                      style: {
                        width: 160, height: 224, flex: 'none', borderRadius: 6,
                        border: `1px solid ${C.border}`, background: C.layer2,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 12, color: C.dim,
                      },
                    }, '无封面'),
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 0 } },
                    h('div', { style: { fontSize: 18, fontWeight: 600, lineHeight: 1.35 } }, current.title),
                    h('div', { style: { fontSize: 13, color: C.dim } }, current.creator || '佚名'),
                    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11.5, color: C.dim } },
                      current.format ? h('span', null, current.format.toUpperCase()) : null,
                      current.chapters ? h('span', null, `${current.chapters} 章`) : null,
                      current.chars ? h('span', null, formatChars(current.chars)) : null,
                      current.language ? h('span', null, current.language) : null,
                      current.ocrApplied ? h('span', { style: { color: C.warn } }, `OCR${current.ocrFailed ? ` (${current.ocrFailed} 页失败)` : ''}`) : null,
                      current.translatedTo ? h('span', { style: { color: C.ok } }, `已译 ${current.translatedTo}`) : null,
                    ),

                    // 操作
                    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 } },
                      h('button', {
                        type: 'button',
                        style: button('primary'),
                        disabled: Boolean(busy),
                        onClick: () => act('open', async () => callApi('/book/open', {
                          method: 'POST',
                          body: JSON.stringify({ dir: current.dir }),
                        })),
                      }, busy === 'open' ? '打开中…' : '打开文件'),

                      h('button', {
                        type: 'button',
                        style: button(),
                        disabled: Boolean(busy),
                        onClick: openPush,
                      }, busy === 'weread' ? '推送中…' : busy === 'weread-pick' ? '查询版本…' : '推送到微信读书'),

                      current.description && !current.descriptionZh
                        ? h('button', {
                          style: button(),
                          disabled: Boolean(busy),
                          onClick: () => act('summary', async () => {
                            await callApi('/book/summary', {
                              method: 'POST',
                              body: JSON.stringify({ dir: current.dir }),
                            })
                            return { message: '简介已翻译' }
                          }),
                        }, busy === 'summary' ? '翻译中…' : '翻译简介')
                        : null,

                      h('button', {
                        type: 'button',
                        style: button(),
                        disabled: Boolean(busy),
                        onClick: () => act('find-cover', async () => {
                          setCoverCandidates([])
                          const result = await callApi('/book/find-cover', {
                            method: 'POST',
                            body: JSON.stringify({ dir: current.dir }),
                          })
                          setCoverCandidates(result.covers ?? [])
                          return { message: result.covers?.length ? `找到 ${result.covers.length} 张候选封面` : '没有找到候选封面' }
                        }),
                      }, busy === 'find-cover' ? '搜索中…' : '联网找封面'),

                      confirmDelete
                        ? h('span', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                          h('span', { style: { fontSize: 12, color: C.err } }, '确认删除整本书？'),
                          h('button', {
                            style: { ...button('primary'), borderColor: C.err, color: C.err },
                            disabled: Boolean(busy),
                            onClick: () => act('delete', async () => {
                              const result = await callApi('/book/delete', {
                                method: 'POST',
                                body: JSON.stringify({ dir: current.dir, confirm: true }),
                              })
                              setSelected(null)
                              setDetail(null)
                              return result
                            }),
                          }, busy === 'delete' ? '删除中…' : '确认删除'),
                          h('button', { style: button(), onClick: () => setConfirmDelete(false) }, '取消'),
                        )
                        : h('button', {
                          style: button(),
                          disabled: Boolean(busy),
                          onClick: () => setConfirmDelete(true),
                        }, '删除'),
                    ),
                  ),
                ),

                // 有原书与译本等多个版本时，先选推送哪个
                pushOptions
                  ? h('div', {
                    style: {
                      display: 'flex', flexDirection: 'column', gap: 8,
                      border: `1px solid ${C.brand}`, borderRadius: 8,
                      padding: '12px 14px', background: C.layer2,
                    },
                  },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                      h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, '选择推送哪个版本'),
                      h('span', { style: { flex: 1 } }),
                      h('button', {
                        type: 'button',
                        style: { ...button(), padding: '2px 8px', fontSize: 11.5 },
                        onClick: () => setPushOptions(null),
                      }, '取消'),
                    ),
                    pushOptions.options.map(option => h('button', {
                      key: option.file,
                      type: 'button',
                      disabled: Boolean(busy),
                      onClick: () => startPush(pushOptions.dir, option.file),
                      style: {
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 10px', fontFamily: 'inherit', fontSize: 12.5,
                        textAlign: 'left', cursor: 'pointer', borderRadius: 6,
                        border: `1px solid ${option.kind === 'translated' ? C.brand : C.border}`,
                        background: 'transparent', color: C.text,
                      },
                    },
                      h('span', { style: { fontWeight: option.kind === 'translated' ? 600 : 400 } }, option.label),
                      option.kind === 'translated'
                        ? h('span', {
                          style: {
                            fontSize: 10.5, padding: '1px 6px', borderRadius: 999,
                            border: `1px solid ${C.brand}`, color: C.brand,
                          },
                        }, '译文')
                        : null,
                      h('span', { style: { flex: 1 } }),
                      h('span', { style: { fontSize: 11, color: C.dim } }, formatBytes(option.bytes)),
                    )),
                    h('div', { style: { fontSize: 11, color: C.dim, lineHeight: 1.6 } },
                      '译本由 AI 翻译生成，在微信读书里会以「书名（语言）」入库；原书按书名入库。'),
                  )
                  : null,

                // 未登录微信读书时直接在这里扫码
                showWereadQr
                  ? h('div', {
                    style: {
                      display: 'flex', flexDirection: 'column', gap: 8,
                      border: `1px solid ${C.border}`, borderRadius: 8,
                      padding: '12px 14px', background: C.layer2,
                    },
                  },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                      h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, '先登录微信读书'),
                      h('span', { style: { flex: 1 } }),
                      h('button', {
                        type: 'button',
                        style: { ...button(), padding: '2px 8px', fontSize: 11.5 },
                        onClick: () => setShowWereadQr(false),
                      }, '收起'),
                    ),
                    h(WereadQrLogin, {
                      onDone: () => {
                        setShowWereadQr(false)
                        setNotice('微信读书已登录，可以再点一次推送')
                        load()
                      },
                    }),
                  )
                  : null,

                // 候选封面
                coverCandidates.length
                  ? h('div', {
                    style: {
                      border: `1px solid ${C.border}`, borderRadius: 8,
                      padding: '12px 14px', background: C.layer2,
                      display: 'flex', flexDirection: 'column', gap: 10,
                    },
                  },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                      h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, '点一张设为封面'),
                      h('span', { style: { flex: 1 } }),
                      h('button', {
                        type: 'button',
                        style: { ...button(), padding: '2px 8px', fontSize: 11.5 },
                        onClick: () => setCoverCandidates([]),
                      }, '收起'),
                    ),
                    h('div', {
                      style: {
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))',
                        gap: 10,
                      },
                    },
                      coverCandidates.map((cover, index) => h('button', {
                        key: `${cover.url}-${index}`,
                        type: 'button',
                        disabled: Boolean(busy),
                        title: `${cover.source} #${index + 1}`,
                        onClick: async () => {
                          setBusy('set-cover')
                          setError('')
                          try {
                            const result = await callApi('/book/set-cover', {
                              method: 'POST',
                              body: JSON.stringify({ dir: current.dir, url: cover.url }),
                            })
                            setNotice(result.message ?? '封面已更新')
                            setCoverCandidates([])
                            setCoverVersion(v => v + 1)
                            // 让列表里的封面也刷新
                            await load()
                          } catch (e) {
                            setError(e.message)
                          } finally {
                            setBusy('')
                          }
                        },
                        style: {
                          padding: 0, background: 'transparent', border: 'none',
                          cursor: 'pointer', display: 'block',
                        },
                      },
                        h('img', {
                          // 走同源代理：豆瓣图床直链会被 CSP / Referer 策略拦掉
                          src: `${API}/cover/preview?url=${encodeURIComponent(cover.thumb)}`,
                          alt: `候选 ${index + 1}`,
                          loading: 'lazy',
                          // 图被拦或失效时给个可见提示，别留一排空白按钮
                          onError: event => { event.currentTarget.style.opacity = '0.15' },
                          style: {
                            width: '100%', aspectRatio: '2 / 3', objectFit: 'cover',
                            borderRadius: 4, border: `1px solid ${C.border}`,
                            background: C.layer1, display: 'block',
                          },
                        }),
                      )),
                    ),
                  )
                  : null,

                // 简介
                h('div', {
                  style: {
                    border: `1px solid ${C.border}`, borderRadius: 8,
                    padding: '12px 14px', background: C.layer2,
                    display: 'flex', flexDirection: 'column', gap: 8,
                  },
                },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
                    h('span', { style: { fontSize: 12.5, fontWeight: 600 } },
                      current.descriptionZh ? '简介（中文译本）' : '简介'),
                    normalizeRating(current.rating) > 0
                      ? h('span', { style: { fontSize: 12, color: C.warn } },
                        `${'★'.repeat(Math.round(normalizeRating(current.rating)))}${'☆'.repeat(Math.max(0, 5 - Math.round(normalizeRating(current.rating))))} ${normalizeRating(current.rating).toFixed(1)}`,
                        current.ratingCount ? h('span', { style: { color: C.dim, fontSize: 11, marginLeft: 6 } },
                          `${current.ratingCount} 人`) : null)
                      : null,
                    current.summarySource
                      ? h('span', { style: { fontSize: 11, color: C.dim } }, `来源 ${current.summarySource}`)
                      : null,
                    h('span', { style: { flex: 1 } }),
                    h('button', {
                      type: 'button',
                      style: { ...button(), padding: '2px 10px', fontSize: 11.5 },
                      disabled: Boolean(busy),
                      onClick: () => act('summary-refresh', async () => {
                        // act 结束后会自己重拉详情与列表，这里不用再拉一次
                        return callApi('/book/refresh-summary', {
                          method: 'POST',
                          body: JSON.stringify({ dir: current.dir }),
                        })
                      }),
                    }, busy === 'summary-refresh' ? '查询中…' : (description ? '重新获取' : '获取简介')),
                  ),

                  h('div', { style: { fontSize: 12.5, lineHeight: 1.75, color: description ? C.text : C.dim, whiteSpace: 'pre-wrap' } },
                    description || '这本书还没有简介。点右上角「获取简介」联网查一次。'),

                  current.descriptionZh && current.description
                    ? h('div', { style: { fontSize: 11.5, color: C.dim, lineHeight: 1.6, marginTop: 2, whiteSpace: 'pre-wrap' } },
                      `原文：${current.description}`)
                    : null,

                  (current.publisher || current.translator)
                    ? h('div', { style: { fontSize: 11.5, color: C.dim, display: 'flex', gap: 12, flexWrap: 'wrap' } },
                      current.publisher ? h('span', null, `出版社 ${current.publisher}`) : null,
                      current.translator ? h('span', null, `译者 ${current.translator}`) : null)
                    : null,
                ),
              )

              // 网格视图
              : books === null
                ? h('div', { style: { fontSize: 12.5, color: C.dim } }, '正在读取书库…')
                : books.length === 0
                  ? h('div', { style: { fontSize: 12.5, color: C.dim } }, '书库还是空的。让 AI 用 ebook_fetch 取一本试试。')
                  : h('div', {
                    style: {
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                      gap: 16,
                    },
                  },
                    books.map(book => h('button', {
                      key: book.dir,
                      type: 'button',
                      disabled: Boolean(busy),
                      onClick: () => openDetail(book),
                      style: {
                        display: 'flex', flexDirection: 'column', gap: 8,
                        padding: 0, background: 'transparent', border: 'none',
                        cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                      },
                    },
                      book.hasCover
                        ? h(BookCover, {
                          dir: book.dir,
                          title: book.title,
                          width: '100%',
                          radius: 6,
                        })
                        : h('div', {
                          style: {
                            width: '100%', aspectRatio: '2 / 3', borderRadius: 6,
                            border: `1px solid ${C.border}`, background: C.layer2,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 11.5, color: C.dim, padding: 8, boxSizing: 'border-box',
                            textAlign: 'center', lineHeight: 1.4,
                          },
                        }, book.title.slice(0, 24)),
                      h('div', {
                        style: {
                          fontSize: 12.5, fontWeight: 600, color: C.text,
                          overflow: 'hidden', textOverflow: 'ellipsis',
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                          lineHeight: 1.35,
                        },
                      }, book.title),
                      h('div', {
                        style: {
                          fontSize: 11.5, color: C.dim,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        },
                      }, book.creator || '佚名'),
                    )),
                  ),
          ),
        ),
      )
    }

    /**
     * 封面图。
     *
     * 不能直接用 `<img src="/dsh-ebook/api/cover?...">`：Web 端有认证，
     * 裸 URL 的图片请求未必带上凭据，表现就是白板。这里用 fetch（same-origin 带凭据）取 blob，
     * 再转成 object URL 交给 img，并在卸载时释放。
     *
     * @param {{dir:string, title:string, width:number|string, height?:number|string, radius?:number, version?:number}} props 参数。
     */
    function BookCover(props) {
      const { dir, title, width, height, radius = 6, version = 0 } = props
      const [url, setUrl] = React.useState('')
      const [failed, setFailed] = React.useState(false)

      React.useEffect(() => {
        let objectUrl = ''
        let cancelled = false
        setFailed(false)
        setUrl('')
        // version 变化时带一个参数过去，绕过中间层缓存
        fetch(`${API}/cover?dir=${encodeURIComponent(dir)}&v=${version}`, { credentials: 'same-origin' })
          .then(response => (response.ok ? response.blob() : null))
          .then(blob => {
            if (cancelled) return
            if (!blob) { setFailed(true); return }
            objectUrl = URL.createObjectURL(blob)
            setUrl(objectUrl)
          })
          .catch(() => { if (!cancelled) setFailed(true) })
        return () => {
          cancelled = true
          if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
      }, [dir, version])

      if (failed || !url) {
        return h('div', {
          style: {
            width, height, borderRadius: radius,
            border: `1px solid ${C.border}`, background: C.layer2,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11.5, color: C.dim, padding: 8, boxSizing: 'border-box',
            textAlign: 'center', lineHeight: 1.4, overflow: 'hidden',
            aspectRatio: height ? undefined : '2 / 3',
          },
        }, title.slice(0, 24))
      }

      return h('img', {
        src: url,
        alt: title,
        style: {
          width, height, borderRadius: radius,
          border: `1px solid ${C.border}`, background: C.layer2,
          objectFit: 'cover', display: 'block',
          aspectRatio: height ? undefined : '2 / 3',
        },
      })
    }

    /**
     * 微信读书扫码登录面板。
     *
     * 二维码由 Host 生成（data URL），Host 自己在后台轮询微信，这里只查状态。
     *
     * @param {{onDone?:Function, onClose?:Function}} props 参数。
     */
    function WereadQrLogin(props) {
      const { onDone, onClose } = props ?? {}
      const [qr, setQr] = React.useState(null)
      const [status, setStatus] = React.useState('idle')
      const [message, setMessage] = React.useState('')
      const [remain, setRemain] = React.useState(0)
      const [busy, setBusy] = React.useState(false)

      const start = React.useCallback(async () => {
        setBusy(true)
        setQr(null)
        setStatus('loading')
        setMessage('正在获取二维码…')
        try {
          const result = await callApi('/weread/qr/start', { method: 'POST', body: '{}' })
          setQr({ id: result.id, image: result.image })
          setStatus('waiting')
          setMessage(result.message ?? '用微信扫码')
          setRemain(result.expiresIn ?? 300)
        } catch (e) {
          setStatus('failed')
          setMessage(e.message)
        } finally {
          setBusy(false)
        }
      }, [])

      // onDone 常是内联箭头，放进 ref 免得每次渲染都重建轮询定时器
      const onDoneRef = React.useRef(onDone)
      React.useEffect(() => { onDoneRef.current = onDone }, [onDone])

      // 有二维码就轮询状态，直到结束
      React.useEffect(() => {
        if (!qr) return
        let stopped = false
        let failures = 0
        const timer = setInterval(async () => {
          try {
            const result = await callApi(`/weread/qr/status?id=${encodeURIComponent(qr.id)}`)
            if (stopped) return
            failures = 0
            setStatus(result.status)
            setMessage(result.message ?? '')
            setRemain(result.remain ?? 0)
            if (result.done || ['expired', 'declined', 'failed', 'cancelled'].includes(result.status)) {
              clearInterval(timer)
              if (result.done && onDoneRef.current) onDoneRef.current(result)
            }
          } catch (e) {
            if (stopped) return
            failures++
            // 会话在后端过期会回 404，这时候再轮询也没意义
            if (/HTTP 404/.test(e.message) || failures >= 5) {
              clearInterval(timer)
              setStatus('failed')
              setMessage(e.message || '二维码会话已失效，请重新获取')
            }
          }
        }, 2000)
        return () => {
          stopped = true
          clearInterval(timer)
          // 关面板 / 换一张时让后端别再轮询微信
          callApi('/weread/qr/cancel', {
            method: 'POST',
            body: JSON.stringify({ id: qr.id }),
          }).catch(() => {})
        }
      }, [qr])

      const tone = status === 'done' ? C.ok
        : status === 'scanned' ? C.brand
          : ['expired', 'declined', 'failed'].includes(status) ? C.err
            : C.dim

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center',
          padding: 14, border: `1px solid ${C.border}`, borderRadius: 8, background: C.layer2,
        },
      },
        qr
          ? h('img', {
            src: qr.image,
            alt: '微信扫一扫登录',
            style: {
              width: 200, height: 200, display: 'block',
              borderRadius: 6, background: '#fff', padding: 6, boxSizing: 'content-box',
            },
          })
          : h('div', {
            style: {
              width: 200, height: 200, display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: 12, color: C.dim,
              border: `1px dashed ${C.border}`, borderRadius: 6, textAlign: 'center',
            },
          }, status === 'loading' ? '获取中…' : '点下面开始'),

        h('div', { style: { fontSize: 12.5, color: tone, textAlign: 'center', lineHeight: 1.6 } }, message || ' '),

        qr && remain > 0 && status !== 'done'
          ? h('div', { style: { fontSize: 11, color: C.dim } }, `剩余 ${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, '0')}`)
          : null,

        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' } },
          status === 'done'
            ? h('span', { style: { fontSize: 12.5, color: C.ok } }, '✓ 已登录，凭据已保存')
            : h('button', {
              type: 'button',
              style: button(qr ? undefined : 'primary'),
              disabled: busy,
              onClick: start,
            }, busy ? '获取中…' : (qr ? '换一张' : '显示二维码')),

          onClose
            ? h('button', { type: 'button', style: button(), onClick: onClose }, '关闭')
            : null,
        ),

        h('div', { style: { fontSize: 11, color: C.dim, lineHeight: 1.7, textAlign: 'center' } },
          '手机微信 → 右上角 + → 扫一扫 → 对准二维码 → 手机上点确认'),
      )
    }

    /** @param {string} text 状态文字。 @returns {string} 颜色。 */
    function statusColor(status) {
      if (status === 'ok') return C.ok
      if (status === 'login-only') return C.warn
      if (status === 'failed') return C.err
      if (status === 'cookie-only') return C.warn
      return C.dim
    }

    /** @param {string} status 状态。 @returns {string} 文案。 */
    function statusText(status) {
      if (status === 'ok') return '可用'
      if (status === 'login-only') return '已登录·通道未通'
      if (status === 'failed') return '失败'
      if (status === 'cookie-only') return '仅 cookie'
      return '未验证'
    }

    /**
     * 调后端接口。
     * @param {string} path 路径。
     * @param {object} [options] 选项。
     * @returns {Promise<any>}
     */
    async function callApi(path, options = {}) {
      const method = String(options.method ?? 'GET').toUpperCase()
      const response = await fetch(`${API}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          // 写操作带自定义头：后端据此拒绝跨站请求
          ...(method === 'GET' ? {} : { 'x-dsh-ebook': '1' }),
          ...(options.headers ?? {}),
        },
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        // 后端有的接口用 message 而不是 error，两个都要认，否则真实原因会被吞掉
        throw new Error(data.error || data.message || `请求失败（HTTP ${response.status}）`)
      }
      return data
    }

    /** 图书任务类型到中文标签。 */
    const TASK_LABELS = { ocr: 'OCR', translate: '翻译', weread: '推送' }

    /**
     * 取任务标签。
     * @param {string} kind 任务类型。
     * @returns {string}
     */
    function taskLabel(kind) {
      return TASK_LABELS[kind] ?? '处理'
    }

    /**
     * 评分归一化到 5 星制。
     * 微信读书给 0–5（已换算），豆瓣给 0–10，旧数据可能还是字符串。
     * @param {unknown} raw 原始评分。
     * @returns {number}
     */
    function normalizeRating(raw) {
      const value = Number(raw)
      if (!Number.isFinite(value) || value <= 0) return 0
      return Math.min(5, value > 5 ? value / 2 : value)
    }

    function Row({ label, children, hint }) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
        label ? h('div', { style: { fontSize: 12, color: C.dim } }, label) : null,
        children,
        hint ? h('div', { style: { fontSize: 11, color: C.dim, lineHeight: 1.5 } }, hint) : null,
      )
    }

    function Section({ title, subtitle, children }) {
      return h('section', {
        style: {
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          padding: '14px 16px',
          background: C.layer1,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        },
      },
        h('div', null,
          h('div', { style: { fontSize: 14, fontWeight: 600, color: C.text } }, title),
          subtitle ? h('div', { style: { fontSize: 12, color: C.dim, marginTop: 3, lineHeight: 1.5 } }, subtitle) : null,
        ),
        children,
      )
    }

    function EbookSettings(props) {
      // 由 apply 注入：调 Windows 原生目录选择框。不可用时为 undefined，UI 退化为手填。
      const pickDirectory = props?.pickDirectory
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [dirDraft, setDirDraft] = useState('')
      const [dirHint, setDirHint] = useState('')
      const [form, setForm] = useState({ platform: 'zlibrary', email: '', password: '', domain: '' })
      const [showForm, setShowForm] = useState(false)
      const [passwordFor, setPasswordFor] = useState('')
      const [passwordDraft, setPasswordDraft] = useState('')
      const [confirmRemoveAccount, setConfirmRemoveAccount] = useState('')
      const [probeResult, setProbeResult] = useState(null)
      const [probeBusy, setProbeBusy] = useState(false)
      const [cookieFor, setCookieFor] = useState('')
      const [cookieDraft, setCookieDraft] = useState('')
      const [sourceReport, setSourceReport] = useState(null)
      const [sourceBusy, setSourceBusy] = useState(false)
      const [quotas, setQuotas] = useState({})
      const [modelData, setModelData] = useState(null)
      // 本地 OCR（Xiaomi-OCR-0）：状态、进度都从 /ocr/local 拿
      const [localOcr, setLocalOcr] = useState(null)
      const [wereadDraft, setWereadDraft] = useState({ vid: '', refreshToken: '', deviceId: '' })
      const [confirmClearWeread, setConfirmClearWeread] = useState(false)

      const refresh = useCallback(async () => {
        try {
          const data = await callApi('/state')
          setState(data)
          setDirDraft(data.libraryDir || data.effectiveDir || '')
          setError('')
        } catch (e) {
          setError(e.message)
        }
      }, [])

      /** 查询各 Z-Library 账号的今日配额（eAPI 给的，不是本地估算）。 */
      const loadQuotas = useCallback(async () => {
        try {
          const result = await callApi('/accounts/quotas')
          const map = {}
          for (const item of result.quotas ?? []) map[item.id] = item
          setQuotas(map)
        } catch {
          // 配额查不到不影响其他功能，静默跳过
        }
      }, [])

      /** 拉取可用模型列表与当前按用途的指定。 */
      const loadModels = useCallback(async () => {
        try {
          setModelData(await callApi('/models'))
        } catch {
          // 列不出模型时 UI 保持隐藏，不影响其他功能
        }
      }, [])

      /**
       * 保存某个用途的模型指定。
       * @param {'ocr'|'translate'|'read'} role 用途。
       * @param {string} encoded 形如 `provider|model`，空串表示跟随默认。
       */
      const saveModel = (role, encoded) => run(`model-${role}`, async () => {
        const [provider, model] = encoded ? encoded.split('|') : ['', '']
        await callApi('/models', {
          method: 'POST',
          body: JSON.stringify({ role, value: { provider: provider ?? '', model: model ?? '' } }),
        })
        await loadModels()
        return { message: encoded ? '已保存，下次该任务就用这个模型' : '已恢复为跟随会话默认' }
      })

      /** 拉本地 OCR 的状态（安装情况 + 下载进度）。 */
      const loadLocalOcr = useCallback(async () => {
        try {
          setLocalOcr(await callApi('/ocr/local'))
        } catch {
          // 宿主不支持本地 OCR 时整块隐藏，不影响其他设置
          setLocalOcr(null)
        }
      }, [])

      /** 本地 OCR 开关。 */
      const toggleLocalOcr = enabled => run('local-toggle', async () => {
        const result = await callApi('/ocr/local', {
          method: 'POST',
          body: JSON.stringify({ enabled }),
        })
        setLocalOcr(result)
        return { message: result.message, ok: true }
      })

      /** 本地 OCR 识别模式（纯文本 / 整页 Markdown）。 */
      const setLocalOcrMode = mode => run('local-mode', async () => {
        const result = await callApi('/ocr/local', {
          method: 'POST',
          body: JSON.stringify({ mode }),
        })
        setLocalOcr(result)
        return { message: mode === 'document' ? '已切换为整页 Markdown 解析' : '已切换为纯文本识别', ok: true }
      })

      /** 下载本地模型 + 运行库（后台跑，进度靠轮询）。 */
      const downloadLocalOcr = () => run('local-download', async () => {
        const result = await callApi('/ocr/local/download', { method: 'POST', body: '{}' })
        setLocalOcr(result.status)
        return { message: result.message ?? '开始下载' }
      })

      /** 取消下载。 */
      const cancelLocalOcr = () => run('local-cancel', async () => {
        const result = await callApi('/ocr/local/cancel', { method: 'POST', body: '{}' })
        setLocalOcr(result.status)
        return { message: '已取消下载' }
      })

      /** 删除本地模型与运行库。 */
      const deleteLocalOcr = () => run('local-delete', async () => {
        const result = await callApi('/ocr/local/delete', {
          method: 'POST',
          body: JSON.stringify({ confirm: true }),
        })
        setLocalOcr(result.status)
        return { message: result.message }
      })

      /** 切换翻译执行方式。 */
      const setTranslateMode = viaSubagent => run('translate-mode', async () => {
        const result = await callApi('/translate-mode', {
          method: 'POST',
          body: JSON.stringify({ viaSubagent }),
        })
        return result
      })

      /** 切换侧栏图标显示（需重启 DSH 生效）。 */
      const setSidebarIcon = show => run('sidebar-icon', async () => {
        const result = await callApi('/sidebar-icon', {
          method: 'POST',
          body: JSON.stringify({ show }),
        })
        return result
      })

      /** 保存微信读书凭据。 */
      const saveWeread = () => run('weread', async () => callApi('/weread', {
        method: 'POST',
        body: JSON.stringify(wereadDraft),
      }))

      /** 删除微信读书凭据。 */
      const clearWeread = () => run('weread-clear', async () => {
        const result = await callApi('/weread/clear', { method: 'POST', body: '{}' })
        setWereadDraft({ vid: '', refreshToken: '', deviceId: '' })
        // run() 结束时统一 refresh，这里不再重复请求
        return result
      })

      useEffect(() => { refresh() }, [refresh])

      // 已有凭据填回非敏感字段，refreshToken 留空等用户重填覆盖
      useEffect(() => {
        if (!state?.weread) return
        setWereadDraft(prev => ({
          vid: prev.vid || (state.weread.vid ?? ''),
          refreshToken: prev.refreshToken,
          deviceId: prev.deviceId || (state.weread.deviceId ?? ''),
        }))
      }, [state?.weread])

      // 账号列表变化时顺带刷一次配额
      useEffect(() => {
        if ((state?.accounts?.length ?? 0) > 0) loadQuotas()
      }, [state?.accounts?.length, loadQuotas])

      useEffect(() => { loadModels() }, [loadModels])
      useEffect(() => { loadLocalOcr() }, [loadLocalOcr])

      // 下载中每秒刷新一次进度；下完自动停
      useEffect(() => {
        if (localOcr?.progress?.state !== 'downloading') return
        const timer = setInterval(loadLocalOcr, 1000)
        return () => clearInterval(timer)
      }, [localOcr?.progress?.state, loadLocalOcr])

      /**
       * 跑一个会改状态的异步动作，统一处理忙碌态与提示。
       * @param {string} tag 忙碌标记。
       * @param {Function} action 动作。
       */
      const run = async (tag, action) => {
        setBusy(tag)
        setError('')
        setNotice('')
        try {
          const result = await action()
          // 后端约定：ok === false 表示业务失败，哪怕 HTTP 是 200
          if (result?.ok === false) setError(result.message || '操作没有成功')
          else if (result?.message) setNotice(result.message)
          await refresh()
          return result
        } catch (e) {
          setError(e.message)
          return null
        } finally {
          setBusy('')
        }
      }

      const saveDir = () => run('save-dir', async () => {
        // 先让后端校验目录（不存在会尝试创建），失败就别写进设置
        const check = await callApi('/check-dir', { method: 'POST', body: JSON.stringify({ dir: dirDraft }) })
        if (!check.ok) throw new Error(check.message || '目录不可用')
        setDirHint(check.message)
        return callApi('/library', { method: 'POST', body: JSON.stringify({ dir: dirDraft }) })
      })

      const chooseDir = async () => {
        if (!pickDirectory) return
        try {
          const raw = await pickDirectory()
          const picked = extractPickedDir(raw)
          if (!picked) {
            setDirHint('没有选择目录')
            return
          }
          setDirDraft(picked)
          setDirHint('')
          // 选完立刻保存并校验，不再需要单独的「检查目录」
          await run('save-dir', async () => {
            const check = await callApi('/check-dir', { method: 'POST', body: JSON.stringify({ dir: picked }) })
            if (!check.ok) throw new Error(check.message || '目录不可用')
            setDirHint(check.message)
            return callApi('/library', { method: 'POST', body: JSON.stringify({ dir: picked }) })
          })
        } catch (e) {
          setError(e.message)
        }
      }

      const addAccount = () => run('add', async () => {
        const created = await callApi('/accounts', { method: 'POST', body: JSON.stringify(form) })
        const account = created.account
        const password = form.password
        const domain = form.domain
        setForm({ platform: form.platform, email: '', password: '', domain: '' })
        setShowForm(false)

        // 填了密码就顺手登录，省掉「保存完还要再点一次登录」
        if (!account?.id || !password) {
          return { message: '账号已保存（未填密码，稍后可用密码登录）' }
        }
        try {
          const login = await callApi(`/accounts/${encodeURIComponent(account.id)}/login`, {
            method: 'POST',
            // 域名留空时不要传空串，否则后端不会回退到账号已存的域名
            body: JSON.stringify({ password, ...(domain ? { domain } : {}) }),
          })
          return { message: `账号已保存；${login.message}` }
        } catch (e) {
          return { message: `账号已保存，但自动登录失败：${e.message}` }
        }
      })

      const removeAccount = id => run(`del-${id}`, async () => {
        await callApi(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' })
        setConfirmRemoveAccount('')
        return { message: '账号已删除' }
      })

      const loginAccount = id => run(`login-${id}`, async () => {
        const result = await callApi(`/accounts/${encodeURIComponent(id)}/login`, {
          method: 'POST',
          body: JSON.stringify({ password: passwordDraft }),
        })
        setPasswordFor('')
        setPasswordDraft('')
        return result
      })

      const verifyAccount = id => run(`verify-${id}`, async () => (
        callApi(`/accounts/${encodeURIComponent(id)}/verify`, { method: 'POST', body: '{}' })
      ))

      /** 检测所有书源的「实际接口」是否可用（首页能开不代表能搜书）。 */
      const checkSources = async () => {
        setSourceBusy(true)
        setSourceReport(null)
        setError('')
        try {
          setSourceReport(await callApi('/sources/probe', { method: 'POST', body: '{}' }))
        } catch (e) {
          setError(e.message)
        } finally {
          setSourceBusy(false)
        }
      }

      /**
       * 探测域名是否可用。Z-Library 域名经常失效，先测再存能省掉一轮无效登录。
       * @param {string} domain 待测域名。
       */
      const probeDomainName = async domain => {
        if (!domain?.trim()) { setProbeResult({ ok: false, message: '请先填写域名' }); return }
        setProbeBusy(true)
        setProbeResult(null)
        try {
          const result = await callApi('/zlibrary/probe', {
            method: 'POST',
            body: JSON.stringify({ domain: domain.trim() }),
          })
          setProbeResult(result)
        } catch (e) {
          setProbeResult({ ok: false, message: e.message })
        } finally {
          setProbeBusy(false)
        }
      }

      /**
       * 保存手工粘贴的 cookie。z-library 有浏览器验证墙，脚本登录过不去，
       * 复用浏览器验证后的 cookie 才是有效路径。
       * @param {string} id 账号 id。
       */
      const saveCookie = id => run(`cookie-${id}`, async () => {
        const value = cookieDraft.trim()
        if (!value) throw new Error('先粘贴 cookie 内容')
        const result = await callApi(`/accounts/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ cookie: value, status: 'cookie-only', note: '手工粘贴的 cookie' }),
        })
        setCookieFor('')
        setCookieDraft('')
        return { message: 'Cookie 已保存，可以点「验证」确认是否有效' }
      })

      if (!state) {
        return h('div', { style: { padding: 16, fontSize: 13, color: error ? C.err : C.dim } },
          error || '正在读取电子书设置…')
      }

      const accounts = state.accounts ?? []
      const platforms = state.platforms ?? []
      const activePlatform = platforms.find(p => p.id === form.platform)

      // 本地 OCR 的派生状态
      const localProgress = localOcr?.progress ?? { state: 'idle', percent: 0, message: '' }
      const localDownloading = localProgress.state === 'downloading'
      const localInstalled = localOcr?.model?.installed === true && localOcr?.runtime?.installed === true
      const localModelLabel = localOcr?.modelInfo?.label ?? 'Xiaomi-OCR-0'
      const localParams = localOcr?.modelInfo?.params ?? '0.8B'
      const localBytes = (localOcr?.model?.bytes ?? 0) + (localOcr?.runtime?.bytes ?? 0)

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, color: C.text } },

        error ? h('div', {
          style: {
            padding: '9px 12px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.5,
            color: C.err, border: `1px solid ${C.err}`, background: 'transparent',
          },
        }, error) : null,

        notice ? h('div', {
          style: {
            padding: '9px 12px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.5,
            color: C.ok, border: `1px solid ${C.border}`, background: C.layer1,
          },
        }, notice) : null,

        h('div', { style: { fontSize: 11.5, color: C.dim, display: 'flex', gap: 6, alignItems: 'center' } },
          h('span', {
            style: {
              display: 'inline-block', width: 7, height: 7, borderRadius: 999, flex: 'none',
              background: state.network?.proxy ? C.ok : C.warn,
            },
          }),
          state.network?.proxy
            ? `网络：经由代理 ${state.network.proxy}（登录与取书都走这条路）`
            : '网络：直连，未检测到系统代理。Z-Library 与部分书源在国内需要代理才能连上。',
        ),

        state.uiBuild
          ? h('div', { style: { fontSize: 10.5, color: C.dim, opacity: 0.7 } },
            `界面构建：${new Date(state.uiBuild).toLocaleString('zh-CN')}`)
          : null,

        h(Section, {
          title: '下载目录',
          subtitle: `下载与整理后的书都存这里。当前书库有 ${state.books ?? 0} 本书。`,
        },
          h(Row, { label: '保存路径' },
            h('div', { style: { display: 'flex', gap: 8 } },
              h('input', {
                style: { ...inputStyle, flex: 1 },
                value: dirDraft,
                placeholder: '例如 D:\\Books 或 /home/me/books',
                onChange: e => { setDirDraft(e.target.value); setDirHint('') },
                onKeyDown: e => { if (e.key === 'Enter') saveDir() },
              }),
              pickDirectory
                ? h('button', { style: button(), disabled: Boolean(busy), onClick: chooseDir }, '选择目录…')
                : null,
            ),
          ),
          dirHint ? h('div', { style: { fontSize: 11.5, color: C.dim } }, dirHint) : null,
          h('div', { style: { display: 'flex', gap: 8, marginTop: 2 } },
            h('button', {
              style: button('primary'),
              disabled: busy === 'save-dir' || !dirDraft.trim(),
              onClick: saveDir,
            }, busy === 'save-dir' ? '保存中…' : '保存并切换'),
          ),
          h('div', { style: { fontSize: 11.5, color: C.dim, lineHeight: 1.6 } },
            '切换目录不会移动已有的书；新目录会成为后续下载与整理的位置。'),
        ),

        h(Section, {
          title: '取书平台账号',
          subtitle: '保存后取书流程会自动带上这里的凭据。LibGen 与 Internet Archive 无需账号。',
        },
          accounts.length === 0
            ? h('div', { style: { fontSize: 12.5, color: C.dim } }, '还没有添加账号。')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              accounts.map(account => {
                const platform = platforms.find(p => p.id === account.platform)
                const id = account.id
                return h('div', {
                  key: id,
                  style: {
                    border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px',
                    background: C.layer2, display: 'flex', flexDirection: 'column', gap: 7,
                  },
                },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h('span', { style: { fontSize: 13, fontWeight: 600 } }, platform?.label ?? account.platform),
                    h('span', { style: { fontSize: 12.5, color: C.dim } }, account.email),
                    h('span', {
                      style: { fontSize: 11, padding: '1px 7px', borderRadius: 999, border: `1px solid ${statusColor(account.status)}`, color: statusColor(account.status) },
                    }, statusText(account.status)),

                    // 今日配额：超过上限时标红，免得下书时才撞墙
                    quotas[id]?.ok
                      ? h('span', {
                        style: {
                          fontSize: 11, padding: '1px 7px', borderRadius: 999,
                          border: `1px solid ${quotas[id].remaining > 0 ? C.border : C.err}`,
                          color: quotas[id].remaining > 0 ? C.dim : C.err,
                        },
                        title: `今日已下载 ${quotas[id].downloadsToday} 本，上限 ${quotas[id].downloadsLimit} 本`,
                      }, `今日 ${quotas[id].downloadsToday}/${quotas[id].downloadsLimit}`)
                      : null,

                    h('span', { style: { flex: 1 } }),
                    h('button', { style: button(), disabled: Boolean(busy), onClick: () => verifyAccount(id) },
                      busy === `verify-${id}` ? '验证中…' : '验证'),
                    // 删的是线上账号凭据，误点无法恢复，所以要点两下
                    confirmRemoveAccount === id
                      ? h('span', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                        h('span', { style: { fontSize: 11.5, color: C.err } }, '确认删除这份凭据？'),
                        h('button', {
                          style: { ...button('primary'), borderColor: C.err, color: C.err },
                          disabled: Boolean(busy),
                          onClick: () => removeAccount(id),
                        }, busy === `del-${id}` ? '删除中…' : '确认'),
                        h('button', { style: button(), onClick: () => setConfirmRemoveAccount('') }, '取消'),
                      )
                      : h('button', {
                        style: button(),
                        disabled: Boolean(busy),
                        onClick: () => setConfirmRemoveAccount(id),
                      }, '删除'),
                  ),
                  account.domain ? h('div', { style: { fontSize: 11.5, color: C.dim } }, account.domain) : null,
                  account.note ? h('div', { style: { fontSize: 11.5, color: C.dim, lineHeight: 1.5 } }, account.note) : null,

                  passwordFor === id
                    ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                      h('input', {
                        style: { ...inputStyle, flex: 1 },
                        type: 'password',
                        placeholder: '输入密码用于登录',
                        value: passwordDraft,
                        onChange: e => setPasswordDraft(e.target.value),
                        onKeyDown: e => { if (e.key === 'Enter') loginAccount(id) },
                      }),
                      h('button', { style: button('primary'), disabled: Boolean(busy), onClick: () => loginAccount(id) },
                        busy === `login-${id}` ? '登录中…' : '登录'),
                      h('button', { style: button(), onClick: () => { setPasswordFor(''); setPasswordDraft('') } }, '取消'),
                    )
                    : h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                      h('button', { style: button(), onClick: () => { setPasswordFor(id); setPasswordDraft(''); setCookieFor('') } }, '用密码登录'),
                      h('button', {
                        style: button(cookieFor === id ? 'primary' : undefined),
                        onClick: () => {
                          setCookieFor(cookieFor === id ? '' : id)
                          setCookieDraft('')
                          setPasswordFor('')
                        },
                      }, cookieFor === id ? '收起' : '粘贴 Cookie'),
                    ),

                  // 浏览器验证墙只有复用浏览器 cookie 能过，所以这条路要显眼一点
                  cookieFor === id
                    ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                      h('div', { style: { fontSize: 11.5, color: C.dim, lineHeight: 1.6 } },
                        '后备手段：正常情况下 eAPI 登录就够了，用不到这里。若登录提示需要浏览器验证，再在浏览器打开该站通过验证，F12 → Network → 任一请求 → 复制 Cookie 整段粘进来。'),
                      h('textarea', {
                        style: { ...inputStyle, minHeight: 68, resize: 'vertical', fontFamily: 'ui-monospace, monospace', fontSize: 11.5 },
                        placeholder: 'remix_userid=...; remix_userkey=...; __diamwall=...',
                        value: cookieDraft,
                        onChange: e => setCookieDraft(e.target.value),
                      }),
                      h('div', { style: { display: 'flex', gap: 8 } },
                        h('button', {
                          style: button('primary'),
                          disabled: Boolean(busy) || !cookieDraft.trim(),
                          onClick: () => saveCookie(id),
                        }, busy === `cookie-${id}` ? '保存中…' : '保存 Cookie'),
                        h('button', { style: button(), onClick: () => { setCookieFor(''); setCookieDraft('') } }, '取消'),
                      ),
                    )
                    : null,
                )
              }),
            ),

          showForm
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, borderTop: `1px solid ${C.border}`, paddingTop: 12 } },
              h(Row, { label: '平台' },
                h('select', {
                  style: inputStyle,
                  value: form.platform,
                  onChange: e => setForm({ ...form, platform: e.target.value }),
                }, platforms.map(p => h('option', { key: p.id, value: p.id }, p.label))),
              ),
              activePlatform?.note
                ? h('div', { style: { fontSize: 11.5, color: C.dim, lineHeight: 1.5 } }, activePlatform.note)
                : null,
              activePlatform?.id === 'zlibrary'
                ? h(Row, { label: '站点域名（可选）' },
                  h('div', { style: { display: 'flex', gap: 8 } },
                    h('input', {
                      style: { ...inputStyle, flex: 1 },
                      value: form.domain,
                      placeholder: '留空用默认 z-lib.by',
                      onChange: e => { setForm({ ...form, domain: e.target.value }); setProbeResult(null) },
                    }),
                    h('button', {
                      style: button(),
                      disabled: probeBusy,
                      onClick: () => probeDomainName(form.domain || 'z-lib.by'),
                    }, probeBusy ? '测试中…' : '测试连接'),
                  ),
                  probeResult
                    ? h('div', {
                      style: {
                        fontSize: 11.5, lineHeight: 1.5,
                        color: probeResult.ok ? C.ok : C.err,
                      },
                    }, `${probeResult.ok ? '✓ ' : '✗ '}${probeResult.message}`)
                    : null,
                  h('div', { style: { fontSize: 11.5, color: C.dim, lineHeight: 1.6 } },
                    '登录走 Z-Library 的 eAPI 接口，不需要浏览器验证，填邮箱密码即可。域名只在该站换地址时才需要改。'),
                )
                : null,
              h(Row, { label: '账号邮箱' },
                h('input', {
                  style: inputStyle,
                  value: form.email,
                  placeholder: 'you@example.com',
                  onChange: e => setForm({ ...form, email: e.target.value }),
                }),
              ),
              h(Row, { label: '密码（可选）', hint: '不填也能保存账号；登录时再输入。密码只存在本机。' },
                h('input', {
                  style: inputStyle,
                  type: 'password',
                  value: form.password,
                  onChange: e => setForm({ ...form, password: e.target.value }),
                }),
              ),
              h('div', { style: { display: 'flex', gap: 8 } },
                h('button', { style: button('primary'), disabled: busy === 'add' || !form.email.trim(), onClick: addAccount },
                  busy === 'add' ? '保存中…' : '保存账号'),
                h('button', { style: button(), onClick: () => setShowForm(false) }, '取消'),
              ),
            )
            : h('div', null,
              h('button', { style: button(), onClick: () => setShowForm(true) }, '+ 添加账号'),
            ),
        ),

        h(Section, {
          title: '任务模型',
          subtitle: 'OCR、翻译与阅读可以各用一套模型。批量任务用便宜的小模型、主对话用强模型，'
            + '两边互不影响。留空表示跟随当前会话的默认模型。',
        },
          modelData && modelData.models.length > 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
              // OCR：只列明确支持图片的模型
              h(Row, { label: 'OCR 模型（需要图片输入能力）' },
                h('select', {
                  style: inputStyle,
                  disabled: Boolean(busy),
                  value: modelData.current?.ocr?.model
                    ? `${modelData.current.ocr.provider}|${modelData.current.ocr.model}`
                    : '',
                  onChange: e => saveModel('ocr', e.target.value),
                },
                  h('option', { value: '' }, '跟随会话默认'),
                  modelData.models
                    .filter(item => item.image !== false)
                    .map(item => h('option', {
                      key: `ocr:${item.provider}:${item.model}`,
                      value: `${item.provider}|${item.model}`,
                    }, `${item.providerName} · ${item.modelName}${modalityTag(item)}`)),
                ),
              ),

              // 本地 OCR：Xiaomi-OCR-0（0.8B），下载后离线识别，不花 token
              localOcr
                ? h('div', {
                  style: {
                    border: `1px solid ${localOcr.enabled && localInstalled ? C.brand : C.border}`,
                    borderRadius: 8, padding: '10px 12px', background: C.layer2,
                    display: 'flex', flexDirection: 'column', gap: 8,
                  },
                },
                  h('label', {
                    style: {
                      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                      fontSize: 12.5, color: C.text, cursor: 'pointer',
                    },
                  },
                    h('input', {
                      type: 'checkbox',
                      checked: localOcr.enabled === true,
                      disabled: Boolean(busy),
                      onChange: e => toggleLocalOcr(e.target.checked),
                      style: { cursor: 'pointer' },
                    }),
                    `使用本地模型（${localModelLabel} · ${localParams}）`,
                    localInstalled
                      ? h('span', { style: { fontSize: 11, color: C.ok } }, `已就绪 · ${formatBytes(localBytes)}`)
                      : h('span', { style: { fontSize: 11, color: C.dim } }, '未下载'),
                    h('span', { style: { flex: 1 } }),
                    localDownloading
                      ? h('button', {
                        type: 'button',
                        style: { ...button(), padding: '2px 10px', fontSize: 11.5 },
                        disabled: busy === 'local-cancel',
                        onClick: cancelLocalOcr,
                      }, busy === 'local-cancel' ? '取消中…' : '取消下载')
                      : localInstalled
                        ? h('button', {
                          type: 'button',
                          style: { ...button(), padding: '2px 10px', fontSize: 11.5 },
                          disabled: Boolean(busy),
                          onClick: deleteLocalOcr,
                        }, busy === 'local-delete' ? '删除中…' : '删除模型')
                        : h('button', {
                          type: 'button',
                          style: { ...button('primary'), padding: '2px 10px', fontSize: 11.5 },
                          disabled: Boolean(busy) || localDownloading,
                          onClick: downloadLocalOcr,
                        }, busy === 'local-download' ? '启动中…' : '下载模型'),
                  ),

                  // 进度 / 状态
                  localDownloading
                    ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                      h('div', {
                        style: {
                          height: 4, borderRadius: 999, background: C.border, overflow: 'hidden',
                        },
                      }, h('div', {
                        style: {
                          height: '100%', width: `${Math.max(2, localProgress.percent ?? 0)}%`,
                          background: C.brand, transition: 'width .3s ease',
                        },
                      })),
                      h('div', { style: { fontSize: 11, color: C.dim } },
                        `${localProgress.message || '下载中'}${localProgress.percent ? ` · ${localProgress.percent}%` : ''}`
                        + (localProgress.received
                          ? ` · ${formatBytes(localProgress.received)}${localProgress.total ? `/${formatBytes(localProgress.total)}` : ''}`
                          : '')),
                    )
                    : localProgress.state === 'error'
                      ? h('div', { style: { fontSize: 11, color: C.err, lineHeight: 1.6 } },
                        `下载失败：${localProgress.message}`)
                      : h('div', { style: { fontSize: 11, color: C.dim, lineHeight: 1.6 } },
                        localInstalled
                          ? `已安装${localOcr.running ? ' · 服务已加载' : ' · 服务按需启动'}，识别不再调用远端模型`
                          : '首次使用需要下载模型（约 700MB）与 llama.cpp 运行库（约 25MB）。下载后可离线识别扫描件，不消耗 token。'),

                  // 识别模式：纯文本 / 整页 Markdown
                  localInstalled
                    ? h(Row, { label: '本地识别模式' },
                      h('select', {
                        style: inputStyle,
                        disabled: Boolean(busy),
                        value: localOcr.mode === 'document' ? 'document' : 'text',
                        onChange: e => setLocalOcrMode(e.target.value),
                      },
                        h('option', { value: 'text' }, '纯文本（按阅读顺序抽文字）'),
                        h('option', { value: 'document' }, '整页 Markdown（表格 OTSL、公式 LaTeX）'),
                      ),
                    )
                    : null,

                  h('div', { style: { fontSize: 11, color: C.dim, lineHeight: 1.6 } },
                    '开启后，扫描件的 OCR 优先走本地模型；本地失败会自动退回上面的视觉模型，不会中断入库。'),
                )
                : null,

              // 翻译：全部模型可选
              h(Row, { label: '翻译模型' },
                h('select', {
                  style: inputStyle,
                  disabled: Boolean(busy),
                  value: modelData.current?.translate?.model
                    ? `${modelData.current.translate.provider}|${modelData.current.translate.model}`
                    : '',
                  onChange: e => saveModel('translate', e.target.value),
                },
                  h('option', { value: '' }, '跟随会话默认'),
                  modelData.models.map(item => h('option', {
                    key: `tr:${item.provider}:${item.model}`,
                    value: `${item.provider}|${item.model}`,
                  }, `${item.providerName} · ${item.modelName}${modalityTag(item)}`)),
                ),
                h('div', { style: { fontSize: 11.5, color: C.dim, lineHeight: 1.5 } },
                  '翻译是纯文本任务，不要求图片能力，所以这里列全部模型；上面的 OCR 才按图片能力筛过。'),
              ),

              // 阅读：ebook_ask 用，读书的 token 花在这个模型上而不是主对话
              h(Row, { label: '阅读模型（ebook_ask 用）' },
                h('select', {
                  style: inputStyle,
                  disabled: Boolean(busy),
                  value: modelData.current?.read?.model
                    ? `${modelData.current.read.provider}|${modelData.current.read.model}`
                    : '',
                  onChange: e => saveModel('read', e.target.value),
                },
                  h('option', { value: '' }, '跟随会话默认'),
                  modelData.models.map(item => h('option', {
                    key: `read:${item.provider}:${item.model}`,
                    value: `${item.provider}|${item.model}`,
                  }, `${item.providerName} · ${item.modelName}${modalityTag(item)}`)),
                ),
                h('div', { style: { fontSize: 11.5, color: C.dim, lineHeight: 1.5 } },
                  'ebook_ask 在本地读章节，再交给这个模型整理答案，原文不进主对话——用它把「读书」的 token 从主模型挪到便宜模型上。太长会分批摘录再汇总。'),
              ),

              h('div', { style: { fontSize: 11.5, color: C.dim, lineHeight: 1.6 } },
                '这些设置只影响插件内部的 OCR、翻译与阅读调用，不改动你当前会话使用的模型。'),

              // 翻译执行方式
              h('div', {
                style: {
                  borderTop: `1px solid ${C.border}`, paddingTop: 10,
                  display: 'flex', flexDirection: 'column', gap: 6,
                },
              },
                h('label', {
                  style: {
                    display: 'flex', alignItems: 'center', gap: 8,
                    fontSize: 12.5, color: C.text, cursor: 'pointer',
                  },
                },
                  h('input', {
                    type: 'checkbox',
                    checked: state.translateViaSubagent === true,
                    disabled: Boolean(busy),
                    onChange: e => setTranslateMode(e.target.checked),
                    style: { cursor: 'pointer' },
                  }),
                  '翻译交给子代理执行',
                ),
                h('div', { style: { fontSize: 11.5, color: C.dim, lineHeight: 1.6 } },
                  state.translateViaSubagent
                    ? '当前：子代理模式。每章在独立会话里翻译，主对话不参与正文，可做多轮自查；速度明显更慢。'
                    : '当前：直接调用。每章一次请求，快；但只有单轮，没有自查环节。'),
              ),

              // 侧栏图标
              h('div', {
                style: {
                  borderTop: `1px solid ${C.border}`, paddingTop: 10,
                  display: 'flex', flexDirection: 'column', gap: 6,
                },
              },
                h('label', {
                  style: {
                    display: 'flex', alignItems: 'center', gap: 8,
                    fontSize: 12.5, color: C.text, cursor: 'pointer',
                  },
                },
                  h('input', {
                    type: 'checkbox',
                    checked: state.showSidebarIcon !== false,
                    disabled: Boolean(busy),
                    onChange: e => setSidebarIcon(e.target.checked),
                    style: { cursor: 'pointer' },
                  }),
                  '在侧栏显示书库图标',
                ),
                h('div', { style: { fontSize: 11.5, color: C.dim, lineHeight: 1.6 } },
                  '关掉后书库面板仍在，只是侧栏不再放入口。改动要重启 DSH 才生效。'),
              ),
            )
            : h('div', { style: { fontSize: 12, color: C.dim } },
              '没有读到可用模型列表——可以直接在插件配置里填 llm.ocr / llm.translate。'),
        ),

        h(Section, {
          title: '微信读书',
          subtitle: '推送走墨水屏端接口。扫码登录最省事，也可以手动填 refreshToken 与 deviceId。',
        },
          // 扫码登录
          h(WereadQrLogin, {
            onDone: () => refresh(),
          }),

          h(Row, { label: 'refreshToken' },
            h('input', {
              style: inputStyle,
              type: 'password',
              value: wereadDraft.refreshToken,
              placeholder: '从微信读书 App / 墨水屏端抓包获取',
              onChange: e => setWereadDraft({ ...wereadDraft, refreshToken: e.target.value }),
            }),
          ),
          h(Row, { label: 'deviceId' },
            h('input', {
              style: inputStyle,
              value: wereadDraft.deviceId,
              placeholder: '设备标识',
              onChange: e => setWereadDraft({ ...wereadDraft, deviceId: e.target.value }),
            }),
          ),
          h(Row, { label: 'vid（可选）' },
            h('input', {
              style: inputStyle,
              value: wereadDraft.vid,
              placeholder: '留空则自动换取',
              onChange: e => setWereadDraft({ ...wereadDraft, vid: e.target.value }),
            }),
          ),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 2, alignItems: 'center', flexWrap: 'wrap' } },
            h('button', {
              style: button('primary'),
              disabled: busy === 'weread' || !wereadDraft.refreshToken.trim() || !wereadDraft.deviceId.trim(),
              onClick: saveWeread,
            }, busy === 'weread' ? '保存中…' : '保存凭据'),

            confirmClearWeread
              ? h('span', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('span', { style: { fontSize: 12, color: C.err } }, '确认删除已保存的凭据？'),
                h('button', {
                  style: { ...button('primary'), borderColor: C.err, color: C.err },
                  disabled: busy === 'weread-clear',
                  onClick: async () => {
                    await clearWeread()
                    setConfirmClearWeread(false)
                  },
                }, busy === 'weread-clear' ? '删除中…' : '确认删除'),
                h('button', { style: button(), onClick: () => setConfirmClearWeread(false) }, '取消'),
              )
              : h('button', {
                style: button(),
                disabled: Boolean(busy) || !state?.wereadReady,
                onClick: () => setConfirmClearWeread(true),
              }, '删除凭据'),

            state.wereadReady
              ? h('span', { style: { fontSize: 11.5, color: C.ok } }, '已配置，可在书库详情里推送')
              : h('span', { style: { fontSize: 11.5, color: C.dim } }, '未配置，推送按钮会提示补全'),
          ),
        ),

        h(Section, {
          title: '书源可达性',
          subtitle: '检测各书源的实际接口，而不是首页——首页能开但搜索被挡是常见情况。'
            + '直连不通的源需要代理。',
        },
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
            h('button', { style: button(), disabled: sourceBusy, onClick: checkSources },
              sourceBusy ? '检测中…' : '检测书源'),
            sourceReport
              ? h('span', { style: { fontSize: 11.5, color: C.dim } },
                `检测于 ${new Date(sourceReport.checkedAt).toLocaleTimeString('zh-CN')}`
                + ` · ${sourceReport.proxy ? `经代理 ${sourceReport.proxy}` : '直连'}`)
              : h('span', { style: { fontSize: 11.5, color: C.dim } }, '点左侧按钮开始'),
          ),

          sourceReport
            ? h('div', {
              style: {
                display: 'flex', flexDirection: 'column', gap: 6,
                background: C.layer2, border: `1px solid ${C.border}`,
                borderRadius: 6, padding: '10px 12px',
              },
            },
              sourceReport.results.map(r => h('div', {
                key: r.id,
                style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, lineHeight: 1.5 },
              },
                h('span', {
                  style: {
                    width: 7, height: 7, borderRadius: 999, flex: 'none',
                    alignSelf: 'center',
                    background: r.ok ? C.ok : C.dim,
                  },
                }),
                h('span', { style: { color: C.text, minWidth: 132 } }, r.label),
                h('span', { style: { color: C.dim, fontSize: 11, minWidth: 118 } }, r.detail),
                h('span', {
                  style: { color: r.ok ? C.ok : C.dim, minWidth: 58, fontVariantNumeric: 'tabular-nums' },
                }, r.ok ? `${r.ms}ms` : '不可用'),
                h('span', { style: { color: C.dim, fontSize: 11, flex: 1 } }, r.message),
              )),
            )
            : null,

          h('div', { style: { fontSize: 11.5, color: C.dim, lineHeight: 1.6 } },
            'LibGen 有多个镜像，只要有一个可用就能取书；全不可用时检查代理。'),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 目录选择器走 DSH 的 directoryPicker（Host 侧弹系统对话框）。
        // 注意：Cordis 的 inject 不展开点号路径，'remote' 和 'remote.directoryPicker'
        // 是两个独立 key，必须都声明——只写后者会在访问 scoped.remote 时抛错。
        // 服务不可用时 pickDirectory 保持 null，面板里退化成手动输入。
        let pickDirectory = null
        ctx.inject(['remote', 'remote.directoryPicker'], scoped => {
          // 取服务的动作要放在函数里：注册时服务可能还没就绪，
          // 真正调用时若不可用，异常由调用方（chooseDir）捕获提示。
          pickDirectory = () => scoped.remote.directoryPicker.pick(new AbortController().signal)
          return () => { pickDirectory = null }
        })

        // 挂在插件自己的详情页上（Plugins → 电子书库），不占用 DSH 设置页。
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-ebook',
          inject: () => ({ pickDirectory: pickDirectory ? () => pickDirectory() : undefined }),
        }, EbookSettings))

        // 侧栏顶部的面板图标：id 与下面 main 的 key 对应，侧栏自己渲染按钮与标题。
        // 先注册（否则会有一段时间没有入口），再异步读配置决定是否撤掉。
        ctx.slots.inject('sidebar.panellist', () => {
          const dispose = ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'dsh-ebook',
            order: 20,
            label: '书库',
          }, LibraryIcon)
          fetch(`${API}/state`)
            .then(response => (response.ok ? response.json() : null))
            .then(state => {
              if (state && state.showSidebarIcon === false) dispose?.()
            })
            .catch(() => { /* 读不到就保持显示 */ })
          return dispose
        })

        // 跳到插件详情页的能力（设置就在那页）。服务不存在时按钮不显示。
        let openPluginSettings = null
        ctx.inject(['pluginNavigation'], scoped => {
          // 同上：访问放在函数里，服务缺失时点按钮才暴露问题
          try {
            openPluginSettings = () => scoped.pluginNavigation.openBundle('dsh-ebook')
          } catch {
            openPluginSettings = null
          }
          return () => { openPluginSettings = null }
        })

        // 书库主面板：点侧栏图标后占满中栏
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'dsh-ebook',
          inject: () => ({
            openSettings: openPluginSettings ? () => openPluginSettings() : undefined,
          }),
        }, LibraryPanel))
      },
    }
  },
})
