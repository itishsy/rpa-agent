'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {AgentRunner}=require('../src/agent-core/runner')
const {ToolRegistry}=require('../src/agent-core/tool-registry')
const {operationsProfile}=require('../src/agents/operations/policy')
const {createOperationsSession}=require('../src/agents/operations/session')
const {createRepairHandoff,requireRepairHandoff,describeHandoff}=require('../src/handoff/repair-handoff')
const row={baseServer:'http://source',appCode:'a',taskCode:'t',accountNumber:'account',clientId:7}
function session(){return createOperationsSession(row,'user',new Date('2026-11-08'),new Date('2026-11-09'))}

test('operations rejects accidental edit/execute registrations even when the model fabricates calls',async()=>{
  const {z}=require('zod');let writes=0,round=0
  const registry=new ToolRegistry({modePolicy:operationsProfile.modePolicy})
  for(const effect of ['edit','execute'])registry.add(effect,effect,z.object({}).strict(),effect,async()=>{writes++})
  const current=session()
  const runner=new AgentRunner({profile:operationsProfile,registry,store:{save(){}},complete:async input=>{
    assert.deepEqual(input.tools,[])
    if(round++)return {role:'assistant',content:'证据不足'}
    return {role:'assistant',tool_calls:['edit','execute'].map(name=>({id:name,type:'function',function:{name,arguments:'{}'}}))}
  }})
  await runner.start(current,'诊断任务')
  assert.equal(writes,0);assert.equal(current.turn.mode,'diagnose');assert.equal(current.dsl,undefined)
  assert.equal(current.messages.filter(message=>message.role==='tool'&&message.content.includes('不允许')).length,2)
  await assert.rejects(runner.start(session(),'诊断',{mode:'generate'}),/只读诊断/)
  await assert.rejects(runner.start({...session(),agentType:'development'},'诊断'),/Agent类型/)
})

test('operations context contains no development instructions or DSL scaffolding',()=>{
  const current=session();current.messages=[{role:'user',content:'定位未完成原因'}]
  const text=JSON.stringify(operationsProfile.prepareContext(current))
  assert.ok(text.includes('任务监控分析Agent'))
  assert.ok(!/get_business_context|propose_dsl_patch|仅生成步骤/.test(text))
})

test('repair handoff binds the task snapshot and carries tool evidence as untrusted context',()=>{
  const current=session();current.messages=[{role:'tool',tool_call_id:'detail',content:'{"error":"定位失败"}'}]
  const handoff=createRepairHandoff(current,'流程定位失败')
  const record={...row,analysisResult:{analysis:{state:'completed',category:'流程配置',flowConfigurationIssue:true,handoff}}}
  assert.equal(requireRepairHandoff(record).evidence[0].callId,'detail')
  assert.match(describeHandoff(handoff),/待核实线索/)
  assert.throws(()=>requireRepairHandoff({...record,accountNumber:'other'}),/任务已变化/)
  assert.throws(()=>requireRepairHandoff({...record,analysisResult:{analysis:{state:'completed',category:'等待操作'}}}),/流程配置诊断/)
})

test('core and operations modules do not import development implementations',()=>{
  for(const folder of ['agent-core','agents/operations']){
    const directory=path.join(__dirname,'../src',folder)
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      if(!entry.isFile()||!entry.name.endsWith('.js'))continue
      const text=fs.readFileSync(path.join(directory,entry.name),'utf8')
      assert.ok(!/require\(['"][^'"]*(?:development|agent\/tools|agent\/context)/.test(text),folder+'/'+entry.name)
    }
  }
})
