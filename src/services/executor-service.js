'use strict'

const http = require('http')
const https = require('https')

const DEFAULT_EXECUTOR_BASE_URL = 'http://localhost:9090'
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_EXECUTOR_BASE_URL).trim()
  let parsed
  try { parsed = new URL(raw) } catch (_) { throw new Error('执行器服务地址格式不正确') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('执行器服务地址只支持 http 或 https')
  if (parsed.username || parsed.password) throw new Error('执行器服务地址不能包含用户名或密码')
  if (parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error('执行器服务地址只填写协议、主机和端口，例如 http://192.168.1.20:9090')
  }
  return parsed.origin
}

function isLocalBaseUrl(value) {
  const hostname = new URL(normalizeBaseUrl(value)).hostname.toLowerCase()
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

function request(baseUrl, options = {}) {
  const normalized = normalizeBaseUrl(baseUrl)
  const requestPath = String(options.path || '')
  if (!requestPath.startsWith('/api/robot/')) throw new Error('不允许访问该执行器接口')
  const target = new URL(requestPath, normalized + '/')
  if (target.origin !== new URL(normalized).origin || !target.pathname.startsWith('/api/robot/')) {
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
  if (target.pathname.startsWith('/api/robot/debug/runs') && options.debugToken) {
    headers['X-RPA-Debug-Token'] = options.debugToken
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
        try { data = raw ? JSON.parse(raw) : null } catch (_) { return reject(new Error('执行器返回的不是有效 JSON')) }
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

