'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildDebugDsl, nestDebugSteps, loadReferencedDebugFlows, assertCompleteDebugDsl } = require('../src/services/debug-dsl')
const step = (name = 'read') => ({ stepCode: name, stepName: name, actionCode: 'read' })
const call = name => ({ stepCode: 'call-' + name, stepName: '调用' + name, actionCode: 'subFlow', actionArgs: { flowName: name } })
const root = (steps = [call('医疗增员单个')]) => ({ appCode: 'app', appName: '应用', flowCode: 'main', flowName: '主流程', steps })

test('a login with private steps and template metadata stays visible without querying the template owner',async()=>{
  const flows=[{flowCode:'main',flowName:'在册主流程新'},{flowCode:'login',flowName:'登录',templateFlowCode:'unavailable-template'},
    {flowCode:'refresh',flowName:'刷新'}]
  const calls=[]
  const bundle=await loadReferencedDebugFlows(root([call('登录')]),'app',api(flows,{
    getFlow:async code=>{calls.push(code);throw new Error('模板不可用')},
    listSteps:async flow=>flow.flowCode==='login'?[call('刷新')]:[step('已打开浏览器')]
  }),{inspect:true})
  assert.deepEqual(bundle.subflows.map(flow=>flow.flowName),['登录','刷新'])
  assert.deepEqual(bundle.inspectionDiagnostics,[]);assert.deepEqual(calls,[])
})

test('DSL viewing omits disabled calls and still reports missing enabled dependencies',async()=>{
  const flows=[{flowCode:'main',flowName:'主流程'},{flowCode:'a',flowName:'登录'},{flowCode:'b',flowName:'刷新'},{flowCode:'c',flowName:'校验'}]
  const input=root([call('登录'), {...call('刷新'),status:0},
    {...step('block'),actionCode:'codeBlock',status:0,body:[call('块内调用')]},call('缺失流程'),
    {...step('no-name'),actionCode:'subFlow',status:0}])
  const original=structuredClone(input)
  const bundle=await loadReferencedDebugFlows(structuredClone(input),'app',api(flows,{
    listSteps:async flow=>flow.flowCode==='a'?[call('校验')]:[{...step(flow.flowCode),skipTo:'无效跳转'}],
    prepareFlow:async()=>{throw new Error('只读查看不应编译可执行包')}
  }),{inspect:true})
  assert.deepEqual(bundle.subflows.map(flow=>flow.flowCode).sort(),['a','c'])
  assert.ok(bundle.inspectionDiagnostics.some(item=>item.flowName==='缺失流程'))
  assert.equal(bundle.inspectionDiagnostics.length,1)
  assert.deepEqual(bundle.steps,original.steps.filter(item=>item.status!==0))
})

test('reading login preserves its existing jump target without validating a broken called refresh flow',async()=>{
  const flows=[{flowCode:'main',flowName:'主流程'},{flowCode:'login',flowName:'登录'},{flowCode:'refresh',flowName:'刷新进入首页'}]
  const rows={login:[call('刷新进入首页'),{...step('check'),stepName:'当前申报单位错误?',skipTo:'退出浏览器'},
    {...step('exit'),stepName:'退出浏览器'}],refresh:[{...step('refresh-check'),stepName:'当前申报单位错误?',skipTo:'退出浏览器'}]}
  const reads=[],source=api(flows,{listSteps:async flow=>{reads.push(flow.flowCode);return rows[flow.flowCode]},
    prepareFlow:async definition=>{require('../src/shared/step-structure').cleanJumps(definition,true);return definition}})
  const inspected=await loadReferencedDebugFlows(root([call('登录')]),'app',source,{inspect:true,targetFlowCode:'login'})
  const login=inspected.subflows.find(flow=>flow.flowCode==='login')
  assert.equal(login.steps[1].skipTo,'退出浏览器');assert.ok(login.steps.some(step=>step.stepName==='退出浏览器'))
  assert.deepEqual(require('../src/shared/step-structure').jumpDiagnostics(login),[])
  assert.deepEqual(reads,['login'])
  await assert.rejects(loadReferencedDebugFlows(root([call('登录')]),'app',source),/流程“刷新进入首页”.*跳转目标不存在/)
  const refreshed=await loadReferencedDebugFlows(root([call('登录')]),'app',source,{inspect:true,targetFlowCode:'refresh'})
  const diagnostics=require('../src/shared/step-structure').jumpDiagnostics(refreshed.subflows.find(flow=>flow.flowCode==='refresh'))
  assert.equal(diagnostics[0].flowCode,'refresh');assert.equal(diagnostics[0].target,'退出浏览器')
})

