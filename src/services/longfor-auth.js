const { createCipheriv, createHash } = require('crypto')

function isLongfor(base) {
  const u = new URL(base)
  return u.origin === 'https://gwp0-m7.longfor.com' && /^\/rpa-client-auth\/api\/?$/.test(u.pathname)
}
function callbackToken(loginUrl, base) {
  let u
  try { u = new URL(loginUrl) } catch (_) { throw new Error('龙湖单点登录回调地址格式无效') }
  const trusted = u.origin === new URL(base).origin || u.origin === 'http://localhost.longfor.com:8000'
  if (!trusted || u.username || u.password || !u.hash.startsWith('#/singleAuth?')) throw new Error('龙湖返回了非预期的单点登录回调，已拒绝使用')
  const token = new URLSearchParams(u.hash.slice(u.hash.indexOf('?') + 1)).get('token')
  if (!token || /[\r\n]/.test(token)) throw new Error('龙湖单点登录回调缺少有效 Token')
  return token
}

// 每个平台/账号使用独立的 Chromium Cookie 存储，不读取其它客户端的凭据。
function createLongforAuth(getSession) {
  function sessionFor(p) {
    return getSession('persist:rpa-platform-' + createHash('sha256').update(JSON.stringify([p.id, p.url, p.username])).digest('hex'))
  }
  async function request(p, url, method = 'POST', body, token, form = false) {
    if (!isLongfor(p.url) || new URL(url).origin !== new URL(p.url).origin) throw new Error('拒绝向其他站点发送龙湖凭据')
    const session = sessionFor(p)
    const headers = { Accept: 'application/json', 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    const cookies = await session.cookies.get({ url: p.url, name: 'account' })
    if (cookies.length) {
      try { headers.token = decodeURIComponent(cookies[0].value) } catch (_) { throw new Error('龙湖 account Cookie 格式无效') }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    try {
      // 不自动跟随重定向，防止凭据被带到不同站点。单点回调只解析，不访问。
      const response = await session.fetch(url, { method, headers, credentials: 'include', redirect: 'manual', signal: controller.signal,
        ...(body == null ? {} : { body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) }) })
      let value
      try { value = await response.json() } catch (_) { throw new Error(`龙湖接口 ${new URL(url).pathname} 返回非 JSON（HTTP ${response.status}）`) }
      if (!response.ok || (value.code != null && ![0, 200].includes(Number(value.code)))) {
        const e = new Error(`龙湖接口 ${new URL(url).pathname} 请求失败（HTTP ${response.status}；业务码 ${Number(value.code) || response.status}）`)
        e.status = e.statusCode = response.status
        e.rejected = true
        if ((response.status === 401 || Number(value.code) === 401) && typeof value.loginUrl === 'string') {
          Object.defineProperty(e, 'loginUrl', { value: value.loginUrl })
        }
        throw e
      }
      return value
    } catch (e) {
      if (e.status || /^龙湖/.test(e.message)) throw e
      throw new Error('龙湖认证请求未完成，请检查网络或稍后重试')
    } finally { clearTimeout(timer) }
  }
  async function verify(p, token) {
    let check
    try { check = await request(p, p.url.replace(/\/$/, '') + '/oauth/check_token', 'POST', { client_id: 'rpa', client_secret: '123', token }, null, true) }
    catch (e) {
      if (![401, 403, 404, 405].includes(e.status)) throw e
      // 龙湖可能不开放 check_token；改用服务端当前用户接口验证身份。
      const response = await request(p, p.url.replace(/\/$/, '') + '//api/user/current', 'POST', {}, token)
      const user = response.data || response
      if (user.id == null || user.username !== p.username || user.custId == null || (p.custId != null && String(user.custId) !== String(p.custId))) {
        throw new Error('扫码账号或客户与平台配置不一致，请使用配置账号扫码')
      }
      return { access_token: token, custId: user.custId, custName: user.custName || p.custName, expires_in: 300 }
    }
    if (check.active === false || check.error || !check.user_name || check.user_name !== p.username || Number(check.exp) * 1000 <= Date.now() + 60000) {
      throw new Error('龙湖 Token 无效或登录账号与平台配置不一致，已拒绝切换身份')
    }
    if (p.custId != null && String(check.custId) !== String(p.custId)) throw new Error('龙湖回调客户与原平台不一致，已拒绝更新')
    if (check.custId == null || !check.custName) throw new Error('龙湖 Token 缺少客户信息')
    return { access_token: token, custId: check.custId, custName: check.custName, expires_in: Math.floor(Number(check.exp) - Date.now() / 1000) }
  }
  return {
    request, sessionFor, validate: verify,
    async login(p, password) {
      // 与龙湖专用包一致：AES/ECB/PKCS7，username/password 放入 POST 查询参数。
      const cipher = createCipheriv('aes-128-ecb', Buffer.from('1a2C9b8gh5ltvt0m'), null)
      const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]).toString('base64')
      const query = new URLSearchParams({ client_id: 'rpa', client_secret: '123', grant_type: 'password', username: p.username, password: encrypted })
      let token
      try {
        const data = await request(p, p.url.replace(/\/$/, '') + '/oauth/token?' + query, 'POST')
        token = data.access_token
      } catch (e) {
        if (!e.loginUrl) throw e
        token = callbackToken(e.loginUrl, p.url)
      }
      if (!token) throw new Error('龙湖登录未返回 Token')
      return verify(p, token)
    },
    async recover(p, loginUrl) { return verify(p, callbackToken(loginUrl, p.url)) }
  }
}
module.exports = { isLongfor, callbackToken, createLongforAuth }
