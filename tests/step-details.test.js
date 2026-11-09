'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {visible,validate}=require('../src/shared/argument-fields')
const {renameReferences,cleanJumps}=require('../src/shared/step-structure')
const {validateCandidate,toSaveRows}=require('../src/agent/tools')
const {importRecordedSteps}=require('../src/services/step-edit')
const session={scope:{appCode:'a',flowCode:'f'},dsl:{appCode:'a',flowCode:'f',steps:[]}}
test('empty drafts and empty code blocks can be edited, but cannot be saved or executed',()=>{
  const commands={items:[{actionCode:'codeBlock',actionArgsVOS:[],targetArgsVOS:[]}],oldSteps:[]}
  assert.deepEqual(validateCandidate(session,session.dsl,commands,{draft:true}),[])
  assert.throws(()=>toSaveRows(session,commands),/步骤/)
  const dsl={appCode:'a',flowCode:'f',steps:[{stepCode:'block',stepName:'块',actionCode:'codeBlock',body:[]}]}
  assert.equal(validateCandidate(session,dsl,commands,{draft:true}).length,1)
  assert.throws(()=>validateCandidate(session,dsl,commands),/没有步骤/)
})
test('zero values satisfy required numeric arguments and conditional hidden fields are not required',()=>{
  const definitions=[{fieldKey:'mode',fieldName:'模式',cond:'{"normal":["timeout"],"other":["secret"]}'},{fieldKey:'timeout',fieldType:'number',required:1},{fieldKey:'secret',required:1}]
  assert.equal(validate(definitions,{mode:'normal',timeout:0},'step').find(field=>field.fieldKey==='secret').hidden,true)
  assert.throws(()=>validate(definitions,{mode:'normal',timeout:-1},'step'),/非负整数/)
  assert.throws(()=>validate(definitions,{mode:'other'},'step'),/secret/)
  assert.equal(visible(definitions,{mode:'normal'}).length,3)
})

function h5Definitions() {
  const action = require('../src/services/action-knowledge.json').actions.find(action => action.actionCode === 'h5Login')
  return action.actionFields.map(field => ({ fieldKey: field.key, fieldName: field.name, required: field.required ? 1 : 0,
    cond: field.conditions.length ? JSON.stringify(Object.fromEntries(field.conditions.map(condition => {
      const separator = condition.indexOf(':')
      return [condition.slice(0, separator), condition.slice(separator + 1).split(',')]
    }))) : '', fieldType: 'text' }))
}

test('independent dropdown chains remain available while nested inactive selectors stay hidden',()=>{
  const definitions=[{fieldKey:'mode',cond:{a:['detail'],b:['other']}},{fieldKey:'detail'},
    {fieldKey:'second',cond:{x:['nested'],y:['value']}},{fieldKey:'nested',cond:{on:['nestedValue'],off:[]}},{fieldKey:'nestedValue'},{fieldKey:'other'},{fieldKey:'value'}]
  const shown=values=>visible(definitions,values).filter(field=>!field.hidden).map(field=>field.fieldKey)
  assert.deepEqual(new Set(shown({mode:'a',second:'x',nested:'on'})),new Set(['mode','detail','second','nested','nestedValue']))
  assert.deepEqual(new Set(shown({mode:'b',second:'y',nested:'on'})),new Set(['mode','other','second','value']))
})

test('H5 QR login does not require SMS-only controllers, even when stale SMS values remain', () => {
  const definitions = h5Definitions()
  for (const validateType of ['qrCode', 'faceCode']) {
    const values = Object.fromEntries(definitions.map(field => [field.fieldKey, 'fixture']))
    Object.assign(values, { validateType, inputType: '', inputXpath: '', smsXpath: '' })
    assert.doesNotThrow(() => validate(definitions, values, 'h5扫码登录'))
    assert.equal(visible(definitions, values).find(field => field.fieldKey === 'inputType').hidden, true)
    values.inputType = 'input'
    const fields = visible(definitions, values)
    assert.equal(fields.find(field => field.fieldKey === 'inputXpath').hidden, true)
    assert.equal(fields.find(field => field.fieldKey === 'smsXpath').hidden, true)
    assert.equal(fields.find(field => field.fieldKey === 'qrCodeXpath').hidden, false)
    assert.equal(visible([...definitions].reverse(), values).find(field => field.fieldKey === 'inputType').hidden, true)
    delete values.qrCodeXpath
    assert.throws(() => validate(definitions, values, 'h5扫码登录'), /二维码/)
  }
})

