'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createTools, validateCandidate, toSaveRows } = require('../src/agent/tools')
const { clone, digest } = require('../src/agent/store')
const commands = { items: [{ actionCode: 'page', actionName: '页面', actionArgsVOS: [
  { fieldKey: 'actionType', fieldName: '操作', fieldType: 'singleDropList' }, { fieldKey: 'actionArgs', fieldName: '参数', fieldType: 'text' }
], targetArgsVOS: [] }], oldSteps: [] }
const dsl = { appCode: 'app', flowCode: 'flow', flowName: '主流程', steps: [
  { stepCode: 's1', stepName: '打开页面', actionCode: 'page', actionArgs: { actionType: 'access', actionArgs: 'https://example.test' } }
] }
const makeSession = () => ({ scope: { appCode: 'app', flowCode: 'flow' }, dsl: clone(dsl), revision: 0, rules: [], runs: [] })
const fakeHarness = { event() {}, artifact() { return 'artifact' } }

test('subflow reading returns real steps and flow-scoped jump diagnostics without deleting a jump',async()=>{
  const child={scope:{flowCode:'login'},revision:0,dsl:{flowCode:'login',flowName:'登录',steps:[
    {stepCode:'check',stepName:'当前申报单位错误?',actionCode:'match',skipTo:'退出浏览器'},
    {stepCode:'exit',stepName:'退出浏览器',actionCode:'browser'}]}}
  const tools=createTools({subflow:async()=>child})
  const context=await tools.get('get_subflow_context').run({flowCode:'login'},{session:makeSession()})
  assert.equal(context.dsl.steps.length,2);assert.deepEqual(context.jumpDiagnostics,[])
  child.dsl.steps.pop()
  const invalid=await tools.get('get_subflow_context').run({flowCode:'login'},{session:makeSession()})
  assert.equal(invalid.dsl.steps[0].skipTo,'退出浏览器')
  assert.equal(invalid.jumpDiagnostics[0].flowCode,'login');assert.match(invalid.validationScope,/步骤名/)
})

test('registry schemas remove execution in generation mode; unknown tools are unavailable', () => {
  const tools = createTools({})
  assert.ok(tools.schemas('develop').some(tool => tool.function.name === 'run_current_dsl'))
  assert.ok(!tools.schemas('generate').some(tool => tool.function.name === 'run_current_dsl'))
  assert.equal(tools.get('save_flow'), undefined)
  assert.equal(tools.get('apply_patch'), undefined)
})

test('referenced child flows can be inspected for advice without granting edit access', async () => {
  const session = makeSession()
  const registry = createTools({ flows: async () => [], subflow: async () => { throw new Error('只能修复当前应用拥有的可编辑子流程') },
    inspectSubflow: async (_, code) => {
      if (code !== 'called-child') throw new Error('目标不属于当前主流程的实际调用范围')
      return { scope: { flowCode: code }, revision: null, readOnly: true, dsl: { steps: [{ stepCode: 'step', actionCode: 'page' }] } }
    } })
  const context = await registry.get('get_subflow_context').run({ flowCode: 'called-child' }, { session })
  assert.equal(context.readOnly, true); assert.equal(context.advisoryOnly, true)
  assert.equal(context.revision, null)
  const steps = await registry.get('get_app_flow_steps').run({ flowCode: 'called-child' }, { session })
  assert.equal(steps.steps[0].stepCode, 'step')
  await assert.rejects(registry.get('get_app_flow_steps').run({ flowCode: 'arbitrary-child' }, { session }), /实际调用范围/)
  await assert.rejects(registry.get('propose_dsl_patch').run({ flowCode: 'called-child', baseRevision: 0, operations: [] }, { session }), /只能修复/)
})
test('tool validation applies defaults and refuses prototype mutation fields', () => {
  const tools = createTools({})
  assert.deepEqual(tools.get('read_artifact').validate({ artifactId: 'a' }), { artifactId: 'a', offset: 0, length: 10000 })
  assert.throws(() => tools.get('propose_dsl_patch').validate({ baseRevision: 0, operations: [{ op: 'set', stepCode: 's1', field: 'actionArgs', key: '__proto__', value: {} }] }), /不安全/)
})

