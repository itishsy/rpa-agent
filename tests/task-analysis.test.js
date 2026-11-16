const test = require('node:test')
const assert = require('node:assert/strict')
const { analyzeTask, localTime, resolveTask } = require('../src/services/task-analysis')
const { sanitize } = require('../src/services/task-analysis')

test('已停用户直接返回停用原因，不要求模型或数据源配置，也不定位缺失任务编号',async()=>{
  let result,saved;const progress=[]
  const reason=await analyzeTask({appName:'武汉-社保',accountNumber:'acc',taskStatus:' 已停用 ',taskComment:'用户不扫码'},null,{}, {
    now:new Date('2026-11-10T04:00:00Z'),snapshotAt:Date.parse('2026-11-10T03:59:00Z'),
    request:async()=>{throw Error('不应查询接口')},complete:async()=>{throw Error('不应调用模型')},
    store:{save:value=>saved=value},onResult:value=>result=value,onProgress:value=>progress.push(value)
  })
  assert.match(reason,/已停用/);assert.match(reason,/用户不扫码/)
  assert.equal(result.state,'completed');assert.equal(result.category,'任务调度')
  assert.equal(result.ruleCode,'TASK_DISABLED');assert.equal(result.modelCalls,0);assert.equal(result.tools,0)
  assert.equal(result.flowConfigurationIssue,false);assert.equal(result.handoff,undefined)
  assert.equal(saved.artifacts[result.details[0].evidenceId].facts[0].at,'2026-11-10T03:59:00.000Z')
  assert.equal(progress.at(-1).stage,'complete')
})

test('停用原因缺失或内嵌在状态中时直接给出准确结论，凭据不进入结果',async()=>{
  for(const [status,comment,expected] of [
    ['已停用','','当前任务列表未提供'],
    ['已停用（UKey未插入）','','UKey未插入'],
    ['已停用','Bearer private-token','[REDACTED]']
  ]){
    const reason=await analyzeTask({appName:'武汉-社保',accountNumber:'acc',taskStatus:status,taskComment:comment},null,{})
    assert.ok(reason.includes(expected));assert.ok(!reason.includes('private-token'))
  }
})

test('未明确停用的状态仍走正常分析，已取消的停用任务不发布结论',async()=>{
  for(const taskStatus of ['已启用','正在执行','未停用','未知','']){
    await assert.rejects(analyzeTask({appCode:'a',taskCode:'t',accountNumber:'acc',taskStatus},{},{}),/配置大模型/)
  }
  const controller=new AbortController();controller.abort()
  await assert.rejects(analyzeTask({appName:'武汉-社保',accountNumber:'acc',taskStatus:'已停用'},null,{},
    {signal:controller.signal,onResult:()=>assert.fail('不应回填已停止任务')}),/已停止/)
})

