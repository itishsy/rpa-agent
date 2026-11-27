'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { businessContext, traceVariable } = require('../src/agent/business-context')
const { diagnosisCard, recordDiagnosis } = require('../src/agent/diagnosis')
const { createTools } = require('../src/agent/tools')
const { prepareContext } = require('../src/agent/context')
const { fallbackConclusion } = require('../src/agent/conclusion')
const { digest } = require('../src/agent/store')
function fixture() {
  const session = { id: 'session', taskCode: 'task', revision: 1, scope: { appCode: 'app', flowCode: 'flow' },
    dsl: { flowCode: 'flow', flowName: '公积金汇缴', appArgs: { region: '杭州', declareSystem: '网厅A', businessType: '汇缴', socialNumber: 'unit-old' }, steps: [
      { stepCode: 'init', stepName: '初始化', actionCode: 'variable', actionArgs: { socialNumber: 'unit-new' } },
      { stepCode: 'call', actionCode: 'subFlow', actionArgs: { flowName: '登录', args: '${socialNumber}' }, body: [
        { stepCode: 'check', actionCode: 'match', actionArgs: { condition: '${socialNumber==expected}' } }
      ] },
      { stepCode: 'disabled', status: 0, actionCode: 'variable', actionArgs: { socialNumber: 'unused' } }
    ] }, artifacts: { evidence: {} }, messages: [], plan: [], runs: [], rules: [] }
  return session
}
function result() {
  return { status: 'SUCCEEDED', snapshots: [{ snapshotId: 'final', phase: 'FINAL', dom: { status: 'AVAILABLE', content: '<table/>', url: 'https://test' } }] }
}
test('business context keeps conflicting sources, missing data and inferred names distinct', () => {
  const session = fixture()
  const context = businessContext(session, { taskCode: 'task', accountNumber: 'unit-new', taskArgs: '{"feeMonth":"2026-11"}' })
  assert.equal(context.fields.account.conflict, true)
  assert.deepEqual(context.fields.account.candidates.map(item => item.source), ['task.accountNumber', 'dsl.appArgs.socialNumber'])
  assert.equal(context.fields.period.candidates[0].value, '2026-11')
  assert.ok(context.missing.includes('amount'))
  assert.deepEqual(context.inferred.businessHints, ['汇缴'])
  session.businessProfile = { taskCode: 'other-task', values: { amount: '1000' } }
  assert.equal(businessContext(session).fields.amount.confirmed, undefined)
})
test('variable tracing follows nested expressions and inactive assignments without treating substrings as references', () => {
  const session = fixture()
  session.dsl.steps.push({ stepCode: 'noise', actionArgs: { text: '${socialNumberOther}' } })
  const trace = traceVariable(session.dsl, 'socialNumber')
  assert.equal(trace.total, 5)
  assert.ok(trace.matches.some(item => item.stepCode === 'check'))
  assert.equal(trace.matches.find(item => item.stepCode === 'disabled').enabled, false)
  assert.ok(!trace.matches.some(item => item.stepCode === 'noise'))
  const page = traceVariable(session.dsl, 'socialNumber', 0, 2)
  assert.equal(page.nextOffset, 2)
})
test('context tool selects only the requested task and child tracing uses existing scope enforcement', async () => {
  const session = fixture()
  const tools = createTools({ tasks: async () => [{ taskCode: 'other', accountNumber: 'wrong' }, { taskCode: 'task', accountNumber: 'right' }],
    inspectSubflow: async () => { throw new Error('不属于实际调用范围') } })
  const context = await tools.get('get_business_context').run({}, { session })
  assert.equal(context.fields.account.candidates[0].value, 'right')
  await assert.rejects(tools.get('trace_flow_variable').run({ name: 'x', flowCode: 'outside', offset: 0 }, { session }), /实际调用范围/)
})
test('diagnosis retains actionable suggestions, rejects missing evidence and invalidates old account/version records', () => {
  const session = fixture()
  session.runs = [0, 1].map(() => ({ taskCode: 'task', revision: 1, artifactId: 'evidence', rootDslFingerprint: digest(session.dsl), result: { status: 'FAILED', error: '单位编号不匹配' } }))
  const card = diagnosisCard(session)
  assert.equal(card.category, 'subject'); assert.equal(card.current, true); assert.equal(card.needsNewEvidence, true)
  assert.match(card.next, /socialNumber/)
  const value = { summary: '初始化覆盖了任务参数，待运行值核验', evidenceIds: ['evidence'], changes: [{ flowCode: 'flow', stepCode: 'init', field: 'actionArgs.socialNumber', before: 'unit-new', after: '待核验任务值', reason: '核对来源' }], missingEvidence: ['运行变量'], nextVerification: '核对页面主体' }
  assert.throws(() => recordDiagnosis(session, { ...value, evidenceIds: ['missing'] }), /不存在/)
  recordDiagnosis(session, value)
  assert.match(fallbackConclusion(session, '预算'), /actionArgs.socialNumber/)
  assert.ok(prepareContext(session).some(message => message.content.includes('初始化覆盖')))
  session.taskCode = 'other'
  assert.equal(diagnosisCard(session).recorded, null); assert.equal(diagnosisCard(session).current, false)
})
test('private verification preserves long account identifiers while model-facing context stays redacted', () => {
  const session = fixture(), task = { accountNumber: '123456789012345678' }
  assert.equal(businessContext(session, task).fields.account.candidates[0].value, '[ID]')
  assert.equal(businessContext(session, task, { redactResult:false }).fields.account.candidates[0].value, task.accountNumber)
})
test('building a dependency bundle cannot contaminate the root configuration fingerprint', async () => {
  const dsl = { appCode:'app', appName:'app', flowCode:'flow', flowName:'查询', steps:[{stepCode:'s',stepName:'查询',actionCode:'read'}] }
  const session = { ...fixture(), dsl }
  const tools = createTools({ tasks:async()=>[{taskCode:'task'}], commands:async()=>({items:[{actionCode:'read',actionArgsVOS:[],targetArgsVOS:[]}],oldSteps:[]}),
    bundle:async(_, root)=>{root.subflows=[{flowCode:'child'}];return root} })
  const prepared = await tools.get('run_current_dsl').prepareExecution({}, {session})
  assert.equal(prepared.dsl.subflows, undefined)
  assert.equal(prepared.bundle.subflows.length, 1)
  assert.equal(prepared.rootDslFingerprint, digest(dsl))
  assert.notEqual(prepared.rootDslFingerprint, prepared.bundleFingerprint)
})
