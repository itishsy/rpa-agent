'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { initializeCacheDirectory, prepareDirectory, normalizeDirectory } = require('../src/services/cache-directory')

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-cache-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const original = path.join(root, 'original'), target = path.join(root, 'cache with spaces')
  await fs.mkdir(path.join(original, 'sessions', 'session-artifacts'), { recursive: true })
  await fs.mkdir(path.join(original, 'execution-evidence', 'flow'), { recursive: true })
  await fs.mkdir(path.join(original, 'task-analysis'), { recursive: true })
  await fs.writeFile(path.join(original, 'sessions', 'session-artifacts', 'file.enc'), 'encrypted attachment')
  await fs.writeFile(path.join(original, 'execution-evidence', 'flow', 'index.enc'), 'encrypted index')
  await fs.writeFile(path.join(original, 'task-analysis', 'analysis.session'), 'encrypted analysis')
  await fs.writeFile(path.join(original, 'settings.enc'), 'credentials stay at original configuration path')
  return { root, original, target }
}

test('startup migrates all cache stores, preserves original copies and persists the active location', async t => {
  const { original, target } = await fixture(t)
  const settings = { cacheDirectory: target }
  let saved
  const result = await initializeCacheDirectory(settings, original, () => { saved = { ...settings } })
  assert.equal(result.warning, '')
  assert.equal(result.directory, await fs.realpath(target))
  assert.equal(saved.cacheActiveDirectory, result.directory)
  for (const file of ['sessions/session-artifacts/file.enc', 'execution-evidence/flow/index.enc', 'task-analysis/analysis.session']) {
    assert.equal(await fs.readFile(path.join(target, file), 'utf8'), await fs.readFile(path.join(original, file), 'utf8'))
  }
  await assert.rejects(fs.access(path.join(target, 'settings.enc')), { code: 'ENOENT' })
  await fs.writeFile(path.join(target, 'task-analysis', 'analysis.session'), 'new analysis')
  const reopened = await initializeCacheDirectory(settings, original, () => assert.fail('unchanged directory must not migrate'))
  assert.equal(reopened.directory, result.directory)
  assert.equal(await fs.readFile(path.join(target, 'task-analysis', 'analysis.session'), 'utf8'), 'new analysis')
  settings.cacheDirectory = ''
  const restored = await initializeCacheDirectory(settings, original, () => {})
  assert.equal(restored.directory, await fs.realpath(original))
  assert.equal(await fs.readFile(path.join(original, 'task-analysis', 'analysis.session'), 'utf8'), 'new analysis')
})

test('failed settings commit restores destination folders and continues using original data', async t => {
  const { original, target } = await fixture(t)
  await fs.mkdir(path.join(target, 'sessions'), { recursive: true })
  await fs.writeFile(path.join(target, 'sessions', 'previous.session'), 'destination backup')
  const settings = { cacheDirectory: target }
  const result = await initializeCacheDirectory(settings, original, () => { throw new Error('disk full') })
  assert.equal(result.directory, original)
  assert.match(result.warning, /disk full/)
  assert.equal(settings.cacheActiveDirectory, undefined)
  assert.equal(await fs.readFile(path.join(target, 'sessions', 'previous.session'), 'utf8'), 'destination backup')
  assert.equal(await fs.readFile(path.join(original, 'sessions', 'session-artifacts', 'file.enc'), 'utf8'), 'encrypted attachment')
  const retry = await initializeCacheDirectory(settings, original, () => {})
  assert.equal(retry.warning, '')
  assert.equal(retry.directory, await fs.realpath(target))
})

test('cache selection checks absolute paths, writability and recursive directory overlap', async t => {
  const { original, target, root } = await fixture(t)
  assert.equal(normalizeDirectory('', original), original)
  assert.throws(() => normalizeDirectory('relative/cache', original), /绝对路径/)
  assert.equal(await prepareDirectory(target, original, original), await fs.realpath(target))
  await assert.rejects(prepareDirectory(path.join(original, 'sessions', 'recursive'), original, original), /重叠/)
  const file = path.join(root, 'file')
  await fs.writeFile(file, 'file')
  await assert.rejects(prepareDirectory(file, original, original))
  const result = await initializeCacheDirectory({ cacheDirectory: file }, original, () => assert.fail('failed migration must not commit'))
  assert.equal(result.directory, original)
  assert.match(result.warning, /原目录/)
})
