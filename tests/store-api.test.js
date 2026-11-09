'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto')
const { SessionStore } = require('../src/agent/store')
const { platformRequest } = require('../src/services/platform-api')

test('session checkpoints are encrypted and partition-bound', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-agent-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const key = randomBytes(32)
  const codec = { encrypt(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64') },
    decrypt(text) { const bytes = Buffer.from(text, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString() } }
  const store = new SessionStore(directory, codec)
  const scope = { platformId: 'p1', username: 'a', executor: 'http://e', appCode: 'a', flowCode: 'f' }
  const current = store.create(scope, { steps: [], privateValue: 'not-in-plaintext' })
  assert.ok(!fs.readFileSync(store.file(current.id), 'utf8').includes('not-in-plaintext'))
  assert.equal(store.read(current.id, scope).dsl.privateValue, 'not-in-plaintext')
  assert.throws(() => store.read(current.id, { ...scope, username: 'b' }), /不属于/)
  assert.equal(store.list(scope).length, 1)
  const artifactId = require('node:crypto').randomUUID()
  const reference = store.writeArtifact(current.id, artifactId, { DOMs: ['private-dom'] })
  current.artifacts[artifactId] = reference; store.save(current)
  assert.equal(reference.external, true)
  assert.deepEqual(store.readArtifact(current.id, artifactId), { DOMs: ['private-dom'] })
  assert.ok(!JSON.stringify(store.read(current.id, scope)).includes('private-dom'))
  current.state = 'stopping'; current.turn = { calls: [{ effect: 'execute', phase: 'executing' }] }; store.save(current)
  assert.equal(store.unfinished().length, 1)
  current.state = 'completed'; store.save(current)
  assert.equal(store.unfinished().length, 0)
  assert.throws(() => store.file('../x'), /编号无效/)
})
test('platform gateway separates JSON body and query and refuses path escape and redirects', async t => {
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => {
      if (req.url.includes('redirect')) { res.writeHead(302, { Location: 'http://elsewhere.test' }); res.end('{}'); return }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data: { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) } }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close())
  const platform = { url: `http://127.0.0.1:${server.address().port}/api`, token: 'test' }
  const value = await platformRequest(platform, { path: 'robot/flow/list', params: { appCode: 'a' }, body: { x: 1 } })
  assert.equal(value.url, '/api/robot/flow/list?appCode=a'); assert.deepEqual(value.body, { x: 1 }); assert.equal(value.auth, 'Bearer test')
  assert.throws(() => platformRequest(platform, { path: 'https://evil.test/robot/x' }), /业务范围/)
  assert.throws(() => platformRequest(platform, { path: 'robot/../../elsewhere' }), /请求越界/)
  assert.throws(() => platformRequest(platform, { path: 'robot/../oauth/token' }), /请求越界/)
  await assert.rejects(platformRequest(platform, { path: 'robot/redirect', body: {} }), /HTTP 302/)
})