test('仅明确且唯一的流程配置分类允许显示接管入口',async()=>{
  for(const [text,allowed] of [
    ['定位参数失效。\n原因分类：流程配置',true],
    ['等待验证码。\n原因分类：等待操作',false],
    ['证据不足，不能确定是否为流程配置问题。',false],
    ['原因分类：流程配置\n原因分类：证据不足',false]
  ]){
    let analysis
    await analyzeTask({appCode:'a',taskCode:'t',accountNumber:'n'},{},{},{
      request:async()=>({data:[]}),complete:async()=>({completionStatus:'complete',message:{role:'assistant',content:text}}),onResult:value=>analysis=value
    })
    assert.equal(analysis.flowConfigurationIssue,allowed,text)
  }
})
test('诊断限定任务范围并拒绝任意模板uuid', async () => {
  const paths = [], replies = []
  let turn = 0
  const result = await analyzeTask({ appCode: 'a', taskCode: 't', accountNumber: 'n' }, {}, {}, {
    now: new Date('2026-11-06T16:00:00Z'),
    request: async (_server, path, body) => { paths.push({path, body}); return { data: [] } },
    complete: async (_settings, _key, input) => {
      replies.push(input.messages.slice())
      return { completionStatus: 'complete', message: turn++ ? { role: 'assistant', content: '证据不足' } : { role: 'assistant', content: '', tool_calls: [{id:'1',type:'function',function:{name:'column_rules',arguments:'{"uuid":"other"}'}}] } }
    }
  })
  assert.equal(result, '证据不足')
  assert.equal(paths.length, 3)
  assert.equal(paths[0].body.execEndTime, '2026-11-07 00:00:00')
  assert.match(replies[1].at(-1).content, /只能查询/)
  assert.ok(paths.every(item => !item.path.includes('declareOfferExportPage')))
})
test('执行、队列、截图工具严格绑定任务并脱敏配置',async()=>{
  const paths=[],contexts=[];let round=0
  const responses=[
    [['execution_detail',{executionCode:'own',flowCode:'flow'}]],
    [['task_config',{}],['execution_image',{fileId:'12'}]],
    [['execution_detail',{executionCode:'foreign',flowCode:'flow'}],['execution_image',{fileId:'99'}]]
  ]
  const reason=await analyzeTask({appCode:'a',taskCode:'t',accountNumber:'acc'}, {}, {}, {
    now:new Date('2026-11-07T04:00:00Z'),
    request:async(_,path,body)=>{
      paths.push(path)
      if(path.endsWith('executionList'))return {data:[{appCode:'a',taskCode:'t',accountNumber:'acc',executionCode:'own',flowCode:'flow',startTime:'2026-11-07 11:00:00'},
        {appCode:'other',taskCode:'t',executionCode:'foreign',flowCode:'flow',startTime:'2026-11-07 11:00:00',error:'FOREIGN_ERROR'},
        {appCode:'a',taskCode:'t',executionCode:'old',flowCode:'flow',startTime:'2026-11-01 11:00:00',error:'OLD_ERROR'}]}
      if(path.includes('execution/detail'))return {data:[{executionCode:'own',flowCode:'flow',stepCode:'s',error:'验证码等待',files:[{fileId:12}]}]}
      if(path.endsWith('Queue/page'))return {data:{rows:[{appCode:'other',taskCode:'t',declareAccount:'acc',error:'FOREIGN_QUEUE'}]}}
      if(path.includes('getRobotTaskConfigInfo'))return {args:[{argsKey:'loginPassword',argsValue:'do-not-send'}]}
      return {data:[]}
    },
    image:async(_,id)=>{assert.equal(id,'12');return 'data:image/png;base64,aGVsbG8='},
    complete:async(_,__,input)=>{
      contexts.push(JSON.stringify(input))
      const calls=responses[round++]
      return {completionStatus:'complete',message:calls?{role:'assistant',tool_calls:calls.map(([name,args],index)=>({id:'r'+round+'-'+index,type:'function',function:{name,arguments:JSON.stringify(args)}}))}:{role:'assistant',content:'未完成原因：验证码等待；建议完成验证。'}}
    }
  })
  assert.match(reason,/验证码/)
  assert.ok(paths.every(path=>!path.includes('foreign')&&!path.includes('old')))
  assert.ok(contexts.some(text=>text.includes('image_url')))
  assert.ok(contexts.every(text=>!text.includes('do-not-send')&&!text.includes('FOREIGN_ERROR')&&!text.includes('OLD_ERROR')&&!text.includes('FOREIGN_QUEUE')))
})
test('模型不支持图片时明确降级为文字证据',async()=>{
  let round=0,rejected=false,finalText=''
  await analyzeTask({appCode:'a',taskCode:'t',accountNumber:'acc'}, {}, {}, {
    now:new Date('2026-11-07T04:00:00Z'),
    request:async(_,path)=>({data:path.endsWith('executionList')?[{appCode:'a',taskCode:'t',executionCode:'e',flowCode:'f',startTime:'2026-11-07 11:00:00'}]:path.includes('execution/detail')?[{executionCode:'e',flowCode:'f',stepCode:'s',files:[{fileId:1}]}]:[]}),
    image:async()=> 'data:image/png;base64,aGVsbG8=',
    complete:async(_,__,input)=>{
      if(JSON.stringify(input).includes('image_url')){rejected=true;throw new Error('400 unsupported image')}
      const next=[['execution_detail',{executionCode:'e',flowCode:'f'}],['execution_image',{fileId:'1'}]][round++]
      if(next)return {completionStatus:'complete',message:{role:'assistant',tool_calls:[{id:'i'+round,type:'function',function:{name:next[0],arguments:JSON.stringify(next[1])}}]}}
      finalText=JSON.stringify(input)
      return {completionStatus:'complete',message:{role:'assistant',content:'证据缺口：当前模型不支持截图识别。'}}
    }
  })
  assert.equal(rejected,true);assert.match(finalText,/图像输入不受/)
})
test('停止分析会中断模型且不发布晚到结论',async()=>{
  const controller=new AbortController();let started
  const reached=new Promise(resolve=>{started=resolve})
  const promise=analyzeTask({appCode:'a',taskCode:'t',accountNumber:'acc'}, {}, {}, {
    signal:controller.signal,request:async()=>({data:[]}),complete:async()=>{started();return new Promise(()=>{})}
  })
  await reached;controller.abort()
  await assert.rejects(promise,/已停止/)
})
test('配置 JSON 字符串和动态密码字段不进入模型证据',()=>{
  const value=sanitize({stepData:'{"password":"secret","period":"2026-11"}',args:[{fieldKey:'password',fieldValue:'credential'}]})
  assert.equal(value.stepData.password,'[REDACTED]');assert.equal(value.stepData.period,'2026-11')
  assert.equal(value.args[0].fieldValue,'[REDACTED]')
})
test('缺少缴费任务标识时仅采用同应用同客户同账户的唯一任务',async()=>{
  const row={appName:'武汉-社保',accountNumber:'account',customerId:'cust'}
  const read=async()=>({data:[{appCode:'a',taskCode:'t',appName:row.appName,accountNumber:'account',custId:'cust'},
    {appCode:'bad',taskCode:'other',appName:row.appName,accountNumber:'account',custId:'other'}]})
  assert.equal((await resolveTask(row,read)).taskCode,'t')
  await assert.rejects(resolveTask(row,async()=>({data:[{appCode:'a',taskCode:'t',...row,custId:'cust'},{appCode:'a',taskCode:'other',...row,custId:'cust'}]})),/唯一定位/)
})
test('工具预算耗尽仍输出文字建议，且从不开放业务执行工具',async()=>{
  let calls=0,summary
  const text=await analyzeTask({appCode:'a',taskCode:'t',accountNumber:'acc'}, {}, {}, {
    request:async()=>{calls++;return {data:[]}},onResult:value=>{summary=value},
    complete:async(_,__,input)=>{
      assert.ok(input.tools.every(tool=>!/^run_|save|revoke|execute/.test(tool.function.name)))
      if(input.finalOnly)return {completionStatus:'complete',message:{role:'assistant',content:'证据不足；建议核对原始失败步骤，未重复提交。'}}
      return {completionStatus:'complete',message:{role:'assistant',tool_calls:Array.from({length:4},(_,index)=>({id:'loop-'+calls+'-'+index,type:'function',function:{name:'queue_status',arguments:'{}'}}))}}
    }
  })
  assert.match(text,/建议/);assert.ok(calls<=16);assert.equal(summary.state,'budget_exhausted')
})
test('模型连接失败保留可操作建议，不声称确定业务原因',async()=>{
  let result
  const text=await analyzeTask({appCode:'a',taskCode:'t',accountNumber:'acc'}, {}, {}, {
    request:async()=>({data:[]}),onResult:value=>{result=value},complete:async()=>{throw new Error('模型连接失败')}
  })
  assert.match(text,/暂不能确定/);assert.match(text,/建议/);assert.equal(result.state,'failed')
})
test('缺少任务范围时不发出请求', async () => {
  await assert.rejects(analyzeTask({}, {}, {}), /缺少/)
  assert.equal(localTime(new Date('2026-11-06T16:00:00Z')), '2026-11-07 00:00:00')
})

