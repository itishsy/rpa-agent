'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { atomicWriteFileSync } = require('../src/services/atomic-file')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-atomic-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'checkpoint.session')
}
test('stale fixed temp files do not prevent checkpoints and are preserved', t => {
  const file = fixture(t)
  fs.writeFileSync(file + '.tmp', 'stale')
  atomicWriteFileSync(file, 'first'); atomicWriteFileSync(file, 'second')
  assert.equal(fs.readFileSync(file, 'utf8'), 'second')
  assert.equal(fs.readFileSync(file + '.tmp', 'utf8'), 'stale')
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['checkpoint.session', 'checkpoint.session.tmp'])
})
test('temporary Windows replacement locks are retried', t => {
  const file = fixture(t), rename = fs.renameSync
  let calls = 0
  t.mock.method(fs, 'renameSync', (...args) => {
    if (++calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' })
    return rename(...args)
  })
  atomicWriteFileSync(file, 'complete')
  assert.equal(calls, 3)
  assert.equal(fs.readFileSync(file, 'utf8'), 'complete')
})
test('permanent permission failure preserves the previous checkpoint and cleans owned temp', t => {
  const file = fixture(t)
  fs.writeFileSync(file, 'previous')
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
  assert.throws(() => atomicWriteFileSync(file, 'new'), error => error.code === 'EACCES' && error.message.includes(file))
  assert.equal(fs.readFileSync(file, 'utf8'), 'previous')
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['checkpoint.session'])
})