test('tool schemas accept an invocation purpose without passing it to business arguments', () => {
  const tools = createTools({}), tool = tools.get('read_artifact')
  const args = { artifactId: 'evidence', _purpose: '读取下一页现场，确认缺失的减员步骤' }
  assert.equal(tool.schema.parse(args)._purpose, args._purpose)
  assert.deepEqual(tool.validate(args), { artifactId: 'evidence', offset: 0, length: 10000 })
  const exposed = tools.schemas('develop').find(item => item.function.name === 'read_artifact')
  assert.ok(exposed.function.parameters.properties._purpose)
  assert.throws(() => tool.validate({ ...args, _purpose: 'x'.repeat(301) }))
})

test('oversized artifact reads return bounded contiguous pages instead of validation errors or nested artifacts', async () => {
  const { Harness } = require('../src/agent/harness')
  const tools = createTools({}), tool = tools.get('read_artifact')
  const value = { content: '"\\\n\t'.repeat(12000) }, expected = JSON.stringify(value)
  const session = { artifacts: { evidence: value } }
  const harness = new Harness({ store: { save() {} }, registry: tools })
  let offset = 0, collected = ''
  do {
    const args = tool.validate({ artifactId: 'evidence', offset, length: 100000 })
    const page = await tool.run(args, { session, harness })
    assert.ok(page.length > 0 && page.length <= 14000)
    assert.equal(page.requestedLength, 100000)
    assert.equal(page.maxLength, 14000)
    assert.equal(harness.bounded(session, page).artifactId, undefined)
    collected += page.content
    assert.equal(page.nextOffset, collected.length < expected.length ? collected.length : null)
    offset = page.nextOffset
  } while (offset !== null)
  assert.equal(collected, expected)
  for (const length of [0, -1, 1.5, '20000', Infinity]) assert.throws(() => tool.validate({ artifactId: 'evidence', length }))
})

test('DOM pagination caps oversized reads and reports the actual continuation offset', async () => {
  const tools = createTools({}), tool = tools.get('inspect_page_dom')
  const content = 'x'.repeat(30000)
  const session = { runs: [{ artifactId: 'evidence' }] }
  const harness = { readArtifact: () => ({ DOMs: [{ pages: [{ status: 'AVAILABLE', content }] }] }) }
  const args = tool.validate({ snapshotIndex: 0, length: 50000 })
  const page = await tool.run(args, { session, harness })
  assert.equal(page.content.length, 14000)
  assert.equal(page.nextOffset, 14000)
  assert.equal(page.maxLength, 14000)
})
test('proposals validate revision, command fields and scope without applying', async () => {
  const session = makeSession()
  const tools = createTools({ commands: async () => commands })
  const patch = { baseRevision: 0, operations: [{ op: 'set', stepCode: 's1', field: 'stepName', value: '打开工作台' }] }
  await tools.get('propose_dsl_patch').run(patch, { session, harness: fakeHarness })
  assert.equal(session.dsl.steps[0].stepName, '打开页面')
  assert.equal(session.proposal.dsl.steps[0].stepName, '打开工作台')
  await assert.rejects(tools.get('propose_dsl_patch').run({ ...patch, baseRevision: 3 }, { session, harness: fakeHarness }), /版本已变化/)
  await assert.rejects(tools.get('propose_dsl_patch').run({ baseRevision: 0, operations: [
    { op: 'set', stepCode: 's1', field: 'falseSkipTo', value: 'NEXT' }
  ] }, { session, harness: fakeHarness }), /不允许修改字段/)
  assert.throws(() => validateCandidate(session, { ...dsl, appCode: 'foreign' }, commands), /跨应用/)
  assert.throws(() => validateCandidate(session, { ...dsl, steps: [{ ...dsl.steps[0], actionArgs: { url: 'guessed' } }] }, commands), /未知指令参数/)
})

