'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { registerDevelopmentHandlers } = require('../src/ipc/development-handlers')

function fixture() {
  const handlers = new Map(), dispatched = []
  const session = { id: 'session', taskCode: 'task', attachments: [], artifacts: {} }
  const settings = { agentEngine: { engine: 'codex-cli' } }
  registerDevelopmentHandlers({ handle: (name, work) => handlers.set(name, work), takeovers: new Set(), productionRuns: new Set(),
    getState: () => ({ settings, businessWriting: false }), requireSession: () => session,
    readAccounts: async () => [{ taskCode: 'task' }], runSavedFlow: () => assert.fail('unexpected saved flow run'),
    harness: { active: new Map(), start: async (...args) => { dispatched.push({ engine: 'model-api', args }); return 'direct' } },
    startCodex: async (...args) => { dispatched.push({ engine: 'codex-cli', args }); return 'codex' } })
  return { start: handlers.get('agent:start'), session, dispatched }
}

test('IPC routes Codex debugging with a bound account without requiring API settings', async () => {
  const f = fixture()
  assert.equal(await f.start('session', { mode: 'develop', request: '运行并修复', taskCode: 'task' }), 'codex')
  assert.equal(f.dispatched[0].engine, 'codex-cli')
  assert.equal(f.dispatched[0].args[2].mode, 'develop')
  assert.equal(f.dispatched[0].args[2].executionConsent, true)
  await assert.rejects(f.start('session', { mode: 'develop', request: '修复', taskCode: 'other' }), /账户已变化/)
  await assert.rejects(f.start('session', { mode: 'develop', request: '修复', engine: 'model-api' }), /配置模型 API/)
})

test('IPC keeps DSL-only execution direct and lets Codex configuration run without an account', async () => {
  const f = fixture()
  assert.equal(await f.start('session', { mode: 'dslRun', request: '仅运行' }), 'direct')
  assert.equal(f.dispatched[0].args[2].directTool.name, 'run_current_dsl')
  f.session.taskCode = ''
  assert.equal(await f.start('session', { mode: 'generate', request: '修改步骤名称' }), 'codex')
  assert.equal(f.dispatched[1].args[2].mode, 'generate')
})