test('inspection tolerates unrelated missing branches without granting access to an uncalled flow',async()=>{
  const flows=[{flowCode:'main',flowName:'主流程'},{flowCode:'login',flowName:'登录'},{flowCode:'uncalled',flowName:'未调用'}]
  const data=api(flows,{listSteps:async()=>[step()]})
  const inspected=await loadReferencedDebugFlows(root([call('不存在'),call('登录')]),'app',data,{inspect:true,targetFlowCode:'login'})
  assert.ok(inspected.subflows.some(flow=>flow.flowCode==='login'))
  const uncalled=await loadReferencedDebugFlows(root([call('不存在'),call('登录')]),'app',data,{inspect:true,targetFlowCode:'uncalled'})
  assert.ok(!uncalled.subflows.some(flow=>flow.flowCode==='uncalled'))
  assert.equal(uncalled.inspectionDiagnostics[0].flowName,'不存在')
})
function api(flows = [{ appCode: 'app', flowCode: 'main', flowName: '主流程' }], extra = {}) {
  return { listFlows: async () => flows, getFlow: async code => flows.find(flow => flow.flowCode === code),
    listSteps: async () => [step()], ...extra }
}

test('execution omits disabled rows, promotes ordinary children and preserves valid jump targets', async () => {
  const steps = [{ ...step('check'), skipTo: 'finish' }, {
    ...call('停用调用'), status: 0, skipTo: '已删除步骤', children: [call('末级')]
  }, {
    ...step('block'), actionCode: 'codeBlock', status: 0, body: [{ ...call('停用块调用'), falseSkipTo: '已删除块内步骤' }]
  }, step('finish')]
  const flows = [{ flowCode: 'leaf', flowName: '末级' }]
  const source = api(flows, { listSteps: async () => [step('leaf-step'), { ...call('缺失'), status: '0' }] })
  const bundle = await loadReferencedDebugFlows(root(steps), 'app', source)
  assert.equal(bundle.steps[0].skipTo, 'finish')
  assert.deepEqual(bundle.steps.map(item => item.stepCode), ['check', 'call-末级', 'finish'])
  assert.deepEqual(bundle.subflows.map(flow => flow.flowName), ['末级'])
  assert.deepEqual(bundle.subflows[0].steps.map(item => item.stepCode), ['leaf-step'])
  assert.equal(steps[1].skipTo, '已删除步骤')
  await assert.rejects(loadReferencedDebugFlows(root(steps), 'app', api([])), /主流程 → 末级/)
  await assert.rejects(loadReferencedDebugFlows(root([{ ...step('check'), skipTo: 'finish' },
    { ...step('finish'), status: 0 }]), 'app', source), /跳转目标不存在：finish/)
  assert.throws(() => buildDebugDsl('app', 'main', root(), steps, steps[0]), /跳转超出单步范围/)
})

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
  const { falseSkipTo, ...canonical } = row
  assert.deepEqual(dsl.steps[0], canonical)
  assert.equal(dsl.steps[1].body[0].stepCode, 'inner')
  for (const field of ['appArgs', 'declareSystem', 'serviceItem', 'tagCode', 'runSupport', 'sessionKeep']) {
    assert.deepEqual(dsl[field], metadata[field])
  }
})

