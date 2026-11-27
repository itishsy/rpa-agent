'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {buildDebugDsl,loadReferencedDebugFlows}=require('../src/services/debug-dsl')
const {buildDslDocument}=require('../src/services/dsl-document')
const row=(code,actionCode='page',extra={})=>({stepCode:code,stepName:code,actionCode,...extra})

test('viewed DSL is identical to the IDE builder for root metadata, nested steps, blocks and recursive subflows',async()=>{
  const ideFile=path.resolve(__dirname,'../../rpa-ide/src/utils/debugDsl.js')
  const ide=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(ideFile,'utf8')).toString('base64'))
  const metadata={appName:'应用',flowName:'主流程',appArgs:'{"unit":"demo"}',declareSystem:'系统',serviceItem:'1',tagCode:'tag',
    runSupport:'browser',sessionKeep:'1',serverId:100}
  const rows=[row('页面','page',{status:1,failedRetry:1,failedStrategy:0,waitBefore:0,waitAfter:2,timeout:30,
    actionArgs:'{"url":"https://example.test"}',actionArgsVOS:[{fieldKey:'url',fieldValue:'https://example.test',isHideCust:false}]}),
    row('判断','match',{failedSkipTo:'代码块',list:[row('点击','click',{targetArgs:'{"xpath":"//button"}'})]}),
    row('代码块','codeBlock',{list:[row('块内输入','input',{actionArgs:{value:'demo'}})]}),
    row('调用登录','subFlow',{actionArgs:{flowName:'登录'}})]
  const flows=[{flowCode:'main',flowName:'主流程'},{flowCode:'login',flowName:'登录'},{flowCode:'leaf',flowName:'刷新'}]
  const source={listFlows:async()=>flows,getFlow:async code=>flows.find(flow=>flow.flowCode===code),
    listSteps:async flow=>flow.flowCode==='login'?[row('调用刷新','subFlow',{actionArgs:{flowName:'刷新'}})]:[row('刷新页面')]}
  const expected=await ide.loadReferencedDebugFlows(ide.buildDebugDsl('app','main',metadata,rows),'app',source)
  const bundle=await loadReferencedDebugFlows(buildDebugDsl('app','main',metadata,rows),'app',source,{inspect:true})
  bundle.editorRows=[];bundle.steps[0].level=0;bundle.steps[0].status=1;bundle.steps[0].failedRetry=1
  const actual=buildDslDocument(bundle)
  assert.deepEqual(actual,expected)
  assert.ok(actual.steps[1].children);assert.ok(actual.steps[2].body)
  assert.deepEqual(actual.subflows.map(flow=>Object.keys(flow)),[['flowCode','flowName','steps'],['flowCode','flowName','steps']])
  assert.ok(!Object.hasOwn(actual,'inspectionDiagnostics'));assert.ok(!Object.hasOwn(actual,'editorRows'))
})

test('empty drafts and inspection warnings do not contaminate the IDE-shaped JSON document',()=>{
  const bundle={appCode:'app',appName:'应用',flowCode:'flow',flowName:'新流程',steps:[],inspectionDiagnostics:[{message:'missing'}],serverId:123}
  assert.deepEqual(buildDslDocument(bundle),{appCode:'app',appName:'应用',flowCode:'flow',flowName:'新流程',steps:[],subflows:[]})
  assert.equal(bundle.inspectionDiagnostics.length,1)
})
