'use strict'
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { SessionStore } = require('../src/agent-core/store')
const { ExecutionEvidence } = require('../src/services/execution-evidence')

app.disableHardwareAcceleration()
const artifacts = path.resolve(__dirname, '../artifacts')
fs.mkdirSync(artifacts, { recursive: true })
const original = fs.mkdtempSync(path.join(artifacts, 'cache-startup-'))
const target = path.join(original, 'configured cache')
process.env.RPA_AGENT_TEST_DATA = original
const deadline = setTimeout(() => { console.error('Cache startup test timed out'); app.exit(1) }, 25000)

app.whenReady().then(() => {
  const codec = {
    encrypt: value => safeStorage.encryptString(value).toString('base64'),
    decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64'))
  }
  const settings = { connections: [], cacheDirectory: target }
  fs.writeFileSync(path.join(original, 'settings.enc'), codec.encrypt(JSON.stringify(settings)))
  const store = new SessionStore(path.join(original, 'sessions'), codec)
  const scope = { platformId: 'test-user', appCode: 'app', flowCode: 'flow' }
  const session = store.create(scope, { flowCode: 'flow', steps: [] })
  const artifactId = randomUUID()
  session.artifacts[artifactId] = store.writeArtifact(session.id, artifactId, { content: 'saved attachment' })
  store.save(session)
  const evidence = new ExecutionEvidence(path.join(original, 'execution-evidence'), codec, store)
  evidence.record(scope, { artifactId, at: new Date().toISOString(), result: { executionCode: 'saved-run' } },
    { executionCode: 'saved-run', status: 'SUCCEEDED', snapshots: [{ ctx: { value: 'saved evidence' } }] }, session.dsl)
  const analysis = new SessionStore(path.join(original, 'task-analysis'), codec).create(scope, { steps: [] })
  app.on('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', () => {
    if (!win.webContents.getURL().endsWith('/index.html')) return
    try {
      const saved = JSON.parse(codec.decrypt(fs.readFileSync(path.join(original, 'settings.enc'), 'utf8')))
      assert.equal(saved.cacheActiveDirectory, fs.realpathSync(target))
      const restored = new SessionStore(path.join(target, 'sessions'), codec)
      assert.equal(restored.read(session.id, scope).id, session.id)
      assert.equal(restored.readArtifact(session.id, artifactId).content, 'saved attachment')
      const archived = new ExecutionEvidence(path.join(target, 'execution-evidence'), codec, restored)
      assert.equal(archived.get(scope, artifactId).result.snapshots[0].ctx.value, 'saved evidence')
      assert.equal(new SessionStore(path.join(target, 'task-analysis'), codec).read(analysis.id, scope).id, analysis.id)
      assert.ok(fs.existsSync(path.join(original, 'sessions', session.id + '.session')))
      console.log('Cache startup passed: configured directory, evidence, attachments, analysis and original copies.')
      clearTimeout(deadline); app.exit(0)
    } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1) }
  }))
  require('../src/main')
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1) })