test('未配置模型时不查询业务接口', async () => {
  await assert.rejects(analyzeTask({appCode:'a',taskCode:'t',accountNumber:'n'}, {}, {}, {request:async()=>{throw new Error('不应查询')}}), /配置大模型/)
})
test('Harness使用当前模型连续取证并返回最终结论', async () => {
  const settings={modelBaseUrl:'http://model/v1',modelName:'configured-model',modelApiKey:'test-key'}
  const progress=[],paths=[]
  let round=0
  const reason=await analyzeTask({appCode:'a',taskCode:'t',accountNumber:'n',addrId:1,businessType:1}, {}, settings, {
    request:async(_server,path)=>{paths.push(path);return path.endsWith('/page')?{data:{rows:[{uuid:'allowed'}]}}:{data:[]}},
    onProgress:event=>progress.push(event),
    complete:async(config,key,input)=>{
      assert.equal(config.modelName,'configured-model');assert.equal(key,'test-key')
      const names=['offer_templates','column_rules']
      if(round<2){const name=names[round++];return {completionStatus:'complete',message:{role:'assistant',content:'',tool_calls:[{id:String(round),type:'function',function:{name,arguments:name==='column_rules'?' {"uuid":"allowed"}':'{}'}}]}}}
      assert.ok(input.messages.some(message=>message.role==='tool'))
      return {completionStatus:'complete',message:{role:'assistant',content:'未完成原因：证据不足；建议核对队列。'}}
    }
  })
  assert.match(reason,/未完成原因/)
  assert.ok(paths.includes('policy/offerSettings/columnRuleList/allowed'))
  assert.ok(progress.some(event=>event.stage==='tool'))
  assert.equal(progress.at(-1).stage,'complete')
})

