'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Harness, ExecutorLeases } = require('../src/agent/harness')
const { prepareContext } = require('../src/agent/context')
const { clone } = require('../src/agent/store')
function fixture(options = {}) {
  const writes = [], events = []
  const session = { id: 's1', scope: { executor: 'http://executor', appCode: 'app', flowCode: 'flow' }, state: 'idle',
    dsl: { steps: [] }, revision: 0, messages: [], events: [], sequence: 0, artifacts: {}, plan: [], runs: [] }
  const registry = { get: name => ({ read: { name, effect: 'read', validate() {}, run: async () => ({ value: 42 }) },
    run: { name, effect: 'execute', validate() {}, run: options.execute || (async () => ({ status: 'SUCCEEDED' })) }
  })[name], schemas: () => [] }
  const harness = new Harness({ store: { save: value => writes.push(clone(value)) }, registry,
    complete: options.complete || (async () => ({ role: 'assistant', content: 'done' })),
    emit: event => { events.push(event); options.onEvent?.(event) }, ...options })
  return { harness, session, writes, events }
}
const call = (name, id = 'call1') => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] })
const tick = () => new Promise(resolve => setImmediate(resolve))

test('model loop dispatches tools and persists ordered events before completion', async () => {
  let count = 0
  const { harness, session, writes, events } = fixture({ complete: async () => count++ ? { role: 'assistant', content: 'done' } : call('read') })
  assert.equal(await harness.start(session, 'inspect'), 'done')
  assert.equal(session.state, 'completed')
  assert.equal(session.messages.find(item => item.role === 'tool').content, '{"value":42}')
  assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1))
  assert.equal(writes.at(-1).events.at(-1).type, 'turn/completed')
})
test('generation mode rejects a fabricated execution call at dispatch', async () => {
  let count = 0, executed = 0
  const { harness, session } = fixture({ execute: async () => { executed++ }, complete: async () => count++ ? { role: 'assistant', content: 'done' } : call('run') })
  await harness.start(session, 'generate', { mode: 'generate' })
  assert.equal(executed, 0)
  assert.match(session.messages.find(item => item.role === 'tool').content, /生成模式禁止/)
})
test('execution approval cannot be reused after revision changes', async () => {
  let executed = 0
  const f = fixture({ execute: async () => { executed++ } })
  const running = f.harness.start(f.session, 'run', { directTool: { name: 'run', args: {} } })
  await tick()
  const approval = f.events.find(event => event.type === 'approval/requested').data.id
  assert.equal(f.session.state, 'waiting_approval')
  assert.throws(() => f.harness.resolveApproval('other', approval, true), /不属于/)
  f.session.revision++
  f.harness.resolveApproval(f.session.id, approval, true)
  await assert.rejects(running, /授权失效/)
  assert.equal(executed, 0)
})
test('denial prevents execution and consumes the pending approval', async () => {
  const f = fixture()
  const running = f.harness.start(f.session, 'run', { directTool: { name: 'run', args: {} } })
  await tick()
  const approval = f.events.find(event => event.type === 'approval/requested').data.id
  f.harness.resolveApproval(f.session.id, approval, false)
  await assert.rejects(running, /用户拒绝/)
  assert.throws(() => f.harness.resolveApproval(f.session.id, approval, true), /已过期/)
})
test('cancelling a pending approval stops the turn without an executor call', async () => {
  let executed = 0
  const f = fixture({ execute: async () => { executed++ } })
  const running = f.harness.start(f.session, 'run', { directTool: { name: 'run', args: {} } })
  await tick(); await f.harness.stop(f.session)
  await assert.rejects(running, /已停止/)
  assert.equal(f.session.state, 'cancelled'); assert.equal(executed, 0)
})
test('external transport disconnect revokes a waiting execution request', async () => {
  const controller = new AbortController(), f = fixture()
  const running = f.harness.start(f.session, 'MCP run', { signal: controller.signal, directTool: { name: 'run', args: {} } })
  await tick(); controller.abort()
  await assert.rejects(running, /已停止/)
  assert.equal(f.session.state, 'cancelled'); assert.equal(f.harness.approvals.size, 0)
})
test('executor lease remains held after cancellation until the original execution settles', async () => {
  let finish, cancelled = 0
  const leases = new ExecutorLeases()
  const f = fixture({ leases, execute: () => new Promise(resolve => { finish = resolve }), cancelExecution: async () => { cancelled++ } })
  const g = fixture({ leases }); g.session.id = 's2'
  const running = f.harness.start(f.session, 'run', { directTool: { name: 'run', args: {} }, executionConsent: true })
  await tick(); await f.harness.stop(f.session)
  assert.equal(cancelled, 1)
  await assert.rejects(g.harness.start(g.session, 'run', { directTool: { name: 'run', args: {} }, executionConsent: true }), /执行器已有任务/)
  finish({ status: 'CANCELLED' }); await assert.rejects(running, /本轮已停止/)
  assert.equal(leases.owners.size, 0)
})
test('a single session rejects concurrent turns', async () => {
  let finish
  const f = fixture({ complete: () => new Promise(resolve => { finish = resolve }) })
  const running = f.harness.start(f.session, 'first')
  await assert.rejects(f.harness.start(f.session, 'second'), /仍在运行/)
  finish({ role: 'assistant', content: 'done' }); await running
})
test('budget exhaustion saves resumable conversation state', async () => {
  const f = fixture({ budgets: { modelCalls: 2 }, complete: async () => call('read', 'c' + Math.random()) })
  await f.harness.start(f.session, 'inspect')
  assert.equal(f.session.state, 'budget_exhausted')
  assert.equal(f.session.messages.filter(item => item.role === 'tool').length, 1)
  assert.match(f.session.messages.at(-1).content, /修改建议/)
  assert.equal(f.session.turn.modelCalls, 2)
})
test('large observations become bounded paged artifacts', async () => {
  const f = fixture()
  const bounded = f.harness.bounded(f.session, { content: 'x'.repeat(40000), password: 'secret' })
  assert.equal(bounded.truncated, true)
  assert.ok(bounded.preview.length <= 12000)
  assert.equal(f.session.artifacts[bounded.artifactId].password, '[REDACTED]')
})
test('crash recovery closes pending tool calls and never replays effects', () => {
  const f = fixture()
  f.session.state = 'running'; f.session.messages = [{ role: 'user', content: 'run' }, call('run')]
  f.harness.recover(f.session)
  assert.equal(f.session.state, 'interrupted')
  assert.match(f.session.messages.at(-1).content, /不自动重放/)
  assert.equal(f.harness.active.size, 0)
})
test('context compaction preserves complete recent turns and tool pairs', () => {
  const f = fixture()
  for (let index = 0; index < 8; index++) f.session.messages.push({ role: 'user', content: 'x'.repeat(1000) }, call('read', 'c' + index),
    { role: 'tool', tool_call_id: 'c' + index, content: 'result' }, { role: 'assistant', content: 'finished' })
  const original = clone(f.session.messages)
  const messages = prepareContext(f.session, 4000)
  assert.ok(f.session.compaction.retainedFrom > 0)
  assert.deepEqual(f.session.messages, original)
  assert.ok(JSON.stringify(messages).length <= 4000)
  for (const message of messages.filter(item => item.role === 'tool')) assert.ok(messages.some(item => item.tool_calls?.some(call => call.id === message.tool_call_id)))
})
test('a long single turn compacts whole earlier tool batches without orphaning results', () => {
  const f = fixture()
  f.session.messages = [{ role: 'user', content: 'goal' }]
  for (let index = 0; index < 8; index++) f.session.messages.push(call('read', 'c' + index), { role: 'tool', tool_call_id: 'c' + index, content: 'x'.repeat(2000) })
  const projected = prepareContext(f.session, 4000)
  assert.equal(f.session.messages.length, 17)
  assert.ok(projected.some(item => item.role === 'user' && item.content === 'goal'))
  for (const item of projected.filter(item => item.role === 'tool')) assert.ok(projected.some(message => message.tool_calls?.some(call => call.id === item.tool_call_id)))
  assert.ok(JSON.stringify(projected).length <= 4000)
})
