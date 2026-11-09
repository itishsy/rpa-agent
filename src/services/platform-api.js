'use strict'
const http = require('node:http')
const https = require('node:https')

function platformRequest(platform, input = {}) {
  const base = new URL(platform.url.replace(/\/+$/, '') + '/')
  const relative = String(input.path || '').replace(/^\//, '')
  if (!/^(robot|policy)\//.test(relative)) throw new Error('平台接口不在业务范围')
  const target = new URL(relative, base)
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) || !/^(robot|policy)\//.test(target.pathname.slice(base.pathname.length))) throw new Error('平台请求越界')
  for (const [key, value] of Object.entries(input.params || {})) if (value !== undefined && value !== null) target.searchParams.set(key, String(value))
  const method = String(input.method || 'POST').toUpperCase()
  if (!['GET', 'POST'].includes(method)) throw new Error('不支持的请求方法')
  const form = input.encoding === 'form'
  const payload = input.body === undefined ? null : Buffer.from(form ? new URLSearchParams(input.body).toString() : JSON.stringify(input.body))
  return new Promise((resolve, reject) => {
    const req = (target.protocol === 'https:' ? https : http).request(target, { method, timeout: 60000,
      headers: { Authorization: 'Bearer ' + platform.token, ...(payload ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': payload.length } : {}) }
    }, res => {
      const chunks = []; let size = 0
      res.on('data', chunk => { size += chunk.length; if (size > 64 * 1024 * 1024) req.destroy(new Error('平台响应超过64MiB')); else chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', () => {
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (res.statusCode < 200 || res.statusCode >= 300 || response.code && Number(response.code) !== 200) {
            const error=new Error(response.message || response.msg || '业务请求失败 HTTP ' + res.statusCode)
            error.status=res.statusCode;error.code=Number(response.code)||res.statusCode
            throw error
          }
          resolve(response.data === undefined ? response : response.data)
        } catch (error) { reject(error) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('平台请求超时')))
    req.on('error', reject)
    if (input.signal) {
      const abort = () => req.destroy(new Error('请求已停止'))
      if (input.signal.aborted) abort()
      else { input.signal.addEventListener('abort', abort, { once: true }); req.on('close', () => input.signal.removeEventListener('abort', abort)) }
    }
    if (payload) req.write(payload)
    req.end()
  })
}
module.exports = { platformRequest }