test('未执行任务核对有效计划、申报期和入队约束，隔离其他账户及地区',async()=>{
  const requests=[],contexts=[];let turn=0,result
  await analyzeTask({appCode:'a',taskCode:'t',accountNumber:'acc',clientId:7,machineCode:'m',addrId:9,businessType:1},{},{},{
    now:new Date('2026-11-09T04:00:00Z'),onResult:value=>result=value,
    request:async(_,path,body)=>{
      requests.push({path,body})
      if(path.includes('showServiceItemFlow'))return {data:[{serviceItem:1,status:1,execPlant:'每月15-20号',noDeclaredCount:3}]}
      if(path.includes('getRobotPlant'))return {data:[
        {appCode:'a',taskCode:'t',accountNumber:'acc',scheduleList:[{appCode:'a',taskCode:'t',execCycle:'15-20',execStyle:3},{appCode:'a',taskCode:'other',comment:'FOREIGN_PLAN'}]},
        {appCode:'a',taskCode:'other',accountNumber:'other',comment:'FOREIGN_ACCOUNT'}]}
      if(path.includes('getPolicyAddrDeadlineSettings'))return {data:[
        {addrId:9,businessType:1,declareType:1,monthBegin:0,monthEnd:0,dayBegin:15,dayEnd:20},
        {addrId:8,businessType:1,declareType:1,comment:'FOREIGN_REGION'}]}
      if(path.includes('getRobotTaskConfigInfo'))return {data:[{groupName:'登录',args:[{argsKey:'declareWebsite',argsValue:'site'}]}]}
      return {data:[]}
    },
    complete:async(_,__,input)=>{
      contexts.push(JSON.stringify(input))
      const batches=[['execution_plan','declaration_period','queue_rules','export_constraints'],['task_config'],['offer_rules']]
      const batch=batches[turn++]
      if(batch)return {completionStatus:'complete',message:{role:'assistant',tool_calls:batch.map(name=>({id:name,type:'function',function:{name,arguments:'{}'}}))}}
      return {completionStatus:'complete',message:{role:'assistant',content:'执行计划尚未匹配；申报期是否限制报盘需核实客户开关。\n原因分类：任务调度'}}
    }
  })
  assert.ok(requests.some(({path})=>path==='robot/app/client/getRobotPlant/7/m/a?searchText=acc'))
  assert.ok(requests.some(({path})=>path==='policy/agent/getPolicyAddrDeadlineSettings/9/1'))
  assert.ok(requests.some(({path,body})=>path==='robot/offerRule/list'&&body.declareWebsite==='site'))
  assert.ok(contexts.every(text=>!text.includes('FOREIGN_')))
  assert.ok(contexts.at(-1).includes('declareExpRule=0'))
  assert.equal(result.category,'任务调度');assert.equal(result.flowConfigurationIssue,false)
})

test('独立部署政策接口不可用及缺少设备时记录缺口，不跨数据源猜测',async()=>{
  let turn=0,finalInput;const paths=[]
  await analyzeTask({appCode:'a',taskCode:'t',accountNumber:'acc',addrId:9,businessType:1},{},{},{
    request:async(_,path)=>{paths.push(path);if(path.includes('getPolicyAddrDeadlineSettings'))throw Error('HTTP 404');return {data:[]}},
    complete:async(_,__,input)=>{
      if(!turn++)return {completionStatus:'complete',message:{role:'assistant',tool_calls:['execution_plan','declaration_period'].map(name=>({id:name,type:'function',function:{name,arguments:'{}'}}))}}
      finalInput=JSON.stringify(input);return {completionStatus:'complete',message:{role:'assistant',content:'政策接口不可用，无法确定申报期。\n原因分类：证据不足'}}
    }
  })
  assert.match(finalInput,/HTTP 404/);assert.match(finalInput,/缺少客户编号或设备编号/)
  assert.ok(paths.every(path=>!path.includes('getRobotPlant')))
})
