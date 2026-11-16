'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {Harness}=require('../src/agent/harness')
const {createTools}=require('../src/agent/tools')
const commands={items:[{actionCode:'input',actionName:'输入',actionArgsVOS:[{fieldKey:'value',required:1}],targetArgsVOS:[{fieldKey:'xpath',required:1}]}],oldSteps:[]}
function fixture(complete){
  const session={id:'s',scope:{appCode:'a',flowCode:'f'},dsl:{appCode:'a',flowCode:'f',steps:[]},revision:0,runs:[],messages:[],events:[],sequence:0,artifacts:{}}
  const registry=createTools({commands:async()=>commands})
  const harness=new Harness({registry,store:{save(){}},complete})
  return {session,harness,registry}
}
let serial=0
const call=(name,args={})=>({role:'assistant',content:'',tool_calls:[{id:'g-'+(++serial),type:'function',function:{name,arguments:JSON.stringify(args)}}]})
const patch={baseRevision:0,operations:[{op:'insert',index:0,step:{stepName:'输入账号（待补充）',actionCode:'input',status:0,targetArgs:{xpath:'//*[@id="account"]'}}}]}
test('premature analysis is redirected to a real disabled draft in the editor, without saving or executing',async()=>{
  let requests=0
  const {harness,session}=fixture(async input=>{
    requests++
    if(requests===1)return call('get_action_detail',{actionCode:'input'})
    if(requests===2)return {role:'assistant',content:'建议确认账号后再生成。'}
    if(requests===3){
      assert.equal(input.toolChoice.function.name,'propose_dsl_patch')
      assert.ok(!input.tools.some(item=>item.function.name==='get_subflow_context'))
      return call('propose_dsl_patch',patch)
    }
    return {role:'assistant',content:'步骤已写入左侧，待补充账号。'}
  })
  const original=structuredClone(session.dsl);session.savedBaseline=original
  await harness.start(session,'配置账号输入步骤',{mode:'generate',writeToEditor:true})
  assert.equal(session.state,'completed');assert.equal(session.dsl.steps.length,1)
  assert.equal(session.dsl.steps[0].status,0);assert.equal(session.dsl.steps[0].actionArgs?.value,undefined)
  assert.equal(session.revision,1);assert.equal(session.proposal,null)
  assert.deepEqual(session.savedBaseline,original);assert.equal(session.runs.length,0)
  assert.ok(session.events.some(item=>item.type==='workspace/generated'))
})
test('generation stops broad investigation with budget still available for a validated patch',async()=>{
  let requests=0
  const {harness,session}=fixture(async input=>{
    requests++
    if(requests<=8)return call('get_flow_context')
    if(requests===9){
      assert.ok(!input.tools.some(item=>item.function.name==='get_subflow_context'))
      assert.match(input.messages[0].content,/停止扩展调查/)
      return call('propose_dsl_patch',patch)
    }
    return {role:'assistant',content:'已生成'}
  })
  await harness.start(session,'生成输入步骤',{mode:'generate',writeToEditor:true})
  assert.equal(session.state,'completed');assert.equal(session.dsl.steps.length,1)
  assert.ok(session.turn.modelCalls<24)
})
test('text-only refusal cannot be reported as successful step generation',async()=>{
  const {harness,session}=fixture(async()=>({role:'assistant',content:'缺少操作目标。'}))
  await assert.rejects(harness.start(session,'生成步骤',{mode:'generate',writeToEditor:true}),/未生成步骤/)
  assert.equal(session.state,'failed');assert.equal(session.dsl.steps.length,0)
})
test('read-only generation remains advisory and a stale patch cannot overwrite local edits',async()=>{
  const {harness,session,registry}=fixture(async()=>{})
  session.readOnly=true;session.turn={}
  const tool=registry.get('propose_dsl_patch')
  await tool.run(structuredClone(patch),{session,harness,turn:{mode:'generate',writeToEditor:true}})
  assert.equal(session.dsl.steps.length,0);assert.equal(session.proposal.advisoryOnly,true)
  session.readOnly=false;session.revision=1
  await assert.rejects(tool.run(structuredClone(patch),{session,harness,turn:{mode:'generate',writeToEditor:true}}),/版本已变化/)
  assert.equal(session.dsl.steps.length,0)
})
