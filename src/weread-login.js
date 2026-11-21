/**
 * 从本地已有的微信读书登录态里读凭据。
 *
 * 优先读 weread-omni 的账号目录（`weread-omni login` 扫码后写入），
 * 它的登录信息按账号分目录存放，格式可能随版本变化，所以这里做自适应解析：
 * 不写死文件名与字段名，而是扫目录里的 JSON，按语义找 refreshToken / deviceId / vid。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 可能的账号根目录（不同版本/平台放的位置不同）。 */
function accountRoots() {
  const home = homedir()
  const candidates = [
    process.env.WEREAD_CONFIG_DIR,
    join(home, '.config', 'weread', 'accounts'),
    join(home, 'AppData', 'Roaming', 'weread', 'accounts'),
    join(home, 'AppData', 'Local', 'weread', 'accounts'),
    join(home, '.weread', 'accounts'),
    // 兼容 XDG 覆盖
    process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'weread', 'accounts') : null,
  ]
  return candidates.filter(Boolean).filter(dir => {
    try { return existsSync(dir) && statSync(dir).isDirectory() } catch { return false }
  })
}

/**
 * 从一个 JSON 对象里按语义找字段值。
 * @param {any} value 任意对象。
 * @param {string[]} keys 候选字段名（小写比较）。
 * @param {number} [depth] 递归深度。
 * @returns {string}
 */
function dig(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return ''
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.toLowerCase().replace(/[_-]/g, '')
    if (keys.includes(key) && typeof rawValue === 'string' && rawValue.trim()) return rawValue.trim()
  }
  for (const rawValue of Object.values(value)) {
    if (rawValue && typeof rawValue === 'object') {
      const hit = dig(rawValue, keys, depth + 1)
      if (hit) return hit
    }
  }
  return ''
}

/**
 * 找设备 ID。
 *
 * 除了直接叫 deviceId / device_id / did 的字段，还要认「父级键名含 device、
 * 子级叫 id」的嵌套写法（`{ device: { id: 'xxx' } }`），以及数组形态。
 *
 * @param {any} value 任意对象。
 * @param {number} [depth] 递归深度。
 * @returns {string}
 */
function digDevice(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return ''

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.toLowerCase().replace(/[_-]/g, '')
    if (typeof rawValue === 'string' && rawValue.trim()) {
      if (key === 'deviceid' || key === 'did') return rawValue.trim()
    }
  }

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.toLowerCase().replace(/[_-]/g, '')
    if (!rawValue || typeof rawValue !== 'object') continue
    // 父级叫 device，子级里的 id 就是设备标识
    if (key.includes('device')) {
      for (const [childKey, childValue] of Object.entries(rawValue)) {
        const child = childKey.toLowerCase().replace(/[_-]/g, '')
        if ((child === 'id' || child === 'deviceid') && typeof childValue === 'string' && childValue.trim()) {
          return childValue.trim()
        }
      }
    }
    const hit = digDevice(rawValue, depth + 1)
    if (hit) return hit
  }
  return ''
}

/**
 * 读一个账号目录，抽取凭据。
 * @param {string} dir 账号目录。
 * @returns {{refreshToken:string, deviceId:string, vid:string, source:string, files:string[]}|null}
 */
function readAccountDir(dir) {
  let files
  try {
    // weread-omni 把凭据放在 <alias>/clients/<client>.json，必须递归
    files = readdirSync(dir, { recursive: true })
      .map(name => String(name))
      .filter(name => /\.json$/i.test(name))
      .map(name => join(dir, name))
  } catch {
    return null
  }

  const merged = {}
  const used = []
  for (const path of files) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      Object.assign(merged, parsed)
      used.push(path.slice(dir.length + 1).replace(/\\/g, '/'))
    } catch { /* 跳过非 JSON 或损坏文件 */ }
  }
  if (used.length === 0) return null

  const refreshToken = dig(merged, ['refreshtoken', 'refresh', 'rt'])
  const deviceId = digDevice(merged)
  const vid = dig(merged, ['vid', 'userid', 'uid'])
  if (!refreshToken || !deviceId) return null

  return { refreshToken, deviceId, vid, source: dir, files: used }
}

/**
 * 扫描所有已知位置，找出可用的微信读书凭据。
 * @returns {{accounts: Array<object>, roots: string[]}}
 */
export function findWereadCredentials() {
  const roots = accountRoots()
  const accounts = []
  for (const root of roots) {
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
    } catch {
      continue
    }
    for (const entry of entries) {
      const found = readAccountDir(join(root, entry.name))
      if (found) accounts.push({ alias: entry.name, ...found })
    }
  }
  return { accounts, roots }
}
