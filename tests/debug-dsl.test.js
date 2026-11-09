'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildDebugDsl, nestDebugSteps, loadReferencedDebugFlows, assertCompleteDebugDsl } = require('../src/services/debug-dsl')
const step = (name = 'read') => ({ stepCode: name, stepName: name, actionCode: 'read' })
const call = name => ({ stepCode: 'call-' + name, stepName: '调用' + name, actionCode: 'subFlow', actionArgs: { flowName: name } })
const root = (steps = [call('医疗增员单个')]) => ({ appCode: 'app', appName: '应用', flowCode: 'main', flowName: '主流程', steps })
function api(flows = [{ appCode: 'app', flowCode: 'main', flowName: '主流程' }], extra = {}) {
  return { listFlows: async () => flows, getFlow: async code => flows.find(flow => flow.flowCode === code),
    listSteps: async () => [step()], ...extra }
}

test('partial parameter VOS overlay raw JSON without losing values or treating false string flags as hidden', () => {
  const source = { ...step(), actionArgs: '{"flowName":"医疗增员单个","retained":0,"enabled":false,"masked":"old"}',
    actionArgsVOS: [{ fieldKey: 'flowName', isHideCust: '0' }, { fieldKey: 'masked', fieldValue: 'new', isHideCust: '1' }] }
  const dsl = buildDebugDsl('app', 'main', root(), [source])
  assert.deepEqual(dsl.steps[0].actionArgs, { flowName: '医疗增员单个', retained: 0, enabled: false, masked: '' })
})

test('DSL conversion preserves execution strategies, both argument maps, app metadata and block scopes', () => {
  const metadata = { ...root(), appArgs: { zero: 0, disabled: false, object: { nested: 'value' } }, declareSystem: 'medical',
    serviceItem: 0, tagCode: 'tag', runSupport: 'browser', sessionKeep: 0, templateFlowCode: 'tpl', loginFlowFlag: 'flag', relationFlowCode: 'source' }
  const row = { ...step(), status: 0, failedRetry: 0, failedStrategy: 2, skipTo: 'NEXT', failedSkipTo: 'NEXT', falseSkipTo: 'NEXT',
    skipCondition: 'condition', waitBefore: 2, waitAfter: 3, timeout: 4, maxExecuteNum: 5,
    actionArgs: { zero: 0, empty: '', disabled: false }, targetArgs: { xpath: '//body' } }
  const dsl = buildDebugDsl('app', 'main', metadata, [row, { ...step('block'), actionCode: 'codeBlock', list: [step('inner')] }])
  assert.deepEqual(dsl.steps[0], row)
  assert.equal(dsl.steps[1].body[0].stepCode, 'inner')
  for (const field of ['appArgs', 'declareSystem', 'serviceItem', 'tagCode', 'runSupport', 'sessionKeep', 'templateFlowCode', 'loginFlowFlag', 'relationFlowCode']) {
    assert.deepEqual(dsl[field], metadata[field])
  }
})

