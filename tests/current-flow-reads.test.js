'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {flowMetadata,dslMetadata}=require('../src/services/flow-metadata')
const {createTools}=require('../src/agents/development/tools')
test('flow reads strip retired template and chart fields while preserving sequential controls and business data',async()=>{
  const old={flowCode:'login',flowName:'登录',templateFlowCode:'old',relationFlowCode:'other',loginFlowFlag:1,
    graphJson:'old',nodes:[],edges:[],appArgs:{templateFlowCode:'old',nodes:['business-node']},
    steps:[{stepCode:'one',stepName:'判断',actionCode:'match',skipTo:'下一步',falseSkipTo:'NEXT',flowGraph:'old'}]}
  const clean=dslMetadata(old)
  assert.equal(clean.steps[0].skipTo,'下一步');assert.equal(clean.steps[0].falseSkipTo,'NEXT')
  assert.deepEqual(clean.appArgs.nodes,['business-node'])
  for(const key of ['templateFlowCode','relationFlowCode','loginFlowFlag','graphJson','nodes','edges'])assert.equal(Object.hasOwn(clean,key),false)
  assert.ok(Object.hasOwn(old,'templateFlowCode'))
  const tools=createTools({flows:async()=>[old]})
  const result=await tools.get('get_flow_context').run({}, {session:{dsl:old,revision:1}})
  assert.equal(Object.hasOwn(result.dsl,'templateFlowCode'),false)
  const flows=await tools.get('list_app_flows').run({}, {session:{}})
  assert.deepEqual(flows[0],flowMetadata(old))
})
test('active flow readers have no retired lookup endpoints, request parameters or chart renderer',()=>{
  const root=path.resolve(__dirname,'../src')
  for(const file of ['main.js','services/debug-dsl.js','renderer/management.js','services/business.js','renderer/resources.js']){
    const source=fs.readFileSync(path.join(root,file),'utf8')
    for(const forbidden of ['robot/flow/listTemplate','templateType:','params: { templateFlowCode','flow.relationFlowCode'])assert.ok(!source.includes(forbidden),file+': '+forbidden)
  }
  assert.ok(!fs.readFileSync(path.join(root,'renderer/app.js'),'utf8').includes("action('flowGraph'"))
})
