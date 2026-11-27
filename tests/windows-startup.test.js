'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { disableTsfIme, createStartupRecorder, configureCrashReporter } = require('../src/services/windows-startup')

test('Windows startup disables only TSF IME support and preserves existing feature switches', () => {
  const calls = []
  const commandLine = {
    getSwitchValue: name => {
      assert.equal(name, 'disable-features')
      return 'ExistingFeature, TSFImeSupport'
    },
    appendSwitch: (...args) => calls.push(args)
  }
  assert.equal(disableTsfIme(commandLine, 'win32'), true)
  assert.deepEqual(calls, [['disable-features', 'ExistingFeature,TSFImeSupport']])
  assert.equal(disableTsfIme(commandLine, 'linux'), false)
})

test('startup recorder writes bounded one-line diagnostics and never blocks startup', () => {
  const writes = []
  const record = createStartupRecorder('C:\\rpa-agent-data', {
    mkdirSync: (...args) => writes.push(['mkdir', ...args]),
    appendFileSync: (...args) => writes.push(['append', ...args]),
    now: () => new Date('2026-11-22T13:00:00.000Z')
  })
  record('renderer\nfailed\t' + 'x'.repeat(3000))
  assert.equal(writes[0][0], 'mkdir')
  assert.equal(writes[1][0], 'append')
  assert.equal(writes[1][1], path.join('C:\\rpa-agent-data', 'startup.log'))
  assert.match(writes[1][2], /^2026-11-22T13:00:00.000Z renderer failed x+\n$/)
  assert.ok(writes[1][2].length < 2100)
  const tolerant = createStartupRecorder('C:\\blocked', {
    mkdirSync: () => { throw new Error('denied') },
    appendFileSync: () => assert.fail('write after failed mkdir')
  })
  assert.doesNotThrow(() => tolerant('test'))
})

test('crash reporter stores local dumps on Windows and degrades without blocking startup', () => {
  const calls = []
  const app = { setPath: (...args) => calls.push(['path', ...args]) }
  const crashReporter = { start: options => calls.push(['crash', options]) }
  const directory = configureCrashReporter({
    app, crashReporter, userDataDirectory: path.join(process.cwd(), 'artifacts', 'startup-test'),
    recordStartup: () => assert.fail('valid setup should not warn'), platform: 'win32'
  })
  assert.equal(directory, path.join(process.cwd(), 'artifacts', 'startup-test', 'crash-dumps'))
  assert.deepEqual(calls[0], ['path', 'crashDumps', directory])
  assert.equal(calls[1][0], 'crash')
  assert.equal(calls[1][1].uploadToServer, false)
  const warnings = []
  assert.equal(configureCrashReporter({
    app: { setPath: () => { throw new Error('denied') } }, crashReporter,
    userDataDirectory: 'C:\\blocked', recordStartup: message => warnings.push(message), platform: 'win32'
  }), '')
  assert.match(warnings[0], /crash reporter disabled/)
})
