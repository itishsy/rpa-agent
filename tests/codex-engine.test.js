'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { Harness } = require('../src/agent/harness')
const { SessionStore } = require('../src/agent-core/store')
const { createTools } = require('../src/agent/tools')
const { createCodexEngine } = require('../src/services/codex/engine')
const { executeCodex } = require('../src/services/codex/process')
const { createEventReader } = require('../src/services/codex/events')
const { engineSettings } = require('../src/services/codex/settings')

function fixture(t, scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-engine-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new SessionStore(path.join(root, 'sessions'), { encrypt: text => text, decrypt: text => text })
  const session = store.create({ executor: 'http://localhost:9090', appCode: 'app', flowCode: 'flow' },
    { appCode: 'app', flowCode: 'flow', steps: [{ stepCode: 's', stepName: '原步骤', actionCode: 'page' }] })
  session.taskCode = 'task'
  let executions = 0, cancellations = 0
  const runner = new Harness({ store, complete: () => assert.fail('Codex must not call the API model loop'),
    ...(scenario.includes('tool-budget') ? { budgets: { toolCalls: 4 } } : {}),
    cancelExecution: async () => { cancellations++ },
    registry: createTools({ tasks: async () => [{ taskCode: 'task' }], bundle: async (_, dsl) => dsl,
      commands: async () => ({ oldSteps: [], items: [{ actionCode: 'page', actionName: '页面', actionArgsVOS: [], targetArgsVOS: [] }] }),
      execute: async (_, body) => {
        executions++
        if (scenario === 'recording') assert.equal(body.capture.recording.enabled, true)
        if (scenario === 'stop-during-tool') await new Promise(resolve => setTimeout(resolve, 300))
        return { status: 'FAILED', executionCode: 'fixture-run', error: '元素未找到',
          snapshots: [{ ctx: { value: 'observed' }, screenshots: { items: [{ contentType: 'image/png', base64: fs.readFileSync(path.join(__dirname, '../src/assets/app.png')).toString('base64') }] } }] }
      }
    }) })
  const engine = createCodexEngine({ runner, getSettings: () => ({ codex: { timeoutSeconds: 30, homeDirectory: path.join(root, 'codex-home') } }), getCacheDirectory: () => root,
    ...(scenario === 'tool-budget-hang' ? { budgetClosingMs: 50 } : {}),
    resolveExecutable: () => process.execPath,
    execute: options => executeCodex({ ...options, spawnProcess: (_executable, args, spawnOptions) => spawn(process.execPath,
      [path.join(__dirname, 'fixtures/codex-cli.js'), ...args], { ...spawnOptions, env: { ...spawnOptions.env, RPA_CODEX_FIXTURE_CASE: scenario } }) }) })
  return { runner, session, engine, counts: () => ({ executions, cancellations }), root }
}

test('JSONL reader handles split UTF-8, CRLF, unknown events and rejects malformed output', () => {
  const events = [], reader = createEventReader(event => events.push(event))
  const bytes = Buffer.from('{"type":"new.event","text":"中文"}\r\n{"type":"turn.completed"}')
  for (const byte of bytes) reader.write(Buffer.from([byte]))
  reader.end()
  assert.equal(events[0].text, '中文'); assert.equal(events[1].type, 'turn.completed')
  assert.throws(() => createEventReader(() => {}).write(Buffer.from('invalid\n')), /无效/)
  assert.throws(() => engineSettings({ engine: 'other' }), /未知/)
  assert.throws(() => engineSettings({ codex: { timeoutSeconds: 0 } }), /超时/)
})

test('one Codex task shares a turn, runs and reads screenshots through MCP, and stages an unapplied patch', async t => {
  const f = fixture(t, 'develop')
  const result = await f.engine.start(f.session, '运行并生成候选修复', { mode: 'develop', executionConsent: true })
  assert.equal(f.session.state, 'completed')
  assert.equal(f.session.dsl.steps[0].stepName, '原步骤')
  assert.equal(f.session.proposal.dsl.steps[0].stepName, '候选修复步骤')
  assert.equal(f.session.turn.executions, 1)
  assert.equal(f.session.turn.calls.length, 4)
  assert.ok(f.session.events.every(event => event.turnId === f.session.turn.id))
  assert.equal(f.session.runs[0].turnId, f.session.turn.id)
  assert.equal(result.report.executionStatus, 'FAILED')
  assert.equal(f.session.turn.codexThreadId, 'fixture-thread')
  assert.deepEqual(f.counts(), { executions: 1, cancellations: 0 })
  assert.equal(f.runner.active.size, 0); assert.equal(f.runner.leases.owners.size, 0)
  const files = fs.readdirSync(path.join(f.root, 'codex-runs', f.session.id, f.session.turn.id))
  assert.deepEqual(files, ['report-schema.json'])
})

test('Codex generation exposes read/edit tools and produces a candidate without execution', async t => {
  const f = fixture(t, 'generate')
  await f.engine.start(f.session, '修改步骤名称', { mode: 'generate', executionConsent: true })
  assert.equal(f.counts().executions, 0)
  assert.equal(f.session.turn.codexReport.executionStatus, 'NOT_RUN')
  assert.equal(f.session.dsl.steps[0].stepName, '原步骤')
  assert.ok(f.session.proposal)
})