test('H5 SMS and dynamic-code branches validate only their active input controls', () => {
  const definitions = h5Definitions()
  const values = Object.fromEntries(definitions.map(field => [field.fieldKey, 'fixture']))
  Object.assign(values, { validateType: 'sms', inputType: '', qrCodeXpath: '' })
  assert.throws(() => validate(definitions, values, '短信登录'), /验证码输入方式/)
  values.inputType = 'input'; values.inputXpath = ''
  assert.throws(() => validate(definitions, values, '短信登录'), /验证码输入框/)
  values.inputType = 'keyboard'
  assert.doesNotThrow(() => validate(definitions, values, '短信登录'))
  values.validateType = 'dynamicCode'
  assert.equal(visible(definitions, values).find(field => field.fieldKey === 'inputType').hidden, true)
  assert.throws(() => validate(definitions, values, '动态码登录'), /验证码输入框/)
})

test('QR login DSL validation and save preserve QR parameters without requiring or reviving SMS fields', () => {
  const definitions = h5Definitions(), values = Object.fromEntries(definitions.map(field => [field.fieldKey, 'fixture']))
  Object.assign(values, { validateType: 'qrCode', inputType: 'input', inputXpath: 'stale-input', smsXpath: 'stale-sms' })
  const dsl = { appCode: 'a', flowCode: 'f', steps: [{ stepCode: 'qr', stepName: 'h5扫码登录', actionCode: 'h5Login', actionArgs: values }] }
  const commands = { items: [{ actionCode: 'h5Login', actionArgsVOS: definitions, targetArgsVOS: [] }], oldSteps: [] }
  const rows = toSaveRows({ ...session, dsl }, commands)
  const saved = JSON.parse(rows[0].actionArgs)
  assert.equal(saved.qrCodeXpath, 'fixture')
  assert.equal(saved.inputType, '')
  assert.equal(saved.inputXpath, '')
  assert.equal(saved.smsXpath, '')
})

