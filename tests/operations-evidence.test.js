'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {createOperationsTools}=require('../src/agents/operations/tools')
const {executionFailures,queueObservation}=require('../src/agents/operations/evidence-model')
const row={appCode:'a',taskCode:'t',accountNumber:'acc',clientId:7}
const now=new Date('2026-11-09T04:00:00Z')
function fixture(request,overrides={}) {
  const session={artifacts:{},runs:[]},state={images:new Map()},requests=[]
  const registry=createOperationsTools({row:{...row,...overrides},server:{},dependencies:{},session,state,start:new Date(now-86400000),end:now,
    readRaw:async(path,body)=>{requests.push({path,body});return request(path,body)}})
  const harness={artifact(_,value){const id='evidence-'+Object.keys(session.artifacts).length;session.artifacts[id]=value;return id}}
  const run=async(name,args={})=>{const tool=registry.get(name);return tool.run(tool.validate(args),{harness,signal:new AbortController().signal})}
  return {registry,run,state,requests,session}
}

test('真实入队记录使用固定查询，隔离其他客户和过期快照并提取具体拒绝结果',async()=>{
  const f=fixture(()=>({data:[
    {id:'own',taskCode:'t',taskVO:{...row,password:'private'},createTime:'2026-11-09 11:00:00',message:'调用入队列',otherData:{code:500,msg:'uKey未配置或uKey非可用状态',token:'private'}},
    {taskCode:'t',taskVO:{...row,clientId:8},createTime:'2026-11-09 11:00:00',message:'FOREIGN'},
    {taskCode:'t',taskVO:row,createTime:'2026-11-01 11:00:00',message:'OLD'}]}))
  const result=await f.run('queue_generation_records')
  assert.deepEqual(f.requests[0].body,{taskCode:'t','taskVO.clientId':7,'taskVO.appCode':'a'})
  assert.equal(result.records.length,1)
  assert.ok(result.facts.some(fact=>fact.code==='UKEY_UNAVAILABLE'&&fact.resultCode===500))
  assert.ok(!/private|FOREIGN|OLD/.test(JSON.stringify(result)))
  assert.ok(f.session.artifacts[result.evidenceId])
})

test('出队记录绑定已发现队列，保留规则和设备时间，并计算队列已等待30分钟',async()=>{
  const f=fixture(path=>path.endsWith('Queue/page')?{data:{rows:[{...row,declareAccount:'acc',status:2,executionCode:'queue',createTime:'2026-11-09 11:30:00'}]}}:
    {data:{rows:[{executionCode:'queue',machineCode:'m',pullTime:'2026-11-09 11:59:00',message:'同一申报户同一系统不能同时执行不能出队列'},
      {executionCode:'foreign',pullTime:'2026-11-09 11:59:00',message:'FOREIGN'}]}})
  await assert.rejects(f.run('queue_pull_records',{executionCode:'queue'}),/先读取/)
  assert.equal(f.requests.length,0)
  const queued=await f.run('queue_status')
  assert.equal(queued.facts[0].waitingMinutesAtObservation,30)
  const pulled=await f.run('queue_pull_records',{executionCode:'queue'})
  assert.equal(pulled.facts[0].code,'ACCOUNT_SYSTEM_MUTEX');assert.equal(pulled.facts[0].machineCode,'m')
  assert.equal(pulled.records.length,1);assert.match(pulled.coverage,/提前返回/)
  assert.equal(f.requests[1].body.query[0].value,'queue')
})

test('认证未登录只报告等待登录，UKey和执行器只返回本客户本任务证据',async()=>{
  const f=fixture(path=>{
    if(path.includes('pageList'))return {data:{rows:[{...row,declareAccount:'单位-acc',processStatus:0,loginStatus:0},
      {...row,taskCode:'other',declareAccount:'单位-acc',comment:'FOREIGN'}]}}
    if(path.includes('usbAccountPage'))return {data:{rows:[{...row,declareAccount:'acc',status:4,disabled:1,password:'private'},
      {...row,clientId:8,declareAccount:'acc',remark:'FOREIGN'}]}}
    return {data:[{clientId:7,machineCode:'m',status:2,token:'private'},{clientId:8,machineCode:'foreign'}]}
  })
  const auth=await f.run('login_auth_status'),usb=await f.run('ukey_bindings'),devices=await f.run('executor_status')
  assert.equal(auth.facts[0].code,'PENDING_LOGIN');assert.ok(!JSON.stringify(auth.facts).includes('SCAN_WAIT'))
  assert.equal(usb.records[0].status,4);assert.equal(devices.records[0].status,2)
  for(const result of [auth,usb,devices])assert.ok(!/private|FOREIGN|foreign/.test(JSON.stringify(result)))
})

test('证据接口失败返回缺口；缺客户编号不查询跨租户快照',async()=>{
  const f=fixture(()=>{throw Error('HTTP 403')})
  const result=await f.run('queue_generation_records')
  assert.equal(result.unavailable,true);assert.match(result.message,/403/);assert.equal(result.facts,undefined)
  const missing=fixture(()=>{throw Error('不应调用')},{clientId:null})
  for(const name of ['queue_generation_records','ukey_bindings','executor_status'])assert.equal((await missing.run(name)).unavailable,true)
  assert.equal(missing.requests.length,0)
})

test('执行异常明细按时间排序，区分点击、扫码和UKey识别现象而不强判根因',()=>{
  const facts=executionFailures([
    {stepCode:'click',stepName:'点击申报',status:0,error:'找不到按钮',startTime:'2026-11-09 11:05:00'},
    {stepCode:'scan',status:0,error:'等待用户扫码超时',startTime:'2026-11-09 11:01:00'},
    {stepCode:'usb',status:0,error:'未识别到UKey',startTime:'2026-11-09 11:06:00'},
    {stepCode:'unknown',status:null}])
  assert.deepEqual(facts.map(item=>item.code),['SCAN_WAIT','CLICK_FAILED','UKEY_RECOGNITION_FAILED'])
  assert.ok(facts.every(item=>item.symptomOnly))
  for(const record of [{status:1,createTime:'2026-11-09 11:00:00'},{status:2,createTime:'bad'},{status:2,createTime:'2027-01-01 00:00:00'}])
    assert.equal(queueObservation(record,now).waitingMinutesAtObservation,null)
})
