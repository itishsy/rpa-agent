'use strict'

const http = require('http')
const https = require('https')

const DEFAULT_EXECUTOR_BASE_URL = 'http://localhost:9090'
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024
const DEBUG_PATH = /^\/api\/robot\/debug\/runs(?:\/|\?|$)/
const ACCOUNT_PATH = /^\/api\/robot\/task\/listAllTask(?:\?|$)/

function debugAuthError(baseUrl, status, message = '') {
  const missing = /^调试访问令牌未配置[。！!]?$/.test(String(message).trim())
  const invalid = /^调试访问令牌无效[。！!]?$/.test(String(message).trim())
  if (!missing && !invalid && ![401, 403].includes(status)) return null
  const hint = missing
    ? '目标执行器未加载调试访问令牌。请核对远端执行器配置，保存后重启执行器。'
    : '目标执行器或代理拒绝了调试访问。请核对这条连接的令牌与目标执行器当前加载的令牌一致；临时调试码有效期为 1 小时。'
  return Object.assign(new Error(hint + ' 执行器：' + baseUrl), { code: 'EXECUTOR_DEBUG_AUTH' })
}

function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_EXECUTOR_BASE_URL).trim()
  let parsed
  try { parsed = new URL(raw) } catch (_) { throw new Error('执行器服务地址格式不正确') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('执行器服务地址只支持 http 或 https')
  if (parsed.username || parsed.password) throw new Error('执行器服务地址不能包含用户名或密码')
  if (parsed.search || parsed.hash) throw new Error('执行器服务地址不能包含查询参数或片段')
  return parsed.origin + parsed.pathname.replace(/\/+$/, '')
}

function isLocalBaseUrl(value) {
  const url = new URL(normalizeBaseUrl(value))
  return url.pathname === '/' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname.toLowerCase())
}

function request(baseUrl, options = {}) {
  const normalized = normalizeBaseUrl(baseUrl)
  const requestPath = String(options.path || '')
  const debug = DEBUG_PATH.test(requestPath)
  if (!requestPath.startsWith('/api/robot/')) throw new Error('不允许访问该执行器接口')
  const base = new URL(normalized)
  const prefix = base.pathname.replace(/\/$/, '')
  const target = new URL(normalized + requestPath)
  if (target.origin !== base.origin || !target.pathname.startsWith(prefix + '/api/robot/')) {
    throw new Error('执行器请求地址越界')
  }
  const method = String(options.method || 'GET').toUpperCase()
  if (!['GET', 'POST'].includes(method)) throw new Error('不支持的执行器请求方法')
  const timeout = Math.max(1000, Math.min(Number(options.timeout) || 30 * 60 * 1000, 30 * 60 * 1000))
  const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8')
  const transport = target.protocol === 'https:' ? https : http
  const headers = payload ? {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length
  } : {}
  const debugToken = String(options.debugToken || '').trim()
  if (debug || (debugToken && ACCOUNT_PATH.test(requestPath))) {
    if (!debugToken) throw Object.assign(new Error('请在执行器管理中为当前连接保存调试令牌。执行器：' + normalized), { code: 'EXECUTOR_DEBUG_AUTH' })
    if (!/^[\x21-\x7e]+$/.test(debugToken)) {
      throw Object.assign(new Error('调试令牌包含空白或非 ASCII 字符，请重新复制完整令牌。'), { code: 'EXECUTOR_DEBUG_AUTH' })
    }
    headers['X-RPA-Debug-Token'] = debugToken
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(target, {
      method,
      timeout,
      headers
    }, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('执行器响应超过 64 MiB 限制'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let data
        try { data = raw ? JSON.parse(raw) : null } catch (_) {
          return reject((debug && debugAuthError(normalized, response.statusCode)) || new Error('执行器返回的不是有效 JSON'))
        }
        if (debug && (response.statusCode >= 400 || (data?.code && Number(data.code) !== 200))) {
          const error = debugAuthError(normalized, response.statusCode, data?.message || data?.msg || data?.error)
          if (error) return reject(error)
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const message = data && (data.message || data.msg || data.error)
          return reject(new Error(message || `执行器请求失败（HTTP ${response.statusCode}）`))
        }
        resolve(data)
      })
    })
    req.on('timeout', () => req.destroy(new Error('连接执行器超时')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

module.exports = { DEFAULT_EXECUTOR_BASE_URL, normalizeBaseUrl, isLocalBaseUrl, request }

