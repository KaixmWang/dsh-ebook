/**
 * 插件自有设置：下载目录与取书平台账号。
 *
 * 独立于插件 Config 存放——目录切换和账号增删是运行时行为，
 * 走 Config 会触发插件重载，那太重了。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 空的模型指定（留空表示跟随会话默认）。
 * @returns {{provider:string, model:string}}
 */
function emptyModel() {
  return { provider: '', model: '' }
}

/**
 * 规范化一个模型指定。
 * @param {any} value 原始值。
 * @returns {{provider:string, model:string}}
 */
function normalizeModel(value) {
  return {
    provider: typeof value?.provider === 'string' ? value.provider : '',
    model: typeof value?.model === 'string' ? value.model : '',
  }
}

/** 需要账号的取书平台。
 * 只列「必须登录」的：LibGen、Internet Archive 这些无需账号的源不进这个列表，
 * 它们照样参与搜索，只是不占「账号管理」的位置。可达性在设置页的书源检测里看。
 */
export const PLATFORMS = [
  {
    id: 'zlibrary',
    label: 'Z-Library',
    needsDomain: false,
    needsAccount: true,
    note: '走 eAPI 接口，填邮箱密码直接登录，不需要浏览器验证。域名可留空用默认 z-lib.by。',
  },
]

/**
 * 设置存储。
 */
export class Settings {
  /**
   * @param {string} root 插件配置目录。
   */
  constructor(root) {
    this.root = root
    this.file = join(root, 'settings.json')
    this.data = {
      libraryDir: '',
      accounts: [],
      models: { ocr: emptyModel(), translate: emptyModel() },
      // 翻译是否交给子代理执行（独立会话，主对话看不到正文）
      translateViaSubagent: false,
      // 是否在侧栏显示书库图标（关闭后需要重启 DSH 才消失）
      showSidebarIcon: true,
      // 微信读书推送凭据（墨水屏端接口需要）
      weread: { vid: '', refreshToken: '', deviceId: '' },
    }
    mkdirSync(root, { recursive: true })
    this.load()
  }

