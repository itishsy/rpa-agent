const test = require('node:test')
const assert = require('node:assert/strict')
const { analyzeTask, localTime, resolveTask } = require('../src/services/task-analysis')
const { sanitize } = require('../src/services/task-analysis')
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
  assert.equal(paths.length, 2)
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
