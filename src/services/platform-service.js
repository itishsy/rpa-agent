const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const { randomUUID, createHash, createCipheriv } = require('crypto')
const { isLongfor } = require('./longfor-auth')

function normalizeUrl(value) {
  const url = new URL(String(value).trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('平台 URL 必须是 HTTP(S) 地址，不能含账号、查询参数或片段')
  return url.toString().replace(/\/+$/, '')
}

function requestForm(url, fields, options = {}) {
  return new Promise((resolve, reject) => {
    const encoded = new URLSearchParams(fields).toString()
    const target = options.query ? url + (url.includes('?') ? '&' : '?') + encoded : url
    const body = options.query ? '' : encoded
    const req = (target.startsWith('https:') ? https : http).request(target, {
      method: 'POST', timeout: 15000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...options.headers }
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk; if (data.length > 1024 * 1024) req.destroy(new Error('平台响应过大')) })
      res.on('error', reject)
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`平台认证失败（HTTP ${res.statusCode}）`)
          error.status = res.statusCode
          return reject(error)
        }
        try { resolve(JSON.parse(data)) } catch (_) { reject(new Error('平台返回了无效的认证响应')) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('平台认证请求超时')))
    req.on('error', reject)
    req.end(body)
  })
}

function encryptLoginPassword(password) {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from('1a2C9b8gh5ltvt0m'), null)
  return Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]).toString('base64')
}
function createPlatformService({ filePath, safeStorage, defaults, request = requestForm, now = Date.now, longforAuth, onSavedCredentials = async () => {} }) {
  let busy = false
  function read() {
    const exists = fs.existsSync(filePath)
    const records = exists ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : defaults().map(p => ({ name: p.name, url: normalizeUrl(p.url), username: p.username || '' }))
    if (!Array.isArray(records)) throw new Error('平台配置格式错误')
    const needsMigration = records.some(p => !p.id)
    if (exists && needsMigration) {
      // 旧版默认项补齐账号；有自定义账号的记录始终保留其凭据。
      const legacyNames = ['SaaS平台', '万科独立平台', '极物独立平台', '龙湖独立平台']
      for (const preset of defaults()) {
        const existing = records.find(p => p.name === preset.name || (preset.username && p.username === preset.username))
        if (existing) continue
        const legacy = records.find(p => legacyNames.includes(p.name) && normalizeUrl(p.url) === normalizeUrl(preset.url) && !p.username && !p.passwordEncrypted)
        if (legacy) Object.assign(legacy, { name: preset.name, username: preset.username || '' })
        else records.push({ name: preset.name, url: normalizeUrl(preset.url), username: preset.username || '' })
      }
    }
    for (const p of records) {
      if (!p.id) p.id = 'platform-' + createHash('sha256').update(JSON.stringify([p.name, p.url, p.username || ''])).digest('hex').slice(0, 32)
    }
    if (exists && needsMigration) write(records)
    return records
  }
  function write(list) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath + '.tmp', JSON.stringify(list, null, 2), { mode: 0o600 })
    fs.renameSync(filePath + '.tmp', filePath)
  }
  function encrypt(value) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法保存密码或 Token')
    return safeStorage.encryptString(value).toString('base64')
  }
  function decrypt(value) { return safeStorage.decryptString(Buffer.from(value, 'base64')) }
  function list() {
    return read().map(p => ({ id: p.id, name: p.name, url: p.url, username: p.username || '', hasPassword: !!p.passwordEncrypted,
      status: p.tokenEncrypted ? (p.expiresAt > now() + 60000 ? '已缓存，使用前校验' : '待校验 / 刷新') : '未登录' }))
  }
  async function exclusive(work) {
    if (busy) throw new Error('正在处理平台或执行器操作，请稍候')
    busy = true
    try { return await work() } finally { busy = false }
  }
  async function authenticate(id, onProgress = () => {}) {
    const records = read()
    const p = records.find(item => item.id === id)
    if (!p) throw new Error('请先在平台管理中保存该平台')
    const client = { client_id: 'rpa', client_secret: '123' }
    onProgress('校验 Token 中')
    if (p.tokenEncrypted && (!p.expiresAt || p.expiresAt > now() + 60000)) {
      const token = decrypt(p.tokenEncrypted)
      try {
        if (longforAuth && isLongfor(p.url) && p.authMode === 'longfor-client' && longforAuth.validate) {
          const checked = await longforAuth.validate(p, token)
          p.expiresAt = now() + checked.expires_in * 1000
          write(records)
          return { ...p, token }
        }
        const checked = await request(p.url + '/oauth/check_token', { ...client, token })
        const check = checked && checked.data && typeof checked.data === 'object' ? checked.data : checked
        if (check && !check.error && check.active !== false && Number(check.exp) * 1000 > now() + 60000) {
          p.expiresAt = Number(check.exp) * 1000
          write(records)
          return { ...p, token }
        }
      } catch (e) {
        if (![400, 401, 403, 404, 405].includes(e.status)) throw e
      }
    }
    delete p.tokenEncrypted
    delete p.expiresAt
    write(records)
    if (!p.username || !p.passwordEncrypted) throw new Error(`${p.name}：请在平台管理中填写该平台的登录账号和密码`)
    onProgress('自动登录中')
    // 与 RPA IDE 主登录页保持一致：username/password 放在查询参数中，密码使用 AES-128-ECB/PKCS7。
    const response = await request(p.url + '/oauth/token', {
      ...client, grant_type: 'password', username: p.username,
      password: encryptLoginPassword(decrypt(p.passwordEncrypted))
    }, { query: true })
    const data = response && response.data && typeof response.data === 'object' ? response.data : response
    if (!data || !data.access_token || data.custId == null || !data.custName) {
      throw new Error((data && (data.error_description || data.message || data.msg)) || '登录响应缺少 Token 或客户信息')
    }
    p.tokenEncrypted = encrypt(data.access_token)
    p.expiresAt = Number(data.expires_in) > 0 ? now() + Number(data.expires_in) * 1000 : 0
    p.custId = data.custId
    p.custName = data.custName
    delete p.authMode
    write(records)
    return { ...p, token: data.access_token }
  }
  async function save(input) {
    return exclusive(async () => {
      if (!Array.isArray(input)) throw new Error('平台配置格式错误')
      const old = read()
      const names = new Set()
      const usernames = new Set()
      const ids = new Set()
      const records = input.map(item => {
        const url = normalizeUrl(item.url)
        const name = String(item.name || '').trim()
        const username = String(item.username || '').trim()
        if (!name || names.has(name)) throw new Error('平台名称不能为空或重复')
        if (username && usernames.has(username)) throw new Error('登录账号不能重复')
        names.add(name)
        if (username) usernames.add(username)
        const previous = item.id ? old.find(p => p.id === item.id) : undefined
        if (item.id && !previous) throw new Error('平台记录已变化，请重新打开平台管理')
        const id = previous ? previous.id : randomUUID()
        if (ids.has(id)) throw new Error('平台标识不能重复')
        ids.add(id)
        const p = previous ? { ...previous, name, url, username } : { id, name, url, username }
        if (item.password || item.clearPassword || (previous && (previous.username !== username || previous.url !== url))) {
          delete p.tokenEncrypted; delete p.expiresAt; delete p.custId; delete p.custName
        }
        if (item.clearPassword) delete p.passwordEncrypted
        if (item.password) p.passwordEncrypted = encrypt(String(item.password))
        return p
      })
      write(records)
      const results = []
      for (const p of records) {
        if (!p.username || !p.passwordEncrypted) continue
        try { const credentials = await authenticate(p.id); await onSavedCredentials(credentials); results.push(`${p.name}：登录就绪`) }
        catch (e) { results.push(`${p.name}：${e.message}`) }
      }
      return { platforms: list(), message: '配置已保存。\n' + results.join('\n') }
    })
  }
  function resolveCurrent({ platformId, platform, username }) {
    const records = list()
    if (platformId) {
      const selected = records.find(p => p.id === platformId)
      if (selected) return selected
      throw new Error('当前平台已删除，请使用“切换平台”重新选择')
    }
    const matches = records.filter(p => normalizeUrl(p.url) === normalizeUrl(platform) && (!username || p.username === username))
    if (matches.length === 1) return matches[0]
    throw new Error('当前地址对应多个客户或未配置，请使用“切换平台”选择具体平台')
  }
  async function recoverLongfor(id, loginUrl, expectedToken) {
    const records = read()
    const p = records.find(item => item.id === id)
    if (!longforAuth || !p || !isLongfor(p.url) || !p.tokenEncrypted || decrypt(p.tokenEncrypted) !== expectedToken) throw new Error('平台凭据已变化，请重新查询')
    const data = await longforAuth.recover(p, loginUrl)
    p.tokenEncrypted = encrypt(data.access_token)
    p.expiresAt = now() + data.expires_in * 1000
    p.custId = data.custId; p.custName = data.custName; p.authMode = 'longfor-client'
    write(records)
    return { ...p, token: data.access_token }
  }
  return { list, save, authenticate, exclusive, resolveCurrent, recoverLongfor }
}

function updateProperties(content, values) {
  for (const [key, raw] of Object.entries(values)) {
    const value = String(raw)
    if (/[\r\n]/.test(value)) throw new Error('配置值不能包含换行')
    const expression = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=.*$', 'gm')
    const line = key + '=' + value.replace(/\\/g, '\\\\')
    content = expression.test(content) ? content.replace(expression, () => line) : content.trimEnd() + '\n' + line + '\n'
  }
  return content
}

async function activatePlatform({ stop, authenticate, writeConfig, start, onStarted, onProgress = () => {} }, id) {
  onProgress('正在停止当前执行器')
  await stop()
  onProgress('校验 Token 中')
  const platform = await authenticate(id)
  onProgress('正在更新执行器配置')
  await writeConfig(platform)
  onProgress('启动中')
  await start()
  onStarted(platform)
}

module.exports = { createPlatformService, normalizeUrl, updateProperties, activatePlatform, requestForm, encryptLoginPassword }