  /**
   * 从磁盘读取。
   */
  load() {
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      this.data = {
        libraryDir: typeof parsed.libraryDir === 'string' ? parsed.libraryDir : '',
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        models: {
          ocr: normalizeModel(parsed.models?.ocr),
          translate: normalizeModel(parsed.models?.translate),
        },
        translateViaSubagent: parsed.translateViaSubagent === true,
        showSidebarIcon: parsed.showSidebarIcon !== false,
        weread: {
          vid: typeof parsed.weread?.vid === 'string' ? parsed.weread.vid : '',
          refreshToken: typeof parsed.weread?.refreshToken === 'string' ? parsed.weread.refreshToken : '',
          deviceId: typeof parsed.weread?.deviceId === 'string' ? parsed.weread.deviceId : '',
        },
      }
    } catch { /* 损坏就用默认值 */ }
  }

  /**
   * 原子写盘。
   */
  save() {
    const temporary = `${this.file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.file)
  }

  /** @returns {string} 当前下载目录。 */
  get libraryDir() {
    return this.data.libraryDir
  }

  /**
   * 设置下载目录。
   * @param {string} dir 绝对路径。
   */
  setLibraryDir(dir) {
    this.data.libraryDir = String(dir)
    this.save()
  }

  /** @returns {Array<object>} 原始账号记录（含敏感字段）。 */
  rawAccounts() {
    return this.data.accounts
  }

  /**
   * 对外展示的账号（抹掉 cookie 与密码）。
   * @returns {Array<object>}
   */
  listAccounts() {
    return this.data.accounts.map(account => ({
      id: account.id,
      platform: account.platform,
      email: account.email,
      domain: account.domain,
      hasCookie: Boolean(account.cookie),
      cookieUpdatedAt: account.cookieUpdatedAt ?? null,
      status: account.status ?? 'unknown',
      note: account.note ?? '',
      updatedAt: account.updatedAt ?? null,
    }))
  }

  /**
   * 新增账号。
   * @param {object} input 账号信息。
   * @returns {object} 脱敏后的账号。
   */
  addAccount(input) {
    const platform = String(input.platform ?? 'zlibrary')
    if (!PLATFORMS.some(item => item.id === platform)) throw new Error(`不支持的平台：${platform}`)
    const email = String(input.email ?? '').trim()
    if (!email) throw new Error('请填写账号邮箱')
    if (this.data.accounts.some(a => a.platform === platform && a.email === email)) {
      throw new Error('这个账号已经在列表里了')
    }
    const account = {
      id: randomUUID(),
      platform,
      email,
      domain: String(input.domain ?? '').trim(),
      password: input.password ? String(input.password) : '',
      cookie: String(input.cookie ?? ''),
      cookieUpdatedAt: input.cookie ? new Date().toISOString() : null,
      status: input.cookie ? 'cookie-only' : 'unverified',
      note: '',
      updatedAt: new Date().toISOString(),
    }
    this.data.accounts.push(account)
    this.save()
    return this.listAccounts().find(item => item.id === account.id)
  }

  /**
   * 更新账号字段。
   * @param {string} id 账号 id。
   * @param {object} patch 变更。
   * @returns {object|null}
   */
  updateAccount(id, patch) {
    const account = this.data.accounts.find(item => item.id === id)
    if (!account) return null
    for (const key of ['domain', 'password', 'cookie', 'status', 'note']) {
      if (patch[key] !== undefined) account[key] = String(patch[key])
    }
    if (patch.cookie !== undefined) {
      account.cookieUpdatedAt = patch.cookie ? new Date().toISOString() : null
    }
    account.updatedAt = new Date().toISOString()
    this.save()
    return this.listAccounts().find(item => item.id === id)
  }

  /**
   * 删除账号。
   * @param {string} id 账号 id。
   * @returns {boolean}
   */
  removeAccount(id) {
    const before = this.data.accounts.length
    this.data.accounts = this.data.accounts.filter(item => item.id !== id)
    if (this.data.accounts.length === before) return false
    this.save()
    return true
  }

  /**
   * 取原始账号（供取书流程使用）。
   * @param {string} platform 平台 id。
   * @returns {object|undefined}
   */
  accountFor(platform) {
    return this.data.accounts.find(item => item.platform === platform && item.cookie)
  }

  /**
   * 读某个用途的模型指定。
   * @param {'ocr'|'translate'} role 用途。
   * @returns {{provider:string, model:string}}
   */
  modelFor(role) {
    return { ...(this.data.models?.[role] ?? emptyModel()) }
  }

  /** @returns {{ocr:{provider:string,model:string}, translate:{provider:string,model:string}}} */
  allModels() {
    return {
      ocr: this.modelFor('ocr'),
      translate: this.modelFor('translate'),
    }
  }

  /**
   * 保存某个用途的模型指定。留空即「跟随会话默认」。
   * @param {'ocr'|'translate'} role 用途。
   * @param {object} value 指定。
   * @returns {{provider:string, model:string}}
   */
  setModel(role, value) {
    if (!this.data.models) this.data.models = { ocr: emptyModel(), translate: emptyModel() }
    this.data.models[role] = normalizeModel(value)
    this.save()
    return this.modelFor(role)
  }

  /** @returns {boolean} 翻译是否走子代理。 */
  get translateViaSubagent() {
    return this.data.translateViaSubagent === true
  }

  /**
   * 设置翻译是否走子代理。
   * @param {boolean} value 开关。
   * @returns {boolean}
   */
  setTranslateViaSubagent(value) {
    this.data.translateViaSubagent = value === true
    this.save()
    return this.data.translateViaSubagent
  }

  /** @returns {boolean} 是否在侧栏显示书库图标。 */
  get showSidebarIcon() {
    return this.data.showSidebarIcon !== false
  }

  /**
   * 设置是否显示侧栏图标。
   * @param {boolean} value 开关。
   * @returns {boolean}
   */
  setShowSidebarIcon(value) {
    this.data.showSidebarIcon = value !== false
    this.save()
    return this.data.showSidebarIcon
  }

  /** @returns {{vid:string, refreshToken:string, deviceId:string}} 微信读书凭据。 */
  get weread() {
    return { ...(this.data.weread ?? { vid: '', refreshToken: '', deviceId: '' }) }
  }

  /** @returns {boolean} 凭据是否够用。 */
  get wereadReady() {
    const w = this.data.weread ?? {}
    return Boolean(w.refreshToken && w.deviceId)
  }

  /**
   * 保存微信读书凭据。
   * @param {object} value 凭据。
   * @returns {{vid:string, refreshToken:string, deviceId:string}}
   */
  setWeread(value) {
    this.data.weread = {
      vid: String(value?.vid ?? '').trim(),
      refreshToken: String(value?.refreshToken ?? '').trim(),
      deviceId: String(value?.deviceId ?? '').trim(),
    }
    this.save()
    return this.weread
  }
}
