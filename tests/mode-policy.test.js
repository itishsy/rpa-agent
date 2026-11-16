'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {Harness}=require('../src/agent/harness')
const {createTools}=require('../src/agent/tools')
const {modePolicy}=require('../src/agent/mode-policy')
function fixture(){
  let modelCalls=0
  const session={id:'s',scope:{},dsl:{steps:[]},revision:0,events:[],sequence:0,runs:[],messages:[],artifacts:{}}
  const registry=createTools({})
  const harness=new Harness({registry,store:{save(){}},complete:async()=>{modelCalls++;return {role:'assistant',content:'done'}}})
  return {session,harness,registry,modelCalls:()=>modelCalls}
}
test('three modes expose different tool capabilities, including an empty model surface for run-only',()=>{
  const {registry}=fixture()
  assert.deepEqual(registry.schemas('run'),[])
  assert.ok(!registry.schemas('generate').some(tool=>tool.function.name==='run_current_dsl'))
  assert.ok(registry.schemas('develop').some(tool=>tool.function.name==='run_current_dsl'))
  assert.equal(modePolicy('generate').writeToEditor,true)
  assert.equal(modePolicy('develop').writeToEditor,false)
  assert.throws(()=>modePolicy('constructor'),/未知/)
})
test('run-only bypasses the model and preserves editor, proposals and previous diagnostic turn',async()=>{
  const f=fixture(),{harness,session}=f
  session.turn={id:'prior',mode:'develop'};session.proposal={review:true}
  const original=structuredClone(session)
  const result=await harness.runOnly(session,async()=>({status:'finished'}))
  assert.equal(result.status,'finished');assert.equal(f.modelCalls(),0)
  assert.deepEqual(session.dsl,original.dsl);assert.deepEqual(session.proposal,original.proposal)
  assert.deepEqual(session.turn,original.turn);assert.equal(session.operation.mode,'run')
  assert.equal(session.operation.state,'completed');assert.equal(harness.nativeRuns.size,0)
  await assert.rejects(harness.start(session,'run',{mode:'run'}),/不能启动模型/)
})
test('run-only locks out duplicate execution and same-session generation until it settles',async()=>{
  const {harness,session}=fixture();let release,executed=0
  const pending=harness.runOnly(session,()=>{executed++;return new Promise(resolve=>{release=resolve})})
  await assert.rejects(harness.runOnly(session,()=>{executed++}),/仍在运行/)
  await assert.rejects(harness.start(session,'生成',{mode:'generate'}),/运行结束/)
  release();await pending
  assert.equal(executed,1);assert.equal(harness.nativeRuns.size,0)
})
test('uncertain native execution releases the UI lock and allows a new manual run',async()=>{
  const {harness,session}=fixture();let executed=0
  await assert.rejects(harness.runOnly(session,async()=>{
    executed++;session.executionUncertain={reason:'disconnected'};throw new Error('连接中断')
  }),/连接中断/)
  assert.equal(session.operation.state,'unknown');assert.equal(harness.nativeRuns.size,0)
  await harness.runOnly(session,async()=>{executed++})
  assert.equal(executed,2)
  assert.equal(session.operation.state,'completed')
})
test('run-and-diagnose cannot auto-apply a patch even when writeToEditor is requested',async()=>{
  const f=fixture()
  await f.harness.start(f.session,'分析现有现场',{mode:'develop',writeToEditor:true})
  assert.equal(f.session.turn.mode,'develop');assert.equal(f.session.turn.writeToEditor,false)
  assert.equal(f.modelCalls(),1)
})
