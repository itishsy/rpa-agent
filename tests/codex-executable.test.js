'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { resolveCodexExecutable } = require('../src/services/codex/executable')

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-agent-codex-'))
}

test('discovers the standard Codex desktop installation without PATH', () => {
  const root = fixture()
  const executable = path.join(root, 'OpenAI', 'Codex', 'bin', 'codex.exe')
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(executable, '')
  assert.equal(resolveCodexExecutable('', { platform: 'win32', env: { LOCALAPPDATA: root, PATH: '' } }), executable)
})

test('falls back to the newest versioned Codex desktop executable', () => {
  const root = fixture()
  const older = path.join(root, 'OpenAI', 'Codex', 'bin', 'old', 'codex.exe')
  const newer = path.join(root, 'OpenAI', 'Codex', 'bin', 'new', 'codex.exe')
  fs.mkdirSync(path.dirname(older), { recursive: true })
  fs.mkdirSync(path.dirname(newer), { recursive: true })
  fs.writeFileSync(older, '')
  fs.writeFileSync(newer, '')
  fs.utimesSync(older, new Date(1), new Date(1))
  fs.utimesSync(newer, new Date(2), new Date(2))
  assert.equal(resolveCodexExecutable('', { platform: 'win32', env: { LOCALAPPDATA: root, PATH: '' } }), newer)
})

test('prefers the newest desktop release over a stale unversioned executable', () => {
  const root = fixture()
  const stale = path.join(root, 'OpenAI', 'Codex', 'bin', 'codex.exe')
  const current = path.join(root, 'OpenAI', 'Codex', 'bin', 'release-id', 'codex.exe')
  fs.mkdirSync(path.dirname(current), { recursive: true })
  fs.writeFileSync(stale, '')
  fs.writeFileSync(current, '')
  assert.equal(resolveCodexExecutable('', { platform: 'win32', env: { LOCALAPPDATA: root, PATH: '' } }), current)
})

test('prefers a separately installed Codex CLI over the desktop fallback', () => {
  const local = fixture()
  const roaming = fixture()
  const desktop = path.join(local, 'OpenAI', 'Codex', 'bin', 'release-id', 'codex.exe')
  const wrapper = path.join(roaming, 'npm', 'codex.cmd')
  const cli = path.join(roaming, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
  fs.mkdirSync(path.dirname(desktop), { recursive: true })
  fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.writeFileSync(desktop, '')
  fs.writeFileSync(wrapper, '')
  fs.writeFileSync(cli, '')
  assert.equal(resolveCodexExecutable('', {
    platform: 'win32', arch: 'x64', env: { LOCALAPPDATA: local, APPDATA: roaming, PATH: '' }
  }), cli)
})

test('keeps an explicitly configured executable authoritative', () => {
  const root = fixture()
  const automatic = path.join(root, 'OpenAI', 'Codex', 'bin', 'codex.exe')
  fs.mkdirSync(path.dirname(automatic), { recursive: true })
  fs.writeFileSync(automatic, '')
  assert.throws(() => resolveCodexExecutable(path.join(root, 'missing.exe'), {
    platform: 'win32', env: { LOCALAPPDATA: root, PATH: '' }
  }), /未找到 Codex CLI/)
})
