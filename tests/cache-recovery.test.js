'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { recoverCacheDirectory } = require('../src/services/cache-recovery')
test('blocked cache is migrated only after user chooses a writable directory; source is retained', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-recovery-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'blocked'), destination = path.join(root, 'selected')
  fs.mkdirSync(path.join(source, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(source, 'sessions', 'old.session'), 'encrypted checkpoint')
  const open = fs.openSync
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (String(file).startsWith(source) && String(file).includes('.rpa-agent-probe-')) throw Object.assign(new Error('blocked'), { code: 'EPERM', syscall: 'open' })
    return open(file, ...args)
  })
  let prompts = 0, saved = 0
  const settings = { cacheDirectory: source, cacheActiveDirectory: source }
  const result = await recoverCacheDirectory({ state: { directory: source, warning: '' }, settings, defaultDirectory: source,
    persist: () => { saved++ }, dialog: {
      showMessageBox: async () => { prompts++; return { response: 0 } },
      showOpenDialog: async () => ({ canceled: false, filePaths: [destination] })
    } })
  assert.equal(result.directory, destination); assert.equal(prompts, 1); assert.equal(saved, 1)
  for (const folder of [source, destination]) assert.equal(fs.readFileSync(path.join(folder, 'sessions', 'old.session'), 'utf8'), 'encrypted checkpoint')
})