test('legacy falseSkipTo is migrated to the IDE failedSkipTo field', () => {
  const dsl = buildDebugDsl('app', 'main', root(), [{ ...step(), falseSkipTo: 'NEXT' }])
  assert.equal(dsl.steps[0].failedSkipTo, 'NEXT')
  assert.equal(Object.hasOwn(dsl.steps[0], 'falseSkipTo'), false)
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

test('current-application subflows recursively include finalFlow dependencies',async()=>{
 const flows=[{flowCode:'child',flowName:'医疗增员单个'},{flowCode:'cleanup',flowName:'收尾'}]
 const bundle=await loadReferencedDebugFlows(root(),'app',api(flows,{listSteps:async f=>f.flowCode==='child'?[{...call('收尾'),actionCode:'finalFlow'}]:[step()]}))
 assert.deepEqual(bundle.subflows.map(f=>f.flowCode),['child','cleanup'])
})

test('a draft is applied before scanning its new dependency graph, including drafts with no saved steps', async () => {
  const flows = [{ flowCode: 'main', flowName: '主流程' }, { flowCode: 'child', flowName: '子流程' }, { flowCode: 'grandchild', flowName: '新下级' }]
  const bundle = await loadReferencedDebugFlows(root([call('子流程')]), 'app', api(flows, {
    listSteps: async flow => flow.flowCode === 'child' ? [] : [step()],
    overrideFlow: async flow => flow.flowCode === 'child' ? { steps: [call('新下级')] } : null
  }))
  assert.deepEqual(bundle.subflows.map(flow => flow.flowCode), ['child', 'grandchild'])
})

test('legacy template links cannot supply missing current-application steps',async()=>{
 let retiredReads=0
 await assert.rejects(loadReferencedDebugFlows(root(),'app',api([{flowCode:'local',flowName:'医疗增员单个',templateFlowCode:'old'}],{
 listSteps:async()=>[],getFlow:async()=>{retiredReads++},listTemplates:async()=>{retiredReads++}
 })),/步骤/)
 assert.equal(retiredReads,0)
})

test('missing local calls never fall back to public catalogs',async()=>{
 let retiredReads=0
 await assert.rejects(loadReferencedDebugFlows(root(),'app',api([],{listTemplates:async()=>{retiredReads++;return [{flowCode:'old',flowName:'医疗增员单个'}]}})),/未找到当前应用/)
 assert.equal(retiredReads,0)
})

test('an explicit reference loads nested calls from the source app and keeps the alias identity', async () => {
  const looked = [], stepReads = []
  const bundle = await loadReferencedDebugFlows(root([call('引用流程')]), 'app', {
    listFlows: async app => {
      looked.push(app)
      return app === 'app'
        ? [{ flowCode: 'alias', flowName: '引用流程', relationFlowCode: 'source' }, { flowCode: 'local', flowName: '末级' }]
        : [{ flowCode: 'leaf', flowName: '末级' }]
    },
    getFlow: async flowCode => ({ flowCode, appCode: 'source-app', flowName: '来源流程' }),
    listSteps: async flow => {
      stepReads.push(flow.flowCode)
      return flow.flowCode === 'alias' ? [] : flow.flowCode === 'source' ? [call('末级')] : [step()]
    }
  })
  assert.deepEqual(looked, ['app', 'source-app'])
  assert.deepEqual(stepReads, ['alias', 'source', 'leaf'])
  assert.deepEqual(bundle.subflows.map(flow => flow.flowCode), ['alias', 'leaf'])
  assert.equal(bundle.subflows[0].flowName, '引用流程')
})

test('enrollment and register flows share a referenced login across application aliases', async () => {
  for (const options of [{}, { validate: false }, { inspect: true }]) {
    const reads = []
    const catalog = {
      app: [
        { flowCode: 'register-alias', flowName: '医疗在册主流程', relationFlowCode: 'register-source' },
        { flowCode: 'login-alias', flowName: '医疗登录', relationFlowCode: 'login-source' }
      ],
      source: [{ appCode: 'source', flowCode: 'login-source', flowName: '医疗登录' }]
    }
    const bundle = await loadReferencedDebugFlows(root([call('医疗在册主流程'), call('医疗登录')]), 'app', {
      listFlows: async owner => catalog[owner],
      getFlow: async code => ({ appCode: 'source', flowCode: code,
        flowName: code === 'register-source' ? '医疗在册主流程' : '医疗登录' }),
      listSteps: async flow => {
        reads.push(flow.flowCode)
        if (flow.relationFlowCode) return []
        return flow.flowCode === 'register-source' ? [call('医疗登录')] : [step('实际登录')]
      }
    }, options)
    assert.deepEqual(bundle.subflows.map(flow => flow.flowCode), ['register-alias', 'login-alias'])
    assert.deepEqual(bundle.subflows[1].steps, [step('实际登录')])
    assert.equal(reads.filter(code => code === 'login-source').length, 1)
    assert.deepEqual(bundle.inspectionDiagnostics || [], [])
  }
})

test('repeated calls to the same local login load it only once', async () => {
  const reads = []
  const bundle = await loadReferencedDebugFlows(root([call('在册'), call('登录')]), 'app', api([
    { flowCode: 'register', flowName: '在册' }, { flowCode: 'login', flowName: '登录' }
  ], { listSteps: async flow => {
    reads.push(flow.flowCode)
    return flow.flowCode === 'register' ? [call('登录')] : [step()]
  } }))
  assert.deepEqual(bundle.subflows.map(flow => flow.flowCode), ['register', 'login'])
  assert.deepEqual(reads, ['register', 'login'])
})

test('same-name logins with different reference sources still report a conflict', async () => {
  await assert.rejects(loadReferencedDebugFlows(root([call('在册'), call('登录')]), 'app', {
    listFlows: async owner => owner === 'app' ? [
      { flowCode: 'register', flowName: '在册', relationFlowCode: 'source-register' },
      { flowCode: 'local-login', flowName: '登录' }
    ] : [{ appCode: 'source', flowCode: 'source-login', flowName: '登录' }],
    getFlow: async code => ({ appCode: 'source', flowCode: code, flowName: '在册' }),
    listSteps: async flow => flow.flowCode === 'register' ? [] :
      flow.flowCode === 'source-register' ? [call('登录')] : [step()]
  }), /同名流程来源冲突/)
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

test('retired root parameters are excluded from loaded DSL',async()=>{
 const input={...root([step()]),templateFlowCode:'old',relationFlowCode:'source',loginFlowFlag:1,flowGraph:{nodes:[]}}
 const result=await loadReferencedDebugFlows(input,'app',api())
 for(const key of ['templateFlowCode','relationFlowCode','loginFlowFlag','flowGraph'])assert.equal(Object.hasOwn(result,key),false)
})

test('ambiguous application and template names are rejected instead of selecting the first match', async () => {
  await assert.rejects(loadReferencedDebugFlows(root(), 'app', api([
    { flowCode: 'main', flowName: '主流程' }, { flowCode: 'one', flowName: '医疗增员单个' }, { flowCode: 'two', flowName: '医疗增员单个' }
  ])), /同名|不唯一/)
  await assert.rejects(loadReferencedDebugFlows(root(), 'app', api(undefined, {
    listTemplates: async () => [{ flowCode: 'one', flowName: '医疗增员单个' }, { flowCode: 'two', flowName: '医疗增员单个' }]
  })), /未找到当前应用/)
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
  await assert.rejects(loadReferencedDebugFlows(root(), 'app', api(flows, { listSteps: async () => [] })), /引用关系存在循环/)
  await assert.rejects(loadReferencedDebugFlows(root(), 'app', api(flows, { listSteps: async () => ({ rows: [] }) })), /步骤.*数组|步骤.*格式/)
})