test('nested and flat native rows preserve every step; invalid hierarchy cannot be silently flattened', () => {
  const nested = [{ ...step('parent'), list: [{ ...step('child'), level: 1 }] }]
  assert.equal(nestDebugSteps(nested)[0].list[0].stepCode, 'child')
  const flat = [{ ...step('parent'), level: 0 }, { ...step('child'), level: 1 }]
  assert.deepEqual(nestDebugSteps(flat), nested.map(row => ({ ...row, level: 0, list: row.list.map(child => ({ ...child, list: [] })) })))
  assert.throws(() => nestDebugSteps([{ ...step('orphan'), level: 1 }]), /子步骤|层级/)
  assert.throws(() => nestDebugSteps([{ ...step(), level: 2 }]), /层级/)
  assert.throws(() => buildDebugDsl('app', 'main', root(), [step(), step()]), /重复/)
})
test('native duplicate codes receive stable occurrence identities without losing steps, values or database ownership', () => {
  const input = [
    { ...step('shared'), id: 1, stepName: '读取单位', level: 0, actionArgs: '{"field":"unit"}' },
    { ...step('shared'), id: 2, stepName: '读取所属期', level: 1, actionArgs: '{"field":"period"}', skipTo: '查询结果' },
    { ...step('result'), id: 3, stepName: '查询结果', level: 0 }
  ]
  const before = structuredClone(input), rows = nestDebugSteps(input), again = nestDebugSteps(input)
  assert.deepEqual(input, before)
  assert.deepEqual(rows, again)
  const child = rows[0].list[0]
  assert.notEqual(child.stepCode, 'shared'); assert.equal(child.sourceStepCode, 'shared'); assert.equal(child.id, 2)
  const dsl = buildDebugDsl('app', 'main', root(), rows)
  assert.equal(dsl.steps.length, 2); assert.equal(dsl.steps[0].children.length, 1)
  assert.equal(dsl.steps[0].children[0].actionArgs.field, 'period')
  assert.equal(dsl.steps[0].children[0].skipTo, '查询结果')
  assert.doesNotThrow(() => assertCompleteDebugDsl(dsl))
  assert.deepEqual(nestDebugSteps(rows), rows)
})
test('nested code blocks with reused codes retain their children and group ownership', () => {
  const input = [
    { ...step('block'), actionCode: 'codeBlock', stepName: '块一', list: [{ ...step('inner'), stepName: '读取一', groupCode: 'block' }] },
    { ...step('block'), actionCode: 'codeBlock', stepName: '块二', list: [{ ...step('inner'), stepName: '读取二', groupCode: 'block' }] }
  ]
  const rows = nestDebugSteps(input)
  assert.equal(rows[1].list[0].groupCode, rows[1].stepCode)
  const dsl = buildDebugDsl('app', 'main', root(), rows)
  assert.doesNotThrow(() => assertCompleteDebugDsl(dsl))
  assert.equal(new Set([dsl.steps[0].stepCode, dsl.steps[0].body[0].stepCode, dsl.steps[1].stepCode, dsl.steps[1].body[0].stepCode]).size, 4)
  assert.deepEqual(input[1].list[0].groupCode, 'block')
})
test('missing native codes are stable and repeated database ids are not reused for repaired occurrences', () => {
  const rows = nestDebugSteps([{ ...step('same'), id: 7, stepName: '第一步' }, { ...step('same'), id: 7, stepName: '第二步' },
    { stepName: '缺失编码', actionCode: 'read' }])
  assert.equal(rows[0].id, 7); assert.equal(rows[1].id, undefined)
  assert.equal(rows[2].sourceStepCode, null)
  assert.equal(new Set(rows.map(row => row.stepCode)).size, 3)
  assert.throws(() => buildDebugDsl('app', 'main', root(), [step(), step()]), /重复/)
})

test('missing application subflows fall back to public templates and recursively include finalFlow dependencies', async () => {
  const templates = [{ flowCode: 'template-child', flowName: '医疗增员单个' }, { flowCode: 'cleanup', flowName: '收尾' }]
  const bundle = await loadReferencedDebugFlows(root(), 'app', api(undefined, {
    listTemplates: async () => templates,
    listSteps: async flow => flow.flowCode === 'template-child' ? [{ ...call('收尾'), actionCode: 'finalFlow' }] : [step()]
  }))
  assert.deepEqual(bundle.subflows.map(flow => flow.flowCode), ['template-child', 'cleanup'])
  assert.doesNotThrow(() => assertCompleteDebugDsl(bundle))
})

test('a draft is applied before scanning its new dependency graph, including drafts with no saved steps', async () => {
  const flows = [{ flowCode: 'main', flowName: '主流程' }, { flowCode: 'child', flowName: '子流程' }, { flowCode: 'grandchild', flowName: '新下级' }]
  const bundle = await loadReferencedDebugFlows(root([call('子流程')]), 'app', api(flows, {
    listSteps: async flow => flow.flowCode === 'child' ? [] : [step()],
    overrideFlow: async flow => flow.flowCode === 'child' ? { steps: [call('新下级')] } : null
  }))
  assert.deepEqual(bundle.subflows.map(flow => flow.flowCode), ['child', 'grandchild'])
})

test('template-backed aliases retain their called name and load their effective template steps', async () => {
  const flows = [{ flowCode: 'main', flowName: '主流程' }, { flowCode: 'alias', flowName: '别名', templateFlowCode: 'template' }]
  const requests = []
  const bundle = await loadReferencedDebugFlows(root([call('别名')]), 'app', api(flows, {
    getFlow: async code => ({ flowCode: code, flowName: '模板原名', appCode: null }),
    listSteps: async flow => { requests.push(flow.templateFlowCode || flow.flowCode); return flow.flowCode === 'alias' ? [] : [step()] }
  }))
  assert.equal(bundle.subflows[0].flowName, '别名')
  assert.equal(bundle.subflows[0].steps.length, 1)
  assert.ok(requests.includes('template'))
})

test('an empty application child inherits a same-name public template while keeping its alias code', async () => {
  const flows = [{ flowCode: 'main', flowName: '主流程' }, { flowCode: 'local', flowName: '医疗增员单个' }]
  const bundle = await loadReferencedDebugFlows(root(), 'app', api(flows, {
    listTemplates: async () => [{ flowCode: 'public', flowName: '医疗增员单个' }],
    listSteps: async flow => flow.flowCode === 'local' ? [] : [step()]
  }))
  assert.equal(bundle.subflows[0].flowCode, 'local')
  assert.equal(bundle.subflows[0].steps[0].stepCode, 'read')
})

