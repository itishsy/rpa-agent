'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { request } = require('../src/services/executor-service')

test('debug requests send the trimmed token through the configured proxy path and classify denials', async t => {
  const received = []
  const server = http.createServer((req, res) => {
    received.push({ path: req.url, token: req.headers['x-rpa-debug-token'] })
    if (received.length === 1) res.end('{"code":200,"data":{"status":"SUCCEEDED"}}')
    else {
      res.statusCode = 401
      res.end('{"code":500,"message":"调试访问令牌无效"}')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/virwin/p/28000/9090'
  const input = { path: '/api/robot/debug/runs', method: 'POST', body: {}, debugToken: '\ufeff test-debug-token\r\n' }
  assert.equal((await request(baseUrl, input)).data.status, 'SUCCEEDED')
  assert.deepEqual(received[0], { path: '/virwin/p/28000/9090/api/robot/debug/runs', token: 'test-debug-token' })
  await assert.rejects(request(baseUrl, input), error => error.code === 'EXECUTOR_DEBUG_AUTH' &&
    error.message.includes(baseUrl) && !error.message.includes('test-debug-token'))
})