test('one proposal inserts an ordered batch and a complete nested group with generated unique ids', async () => {
  const session = makeSession()
  const definitions = { ...commands, items: [...commands.items,
    { actionCode: 'codeBlock', actionName: '代码块', actionArgsVOS: [], targetArgsVOS: [] }] }
  const tool = createTools({ commands: async () => definitions }).get('propose_dsl_patch')
  const proposal = await tool.run(tool.validate({ baseRevision: 0, operations: [
    { op: 'insert', index: 0, steps: [
      { stepName: '确认失败弹框', actionCode: 'page', children: [
        { stepName: '关闭失败弹框', actionCode: 'page' },
        { stepName: '记录失败信息', actionCode: 'page' }
      ] },
      { stepName: '循环单个封存', actionCode: 'codeBlock', body: [
        { stepCode: 'enter', stepName: '录入单个', actionCode: 'page', skipTo: '保存单个' },
        { stepName: '保存单个', actionCode: 'page' }
      ] }
    ] },
    { op: 'insert', parentStepCode: 's1', steps: [
      { stepName: '附加步骤一', actionCode: 'page' }, { stepName: '附加步骤二', actionCode: 'page' }
    ] }
  ] }), { session, harness: fakeHarness })
  assert.deepEqual(proposal.dsl.steps.map(step => step.stepName), ['确认失败弹框', '循环单个封存', '打开页面'])
  assert.deepEqual(proposal.dsl.steps[0].children.map(step => step.stepName), ['关闭失败弹框', '记录失败信息'])
  assert.deepEqual(proposal.dsl.steps[1].body.map(step => step.stepName), ['录入单个', '保存单个'])
  assert.deepEqual(proposal.dsl.steps[2].children.map(step => step.stepName), ['附加步骤一', '附加步骤二'])
  assert.equal(proposal.dsl.steps[1].body[0].skipTo, '保存单个')
  assert.equal(proposal.changedStepCodes.length, 8)
  assert.equal(new Set(proposal.changedStepCodes).size, 8)
  assert.ok(proposal.changedStepCodes.every(code => typeof code === 'string' && code.length))
  assert.equal(toSaveRows({ ...session, dsl: proposal.dsl }, definitions).length, 9)
  assert.deepEqual(session.dsl, dsl)
})

test('a single insert with multiple child steps also writes the full generation draft', async () => {
  const session = makeSession()
  session.turn = {}
  const tool = createTools({ commands: async () => commands }).get('propose_dsl_patch')
  const result = await tool.run(tool.validate({ baseRevision: 0, operations: [{
    op: 'insert', step: { stepName: '失败处理', actionCode: 'page', children: [
      { stepName: '确认', actionCode: 'page' }, { stepName: '返回', actionCode: 'page' }
    ] }
  }] }), { session, harness: fakeHarness, turn: { mode: 'generate', writeToEditor: true } })
  assert.equal(result.generated, true)
  assert.equal(result.changedStepCodes.length, 3)
  assert.equal(session.dsl.steps[1].children.length, 2)
  assert.equal(session.revision, 1)
  assert.equal(session.proposal, null)
})