for (const name of ['run_current_dsl', 'run_proposed_dsl', 'run_selected_step', 'continue_failed_run']) {
  test(name + ' sends a normalized QR login bundle and keeps the editor draft intact', async () => {
    const { createTools } = require('../src/agent/tools')
    const { Harness } = require('../src/agent/harness')
    const { digest } = require('../src/agent/store')
    const definitions = h5Definitions(), values = Object.fromEntries(definitions.map(field => [field.fieldKey, 'fixture']))
    Object.assign(values, { validateType: 'qrCode', inputType: '', inputXpath: 'stale-sms-input', smsXpath: 'stale-sms-button' })
    const dsl = { appCode: 'a', flowCode: 'f', steps: [{ stepCode: 'qr', stepName: 'h5扫码登录', actionCode: 'h5Login', actionArgs: values }] }
    const current = { id: 'qr-session', scope: { appCode: 'a', flowCode: 'f', executor: 'http://fixture' }, dsl,
      taskCode: 'fixture', revision: 0, runs: [], rules: [], messages: [], plan: [], events: [], artifacts: {}, sequence: 0 }
    current.proposal = { dsl, baseRevision: 0, baseline: digest(dsl) }
    if (name === 'continue_failed_run') current.runs.push({ taskCode: 'fixture', result: { status: 'FAILED', resumable: true, executionCode: 'failed-qr' } })
    let submitted
    const registry = createTools({ tasks: async () => [{ taskCode: 'fixture' }],
      commands: async () => ({ items: [{ actionCode: 'h5Login', actionArgsVOS: definitions, targetArgsVOS: [] }], oldSteps: [] }),
      bundle: async (_, dsl) => dsl,
      execute: async (_, body) => { submitted = body.dsl; return { status: 'SUCCEEDED' } },
      continue: async (_, previous, dsl) => { submitted = dsl; return { status: 'SUCCEEDED' } }, query: async () => [] })
    const harness = new Harness({ registry, store: { save() {} } })
    await harness.start(current, 'run', { directTool: { name, args: name === 'run_selected_step' ? { stepCode: 'qr' } : {} }, executionConsent: true })
    assert.equal(submitted.steps[0].actionArgs.qrCodeXpath, 'fixture')
    assert.equal(submitted.steps[0].actionArgs.smsXpath, '')
    assert.equal(submitted.steps[0].actionArgs.inputXpath, '')
    assert.equal(current.dsl.steps[0].actionArgs.smsXpath, 'stale-sms-button')
  })
}
test('rename and deletion update jumps only in the same execution scope',()=>{
  const dsl={steps:[{stepCode:'root',stepName:'go',actionCode:'page',skipTo:'end'},{stepCode:'end',stepName:'end',actionCode:'page'},
    {stepCode:'block',stepName:'block',actionCode:'codeBlock',body:[{stepCode:'inner',stepName:'go',actionCode:'page',skipTo:'end'},{stepCode:'inner-end',stepName:'end',actionCode:'page'}]}]}
  dsl.steps[1].stepName='new';renameReferences(dsl,'end','end','new')
  assert.equal(dsl.steps[0].skipTo,'new');assert.equal(dsl.steps[2].body[0].skipTo,'end')
  dsl.steps.splice(1,1);assert.equal(cleanJumps(dsl).length,1);assert.equal(dsl.steps[1].body[0].skipTo,'end')
})
test('repeated paste creates distinct identifiers, unique names and scoped jump remapping',()=>{
  const dsl={steps:[]},recording={steps:[{stepCode:'root',stepName:'same',actionCode:'page',skipTo:'same'},
    {stepCode:'b',stepName:'block',actionCode:'codeBlock',body:[{stepCode:'child',stepName:'same',actionCode:'page',skipTo:'same'}]}]}
  const one=importRecordedSteps(dsl,recording),two=importRecordedSteps(one.dsl,recording)
  assert.equal(two.dsl.steps.length,4)
  const root=two.dsl.steps[2],child=two.dsl.steps[3].body[0]
  assert.equal(root.skipTo,root.stepName);assert.equal(child.skipTo,child.stepName)
  assert.notEqual(root.stepCode,one.dsl.steps[0].stepCode)
  assert.notEqual(root.stepName,one.dsl.steps[0].stepName)
})
test('saving refuses dangling jumps, unknown step fields and invalid numeric strategies',()=>{
  const commands={items:[{actionCode:'page',actionArgsVOS:[],targetArgsVOS:[]}],oldSteps:[]},base={appCode:'a',flowCode:'f',steps:[{stepCode:'s',stepName:'one',actionCode:'page'}]}
  assert.throws(()=>validateCandidate(session,{...base,steps:[{...base.steps[0],skipTo:'missing'}]},commands),/跳转目标不存在/)
  assert.throws(()=>validateCandidate(session,{...base,steps:[{...base.steps[0],timeout:-1}]},commands),/负数/)
  assert.throws(()=>validateCandidate(session,{...base,steps:[{...base.steps[0],status:3}]},commands),/状态/)
  assert.throws(()=>validateCandidate(session,{...base,steps:[{...base.steps[0],unknown:'value'}]},commands),/不支持/)
})

test('disabled steps skip required-argument checks without disabling ordinary child steps', () => {
  const commands = { items: [{ actionCode: 'input', actionArgsVOS: [{ fieldKey: 'value', required: 1 }], targetArgsVOS: [] },
    { actionCode: 'codeBlock', actionArgsVOS: [], targetArgsVOS: [] }], oldSteps: [] }
  const disabled = { stepCode: 'disabled', stepName: '作废步骤', actionCode: 'input', status: 0 }
  assert.doesNotThrow(() => validateCandidate(session, { ...session.dsl, steps: [disabled] }, commands))
  assert.throws(() => validateCandidate(session, { ...session.dsl, steps: [{ ...disabled, status: 1 }] }, commands), /请填写/)
  const child = { stepCode: 'child', stepName: '仍执行的子步骤', actionCode: 'input' }
  assert.throws(() => validateCandidate(session, { ...session.dsl, steps: [{ ...disabled, children: [child] }] }, commands), /仍执行的子步骤/)
  assert.doesNotThrow(() => validateCandidate(session, { ...session.dsl, steps: [{ ...disabled, actionCode: 'codeBlock', body: [child] }] }, commands))
})