test('same-name child references from different applications cannot silently reuse the wrong definition', async () => {
  const local = [{ flowCode: 'main', flowName: '主流程' }, { flowCode: 'a', flowName: 'A', relationFlowCode: 'source-a' },
    { flowCode: 'b', flowName: 'B', relationFlowCode: 'source-b' }]
  const sourceFlows = {
    'source-a': { flowCode: 'source-a', flowName: '来源A', appCode: 'one' },
    'source-b': { flowCode: 'source-b', flowName: '来源B', appCode: 'two' }
  }
  await assert.rejects(loadReferencedDebugFlows(root([call('A'), call('B')]), 'app', api(local, {
    getFlow: async code => sourceFlows[code],
    listFlows: async code => code === 'app' ? local : [{ flowCode: code + '-child', flowName: '同名子流程' }],
    listSteps: async flow => ['a', 'b'].includes(flow.flowCode) ? [call('同名子流程')] : [step()]
  })), /同名.*冲突/)
})

test('disabled calls are omitted from the closure, while enabled ordinary children and code blocks remain complete', async () => {
  const source = root([{ ...call('不加载'), status: 0, children: [call('普通子步骤')] },
    { ...step('block'), actionCode: 'codeBlock', body: [call('块内调用')] },
    { ...step('disabled-block'), actionCode: 'codeBlock', status: 0, body: [{ ...call('不加载'), stepCode: 'disabled-inner' }] }])
  const bundle = await loadReferencedDebugFlows(source, 'app', api([
    { flowCode: 'main', flowName: '主流程' }, { flowCode: 'child', flowName: '普通子步骤' }, { flowCode: 'body', flowName: '块内调用' }
  ]))
  assert.deepEqual(bundle.subflows.map(flow => flow.flowCode), ['child', 'body'])
})

test('inherited root metadata locates child flows in the referenced application', async () => {
  const local = [{ flowCode: 'main', flowName: '主流程', relationFlowCode: 'source-main' }]
  const remote = [{ appCode: 'source', flowCode: 'source-main', flowName: '来源主流程' }, { appCode: 'source', flowCode: 'source-child', flowName: '医疗增员单个' }]
  const bundle = await loadReferencedDebugFlows(root(), 'app', api(local, {
    listFlows: async code => code === 'app' ? local : remote,
    getFlow: async code => remote.find(flow => flow.flowCode === code)
  }))
  assert.equal(bundle.subflows[0].flowCode, 'source-child')
})

test('ambiguous application and template names are rejected instead of selecting the first match', async () => {
  await assert.rejects(loadReferencedDebugFlows(root(), 'app', api([
    { flowCode: 'main', flowName: '主流程' }, { flowCode: 'one', flowName: '医疗增员单个' }, { flowCode: 'two', flowName: '医疗增员单个' }
  ])), /同名|不唯一/)
  await assert.rejects(loadReferencedDebugFlows(root(), 'app', api(undefined, {
    listTemplates: async () => [{ flowCode: 'one', flowName: '医疗增员单个' }, { flowCode: 'two', flowName: '医疗增员单个' }]
  })), /同名|不唯一/)
})

test('an incomplete bundle and dangling jumps fail integrity checks, while NEXT remains valid', () => {
  assert.throws(() => assertCompleteDebugDsl(root()), /医疗增员单个/)
  const dsl = root([{ ...step(), skipTo: 'NEXT' }])
  assert.doesNotThrow(() => assertCompleteDebugDsl(dsl))
  assert.equal(buildDebugDsl('app', 'main', dsl, dsl.steps, dsl.steps[0]).steps[0].skipTo, 'NEXT')
  assert.throws(() => assertCompleteDebugDsl(root([{ ...step(), skipTo: 'missing' }])), /跳转/)
})

test('reference cycles stop loading and malformed steps fail instead of masquerading as an empty alias', async () => {
  const flows = [{ flowCode: 'main', flowName: '主流程' }, { flowCode: 'alias', flowName: '医疗增员单个', relationFlowCode: 'alias' }]
  await assert.rejects(loadReferencedDebugFlows(root(), 'app', api(flows, { listSteps: async () => [] })), /循环/)
  await assert.rejects(loadReferencedDebugFlows(root(), 'app', api(flows, { listSteps: async () => ({ rows: [] }) })), /步骤.*数组|步骤.*格式/)
})