test('invalid inserted batches leave the editor and existing candidate intact', async () => {
  const session = makeSession()
  session.proposal = { id: 'existing', dsl: clone(dsl) }
  const before = clone(session)
  const tool = createTools({ commands: async () => commands }).get('propose_dsl_patch')
  const step = { stepCode: 'added', stepName: '新增', actionCode: 'page' }
  for (const operation of [
    { op: 'insert', steps: [step, step] },
    { op: 'insert', step, steps: [step] },
    { op: 'insert', steps: [{ ...step, children: [{ ...step, stepCode: 's1' }] }] },
    { op: 'insert', steps: [{ ...step, children: [{ ...step, stepCode: 'child', unknownField: true }] }] },
    { op: 'insert', steps: [{ ...step, body: [{ ...step, stepCode: 'body' }] }] }
  ]) {
    await assert.rejects(tool.run(tool.validate({ baseRevision: 0, operations: [operation] }), { session, harness: fakeHarness }))
    assert.deepEqual(session, before)
  }
})
test('subflow proposals bind both revisions without mutating the root or child editor', async () => {
  const root = makeSession(), child = makeSession()
  child.id = 'child-session'; child.scope.flowCode = 'child'; child.dsl.flowCode = 'child'; child.revision = 3
  const tools = createTools({ commands: async () => commands, subflow: async (_session, code) => { assert.equal(code, 'child'); return child } })
  await tools.get('propose_dsl_patch').run({ flowCode: 'child', baseRevision: 3, operations: [{ op: 'set', stepCode: 's1', field: 'stepName', value: '修复子流程' }] }, { session: root, harness: fakeHarness })
  assert.equal(root.dsl.steps[0].stepName, '打开页面'); assert.equal(child.dsl.steps[0].stepName, '打开页面')
  assert.equal(root.proposal.targetSessionId, 'child-session'); assert.equal(root.proposal.targetBaseRevision, 3)
  assert.equal(root.proposal.baseRevision, 0); assert.equal(root.proposal.dsl.flowCode, 'child')
  await assert.rejects(tools.get('propose_dsl_patch').run({ flowCode: 'child', baseRevision: 3, operations: [{ op: 'remove', stepCode: 's1' }] }, { session: root, harness: fakeHarness, turn: { mode: 'generate' } }), /只能修改当前新增/)
})
test('save serializes native arguments and retains step order without Vue field widgets', () => {
  const session = makeSession()
  session.dsl.steps[0].failedRetry = 0; session.dsl.steps[0].status = 0
  const rows = toSaveRows(session, commands)
  assert.deepEqual(JSON.parse(rows[0].actionArgs), dsl.steps[0].actionArgs)
  assert.equal(rows[0].number, 0); assert.equal(rows[0].status, 0); assert.equal(rows[0].failedRetry, 0)
  assert.deepEqual(rows[0].actionArgsVOS, [])
})
test('repaired native identities save each original row and never send repair metadata to the platform', () => {
  const { nestDebugSteps, buildDebugDsl } = require('../src/services/debug-dsl')
  const rows = nestDebugSteps([
    { id: 10, stepCode: 'duplicate', stepName: '打开登录', actionCode: 'page', actionArgs: '{"actionType":"access","actionArgs":"https://example.test/login"}' },
    { id: 11, stepCode: 'duplicate', stepName: '打开查询', actionCode: 'page', actionArgs: '{"actionType":"access","actionArgs":"https://example.test/query"}' }
  ])
  const session = makeSession()
  session.dsl = buildDebugDsl('app', 'flow', dsl, rows)
  const saved = toSaveRows(session, { ...commands, oldSteps: rows })
  assert.deepEqual(saved.map(row => row.id), [10, 11])
  assert.equal(new Set(saved.map(row => row.stepCode)).size, 2)
  assert.equal(saved.some(row => Object.hasOwn(row, 'sourceStepCode')), false)
  assert.equal(JSON.parse(saved[1].actionArgs).actionArgs, 'https://example.test/query')
  assert.deepEqual(buildDebugDsl('app', 'flow', dsl, nestDebugSteps(saved)), session.dsl)
})
test('saved steps keep native IDs when leaving or entering a code block and update group ownership', () => {
  const session = makeSession()
  const [page] = session.dsl.steps
  const block = {stepCode:'block',stepName:'代码块',actionCode:'codeBlock'}
  const old = {...page,id:7,groupCode:'block'}
  const definitions = {...commands, items:[...commands.items,{actionCode:'codeBlock',actionArgsVOS:[],targetArgsVOS:[]}],
    oldSteps:[{...block,list:[old]}]}
  const remaining = {...page,stepCode:'remaining',stepName:'保留步骤'}
  session.dsl.steps = [block, page]
  block.body = [remaining]
  let saved = toSaveRows(session, definitions)
  assert.deepEqual(saved.map(row=>[row.stepCode,row.level,row.groupCode]),[['block',0,undefined],['remaining',1,'block'],[page.stepCode,0,null]])
  assert.equal(saved.at(-1).id,7)
  block.body.push(page);session.dsl.steps.pop()
  saved = toSaveRows(session, definitions)
  assert.deepEqual([saved.at(-1).id,saved.at(-1).level,saved.at(-1).groupCode],[7,1,'block'])
})
test('execute rejects foreign accounts and stale candidates before calling executor', async () => {
  let count = 0
  const tools = createTools({ tasks: async () => [{ taskCode: 'owned' }], execute: async () => { count++ } })
  const session = makeSession()
  await assert.rejects(tools.get('run_current_dsl').run({ taskCode: 'foreign' }, { session, harness: fakeHarness }), /有效调试账户/)
  session.proposal = { baseRevision: 0, baseline: 'stale', dsl }
  await assert.rejects(tools.get('run_proposed_dsl').run({ taskCode: 'owned' }, { session, harness: fakeHarness }), /已过期/)
  assert.equal(count, 0)
})
test('continuation requires resumable failure and the original account', async () => {
  const session = makeSession(); const tools = createTools({})
  await assert.rejects(tools.get('continue_failed_run').run({}, { session }), /无可续跑/)
  session.runs = [{ taskCode: 'original', result: { status: 'FAILED', resumable: true, executionCode: 'e1' } }]; session.taskCode = 'other'
  await assert.rejects(tools.get('continue_failed_run').run({}, { session }), /账户与原执行不一致/)
})
test('fingerprints ignore key insertion order but bind the full executable configuration', () => {
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }))
  assert.notEqual(digest(dsl), digest({ ...dsl, sessionKeep: 1 }))
})
