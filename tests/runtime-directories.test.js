'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('Windows launcher isolates Codex sandbox data and cache to the writable temp directory', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'windows-launcher', 'Launch.ps1'), 'utf8')
  assert.match(script, /WindowsIdentity.*GetCurrent/)
  assert.match(script, /CodexSandbox/)
  assert.match(script, /RPA_AGENT_DATA_DIR/)
  assert.match(script, /RPA_AGENT_CACHE_DIR/)
  assert.match(script, /rpa-agent-sandbox-data/)
})

test('main process accepts data and cache environment overrides before directory migration', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
  assert.match(main, /RPA_AGENT_DATA_DIR/)
  const readyBody = main.slice(main.indexOf('app.whenReady().then'))
  assert.match(readyBody, /RPA_AGENT_CACHE_DIR/)
  assert.ok(readyBody.indexOf('RPA_AGENT_CACHE_DIR') < readyBody.indexOf('initializeCacheDirectory'))
})
