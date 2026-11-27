'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { configuredDataDirectory, prepareDataDirectory, recoverDataDirectory } = require('../src/services/data-directory')
test('blocked settings directory relocates encrypted configuration and persists startup selection without deleting source', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-data-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'), target = path.join(root, 'target'), marker = path.join(root, 'startup.json')
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'settings.enc'), 'encrypted-settings')
  fs.writeFileSync(path.join(source, 'Local State'), '{"os_crypt":{"encrypted_key":"original-key"}}')
  const open = fs.openSync
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (String(file).startsWith(source) && String(file).includes('.rpa-settings-probe-')) throw Object.assign(new Error('blocked'), { code: 'EPERM' })
    return open(file, ...args)
  })
  const result = await recoverDataDirectory({ directory: source, marker, dialog: {
    showMessageBox: async () => ({ response: 0 }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [target] })
  } })
  assert.equal(result.previousDirectory, source)
  assert.equal(configuredDataDirectory(marker, source), target)
  for (const directory of [source, target]) assert.equal(fs.readFileSync(path.join(directory, 'settings.enc'), 'utf8'), 'encrypted-settings')
  assert.equal(fs.readFileSync(path.join(target, 'Local State'), 'utf8'), fs.readFileSync(path.join(source, 'Local State'), 'utf8'))
})

test('startup automatically relocates blocked configuration before Electron initializes its encryption profile', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-data-auto-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'blocked'), target = path.join(root, 'LocalLow', 'data')
  const marker = path.join(root, 'LocalLow', 'startup', 'data-directory.json')
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'settings.enc'), 'encrypted-settings')
  fs.writeFileSync(path.join(source, 'Local State'), 'original-key')
  const open = fs.openSync
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (String(file).startsWith(source) && String(file).includes('.rpa-settings-probe-')) throw Object.assign(new Error('blocked'), { code: 'EPERM' })
    return open(file, ...args)
  })
  const result = prepareDataDirectory({ directory: source, marker, fallbackDirectories: [target] })
  assert.equal(result.directory, target)
  assert.equal(result.previousDirectory, source)
  assert.equal(configuredDataDirectory(marker, source), target)
  assert.equal(fs.readFileSync(path.join(target, 'settings.enc'), 'utf8'), 'encrypted-settings')
  assert.equal(fs.readFileSync(path.join(target, 'Local State'), 'utf8'), 'original-key')
  assert.equal(fs.readFileSync(path.join(source, 'settings.enc'), 'utf8'), 'encrypted-settings')
  assert.deepEqual(prepareDataDirectory({ directory: target, marker, fallbackDirectories: [target] }), { directory: target })
})

test('automatic recovery preserves an occupied destination and falls back to manual recovery', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-data-conflict-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'blocked'), target = path.join(root, 'existing')
  fs.mkdirSync(source); fs.mkdirSync(target)
  fs.writeFileSync(path.join(source, 'settings.enc'), 'original')
  fs.writeFileSync(path.join(target, 'settings.enc'), 'existing')
  const open = fs.openSync
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (String(file).startsWith(source) && String(file).includes('.rpa-settings-probe-')) throw Object.assign(new Error('blocked'), { code: 'EPERM' })
    return open(file, ...args)
  })
  const result = prepareDataDirectory({ directory: source, marker: path.join(root, 'marker.json'), fallbackDirectories: [target] })
  assert.equal(result.directory, source)
  assert.equal(result.error.code, 'EPERM')
  assert.equal(fs.readFileSync(path.join(target, 'settings.enc'), 'utf8'), 'existing')
})

test('per-user startup selection takes precedence over the legacy installation marker', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-data-marker-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const marker = path.join(root, 'user.json'), legacy = path.join(root, 'install.json')
  fs.writeFileSync(legacy, JSON.stringify({ directory: path.join(root, 'legacy') }))
  assert.equal(configuredDataDirectory(marker, root, legacy), path.join(root, 'legacy'))
  fs.writeFileSync(marker, JSON.stringify({ directory: path.join(root, 'current') }))
  assert.equal(configuredDataDirectory(marker, root, legacy), path.join(root, 'current'))
})
