'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { businessContext, traceVariable } = require('../src/agent/business-context')
const { diagnosisCard, recordDiagnosis } = require('../src/agent/diagnosis')
const { assertionSchema } = require('../src/agent/business-verification')
const { ruleSchema, searchRules, makeCase, searchCases } = require('../src/agent/business-knowledge')
const { createTools, verifyBusiness } = require('../src/agent/tools')
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
test('structured assertion schema rejects ambiguous final states and duplicate person keys', () => {
  assert.throws(() => assertionSchema().parse([{ id: 's', type: 'businessState', selector: '#s', acceptedValues: ['审核中'], pendingValues: ['审核中'] }]), /不能重叠/)
  assert.throws(() => assertionSchema().parse([{ id: 's', type: 'recordSet', selector: 'tr', keySelector: '.id', valueSelector: '.state', records: [{ key: 'p', value: '完成' }, { key: 'p', value: '完成' }] }]), /重复/)
  assert.throws(() => assertionSchema().parse([{ id: 's', type: 'businessState', selector: '#s' }]), /办结/)
})
test('official business state distinguishes pending, unknown, failure and complete outcomes', async () => {
  const rules = assertionSchema().parse([{ id: 'state', type: 'businessState', selector: '#s', acceptedValues: ['已入账'], pendingValues: ['银行处理中'], failedValues: ['退回'] }])
  for (const [value, expected] of [['银行处理中', 'PENDING'], ['未知文案', 'UNKNOWN'], ['退回', 'FAILED'], ['已入账', 'VERIFIED']]) {
    assert.equal((await verifyBusiness(rules, result(), async () => [value])).status, expected)
  }
  const page = result(); page.snapshots[0].dom.truncated = true
  assert.equal((await verifyBusiness(rules, page, async () => ['已入账'])).status, 'UNKNOWN')
})
test('person reconciliation handles mixed results, missing rows, duplicates and unexpected people', async () => {
  const rules = assertionSchema().parse([{ id: 'people', type: 'recordSet', selector: 'tr', keySelector: '.id', valueSelector: '.state', pendingValues: ['审核中'],
    records: [{ key: 'p1', value: '完成' }, { key: 'p2', value: '完成' }] }])
  const query = rows => async (_, selector, fields) => fields ? rows : []
  let verified = await verifyBusiness(rules, result(), query([{ key: 'p1', value: '完成' }, { key: 'p2', value: '审核中' }]))
  assert.equal(verified.status, 'PENDING'); assert.equal(verified.details[0].counts.PASSED, 1)
  verified = await verifyBusiness(rules, result(), query([{ key: 'p1', value: '完成' }, { key: 'p2', value: '退回' }]))
  assert.equal(verified.status, 'FAILED'); assert.equal(verified.details[0].items[1].state, 'FAILED')
  assert.equal((await verifyBusiness(rules, result(), query([{ key: 'p1', value: '完成' }]))).status, 'UNKNOWN')
  assert.equal((await verifyBusiness(rules, result(), query([{ key: 'p1', value: '完成' }, { key: 'p1', value: '完成' }, { key: 'p2', value: '完成' }]))).status, 'UNKNOWN')
  assert.equal((await verifyBusiness(rules, result(), query([{ key: 'p1', value: '完成' }, { key: 'p2', value: '完成' }, { key: 'p3', value: '完成' }]))).status, 'FAILED')
  assert.equal((await verifyBusiness(rules, result(), query([{ key: 'p1', value: '完成' }, { key: 'p2', value: '完成' }]))).status, 'VERIFIED')
})
test('exact field assertions detect wrong units and periods without substring success', async () => {
  const rules = assertionSchema().parse([{ id: 'unit', type: 'textEquals', selector: '#unit', expected: 'unit1' }])
  assert.equal((await verifyBusiness(rules, result(), async () => ['unit10'])).status, 'FAILED')
  assert.equal((await verifyBusiness(rules, result(), async () => ['unit1', 'unit1'])).status, 'UNKNOWN')
})
test('payment verification requires full coverage and checks assertion expectations against task context', async () => {
  const session = fixture(), context = businessContext(session, { taskCode: 'task', accountNumber: 'unit1', feeMonth: '2026-11', personCount: 2, amount: 100 })
  // An explicit business expectation resolves the configured old unit while preserving the conflict.
  session.businessProfile = { taskCode: 'task', values: { account: 'unit1' } }
  const confirmed = businessContext(session, { taskCode: 'task', accountNumber: 'unit1', feeMonth: '2026-11', personCount: 2, amount: 100 })
  const rules = assertionSchema().parse([
    { id:'account',type:'textEquals',businessField:'account',selector:'#account',expected:'unit1' },
    { id:'period',type:'textEquals',businessField:'period',selector:'#period',expected:'2026-11' },
    { id:'count',type:'numberEquals',businessField:'personCount',selector:'#count',expected:2 },
    { id:'amount',type:'numberEquals',businessField:'amount',selector:'#amount',expected:100 },
    { id:'state',type:'businessState',selector:'#state',acceptedValues:['已入账'] }
  ])
  const query = async (_, selector) => [{ '#account':'unit1','#period':'2026-11','#count':'2','#amount':'100','#state':'已入账' }[selector]]
  assert.equal((await verifyBusiness(rules, result(), query, context)).status, 'UNKNOWN')
  assert.equal((await verifyBusiness(rules, result(), query, confirmed)).status, 'VERIFIED')
  const partial = await verifyBusiness(rules.slice(0, 1), result(), query, confirmed)
  assert.equal(partial.status, 'UNKNOWN'); assert.ok(partial.coverage.missing.includes('amount'))
  const wrong = rules.map(rule => rule.id === 'period' ? { ...rule, expected:'2026-10' } : rule)
  const outcome = await verifyBusiness(wrong, result(), async (_, selector) => selector === '#period' ? ['2026-10'] : query(_, selector), confirmed)
  assert.equal(outcome.status, 'UNKNOWN')
  assert.match(outcome.details.find(item => item.id === 'period').reason, /业务上下文/)
})
test('private verification preserves long account identifiers while model-facing context stays redacted', () => {
  const session = fixture(), task = { accountNumber: '123456789012345678' }
  assert.equal(businessContext(session, task).fields.account.candidates[0].value, '[ID]')
  assert.equal(businessContext(session, task, { redactResult:false }).fields.account.candidates[0].value, task.accountNumber)
})
const rule = { id: 'r1', title: '示例规则', region: '杭州', system: '网厅A', businessType: '汇缴', source: '经确认的业务规范示例', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', verifiedAt: '2026-11-01', preconditions: ['核对所属期'], successCriteria: ['官方状态已入账'], rejectionAdvice: [] }
test('regional rules require a source and valid exact scope, excluding expired and future evidence', () => {
  assert.equal(ruleSchema().parse([rule]).length, 1)
  assert.throws(() => ruleSchema().parse([{ ...rule, source: '' }]))
  assert.throws(() => ruleSchema().parse([{ ...rule, effectiveTo: '2026-02-30' }]))
  assert.throws(() => ruleSchema().parse([{ ...rule, region: '*' }]))
  const context = businessContext(fixture()), now = new Date('2026-11-06T00:00:00Z')
  assert.equal(searchRules([rule], context, '', now).rules.length, 1)
  assert.equal(searchRules([{ ...rule, region: '其他地区' }], context, '', now).rules.length, 0)
  assert.equal(searchRules([{ ...rule, effectiveTo: '2026-10-31' }], context, '', now).expiredCount, 1)
  assert.equal(searchRules([{ ...rule, verifiedAt: '2026-11-07' }], context, '', now).rules.length, 0)
  assert.equal(searchRules([rule], businessContext({ ...fixture(), dsl: {} }), '', now).missingScope, true)
})
test('only current verified outcomes with official state assertions become cases; imported references cannot self-promote', () => {
  const session = fixture(), now = new Date('2026-11-06T00:00:00Z')
  session.rules = [{ id: 's', type: 'businessState' }]
  session.runs = [{ taskCode: 'task', revision: 1, artifactId: 'evidence', rootDslFingerprint: digest(session.dsl), result: { status: 'SUCCEEDED' }, verification: { status: 'PENDING' } }]
  assert.throws(() => makeCase(session, now), /业务已验证/)
  session.runs[0].verification.status = 'VERIFIED'
  const item = makeCase(session, now)
  assert.equal(item.status, 'VERIFIED_OUTCOME')
  assert.equal(searchCases([item], businessContext(session), '', now).length, 1)
  assert.equal(searchCases([item], businessContext(session), '', new Date('2027-03-01')).length, 0)
  assert.equal(searchCases([{ ...item, status: 'UNVERIFIED_REFERENCE' }], businessContext(session), '', now).length, 0)
  assert.equal(searchCases([item], businessContext(session), '', now, 'changed-rules')[0].needsRevalidation, true)
  session.dsl.steps[0].actionArgs.socialNumber = 'changed-unit'
  assert.equal(searchCases([item], businessContext(session), '', now)[0].needsRevalidation, true)
  session.revision++
  assert.throws(() => makeCase(session, now), /当前版本/)
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