test('Codex authentication failures show a login instruction and never start the executor', async t => {
  const f = fixture(t, 'auth-required')
  await assert.rejects(f.engine.start(f.session, '调试当前流程', { mode: 'develop', executionConsent: true }),
    error => error.code === 'CODEX_AUTH' && /登录认证失败.*同一 Codex 程序重新登录/.test(error.message))
  assert.equal(f.counts().executions, 0)
  assert.equal(f.session.state, 'failed')
  assert.match(f.session.turn.codexAuthError, /401/)
  assert.equal(f.runner.active.size, 0)
  assert.equal(f.runner.leases.owners.size, 0)
})

test('Codex execution inherits the user recording request when its MCP call omits recording', async t => {
  const f = fixture(t, 'recording')
  await f.engine.start(f.session, '启动录屏运行并分析证据', { mode: 'develop', executionConsent: true })
  assert.equal(f.counts().executions, 1)
  assert.equal(f.session.turn.recording.enabled, true)
  assert.equal(f.session.runs[0].result.recording.status, 'UNAVAILABLE')
})

for (const scenario of ['tool-budget', 'tool-budget-no-report', 'tool-budget-hang', 'generate-tool-budget']) {
  test('Codex tool limit retains a final conclusion and evidence: ' + scenario, async t => {
    const f = fixture(t, scenario)
    const result = await f.engine.start(f.session, '分析失败并提出修改建议', {
      mode: scenario === 'generate-tool-budget' ? 'generate' : 'develop', executionConsent: true
    })
    assert.equal(f.session.state, 'budget_exhausted')
    assert.equal(f.session.turn.tools, 4)
    assert.equal(f.session.turn.calls.length, 4)
    assert.equal(f.session.turn.toolBudgetExhausted, true)
    assert.equal(f.session.messages.at(-1).content, result.content)
    assert.ok(f.session.events.some(event => event.type === 'message/assistant' && event.data.finalization))
    assert.equal(f.session.events.at(-1).type, 'turn/budget_exhausted')
    assert.ok(!f.session.events.some(event => event.type === 'turn/interrupt_requested'))
    assert.match(result.content, /候选|补充/)
    assert.equal(f.runner.active.size, 0)
    assert.equal(f.runner.leases.owners.size, 0)
    assert.equal(f.counts().cancellations, 0)
    if (scenario === 'generate-tool-budget') {
      assert.equal(result.report.candidateId, null)
      assert.match(result.content, /尚未生成候选步骤/)
      assert.equal(f.counts().executions, 0)
    } else {
      assert.equal(f.counts().executions, 1)
      assert.ok(f.session.proposal)
      assert.equal(f.session.runs[0].evidenceState, 'persisted')
    }
    await f.runner.stop(f.session)
  })
}

for (const scenario of ['bad-report', 'repeat-execution', 'invalid-jsonl', 'exit-without-terminal']) {
  test('Codex failure settles and preserves evidence: ' + scenario, async t => {
    const f = fixture(t, scenario)
    await assert.rejects(f.engine.start(f.session, '运行并修复', { mode: 'develop', executionConsent: true }))
    assert.ok(['failed', 'budget_exhausted'].includes(f.session.state))
    assert.ok(f.counts().executions <= 1)
    assert.equal(f.runner.active.size, 0); assert.equal(f.runner.leases.owners.size, 0)
  })
}

test('stopping a waiting Codex child settles the run and does not cancel an idle executor', async t => {
  const f = fixture(t, 'hang')
  const task = f.engine.start(f.session, '诊断', { mode: 'develop', executionConsent: true })
  const rejected = assert.rejects(task)
  for (let i = 0; i < 100 && !f.session.turn?.codexThreadId; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(f.session.turn.codexThreadId, 'fixture-thread')
  await f.runner.stop(f.session)
  await rejected
  assert.equal(f.session.state, 'cancelled')
  assert.equal(f.counts().cancellations, 0); assert.equal(f.runner.active.size, 0)
})

test('stop waits for a submitted RPA request to settle and retains the received evidence', async t => {
  const f = fixture(t, 'stop-during-tool')
  const task = f.engine.start(f.session, '运行并修复', { mode: 'develop', executionConsent: true })
  const rejected = assert.rejects(task)
  for (let i = 0; i < 200 && !f.session.turn?.calls.some(call => call.phase === 'submitted'); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(f.session.turn.calls.some(call => call.phase === 'submitted'))
  await f.runner.stop(f.session)
  await rejected
  assert.equal(f.session.state, 'cancelled')
  assert.equal(f.counts().cancellations, 1)
  assert.equal(f.session.runs[0].evidenceState, 'persisted')
  assert.equal(f.runner.active.size, 0); assert.equal(f.runner.leases.owners.size, 0)
})

test('Codex timeout releases the process and emits a visible terminal state without an API fallback', async t => {
  const f = fixture(t, 'hang')
  const task = f.engine.start(f.session, '诊断', { mode: 'develop', executionConsent: true })
  const rejected = assert.rejects(task)
  for (let i = 0; i < 100 && !f.session.turn?.codexThreadId; i++) await new Promise(resolve => setTimeout(resolve, 20))
  await f.runner.stop(f.session, 'timeout')
  await rejected
  assert.equal(f.session.state, 'budget_exhausted')
  assert.match(f.session.events.at(-1).data.error, /超时/)
  assert.equal(f.runner.active.size, 0)
})
