'use strict'
const {app,BrowserWindow,nativeImage}=require('electron')
app.disableHardwareAcceleration()
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict')
const {localTime}=require('../src/services/task-analysis')
const artifacts=path.resolve(__dirname,'../artifacts');fs.mkdirSync(artifacts,{recursive:true})
process.env.RPA_AGENT_TEST_DATA=fs.mkdtempSync(path.join(artifacts,'task-analysis-data-'))
const requests=[],errors=[];let holdModel=false,modelEntered=false,imageReceived=false,flowIssue=false
const sourceRows=[0,1].map(i=>({id:i+1,appCode:'app',appName:'武汉-社保',taskCode:'task'+i,accountNumber:'unit'+i,
  customerName:i?'其他客户':'测试客户',clientId:1,addrId:7,businessType:1,taskStatus:'已启用',noDeclaredCount:1,auditCount:0}))
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk
  const url=new URL(req.url,'http://local'),p=url.pathname,body=raw?JSON.parse(raw):{}
  requests.push({path:p,body})
  const reply=data=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:200,data}))}
  try{
    if(p==='/v1/chat/completions'){
      assert.equal(req.headers.authorization,'Bearer model-key');assert.equal(body.model,'configured-analysis-model')
      assert.ok(!raw.includes('task-password-secret'))
      if(body.messages.some(message=>message.role==='assistant'&&message.tool_calls?.length&&typeof message.reasoning_content!=='string')){
        res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'The reasoning_content in the thinking mode must be passed back'}}));return
      }
      modelEntered=true;if(holdModel)return
      const names=new Set(body.messages.flatMap(message=>(message.tool_calls||[]).map(call=>call.function.name)))
      let calls
      if(!names.has('execution_detail'))calls=[['execution_detail',{executionCode:'execution0',flowCode:'flow'}]]
      else if(!names.has('offer_templates'))calls=[['task_config',{}],['offer_templates',{}]]
      else if(!names.has('column_rules'))calls=[['column_rules',{uuid:'template'}],['template_detail',{uuid:'template'}]]
      else if(!names.has('execution_image'))calls=[['execution_image',{fileId:'1'}]]
      else if(!names.has('queue_pull_records'))calls=[['queue_generation_records',{}],['queue_pull_records',{executionCode:'queue0'}],['login_auth_status',{}],['ukey_bindings',{}],['executor_status',{}]]
      else {imageReceived=body.messages.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url'));assert.equal(imageReceived,true,JSON.stringify(body.messages.filter(message=>message.role==='tool').slice(-2)))}
      const message=calls?{role:'assistant',content:'',reasoning_content:'mock provider reasoning',tool_calls:calls.map(([name,args],index)=>({id:name+'-'+index,type:'function',function:{name,arguments:JSON.stringify({...args,_purpose:'确认'+name+'对应的未完成证据'})}}))}
        :{role:'assistant',content:flowIssue?'未完成原因：流程定位参数失效。\n原因分类：流程配置':'未完成原因：验证码等待未完成。\n依据：execution0 的登录步骤提示等待验证码。\n建议：完成验证码后核对原任务状态。\n缺失证据：业务最终办结凭证尚未取得。\n原因分类：等待操作'}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:calls?'tool_calls':'stop',message}]}));return
    }
    if(p.endsWith('/oauth/token'))return reply({access_token:'test-token',custId:1,custName:'测试客户',expires_in:3600})
    if(p.endsWith('/oauth/check_token'))return reply({active:true,exp:Date.now()/1000+3600})
    if(p.endsWith('/sys/user/menu/listMenuByUser/1'))return reply({menus:[],tabs:[],buttons:[]})
    if(p.endsWith('/robot/app/getAppData'))return reply({rows:[],total:0})
    if(p.endsWith('/robot/start/status'))return reply(0)
    if(p.endsWith('/robot/app/client/list'))return reply(sourceRows)
    if(p.includes('/showServiceItemFlow/'))return reply([{serviceItemName:'增员',noDeclaredCount:1}])
    if(p.includes('/getRobotTaskConfigInfo/'))return reply({args:[{argsKey:'loginPassword',argsValue:'task-password-secret'},{argsKey:'socialLoginType',fieldName:'社保登录方式',argsValue:'验证码'}]})
    if(p.endsWith('/executionList')){
      assert.equal(body.taskCode,'task0');assert.ok(body.execStartTime&&body.execEndTime)
      return reply([{...sourceRows[0],executionCode:'execution0',flowCode:'flow',startTime:localTime(new Date(Date.now()-60000)),status:0,error:'等待验证码'}])
    }
    if(p.endsWith('/taskQueue/page')){
      assert.equal(body.query.find(item=>item.property==='taskCode').value,'task0')
      return reply({rows:[{appCode:'app',taskCode:'task0',clientId:1,declareAccount:'unit0',executionCode:'queue0',status:2,createTime:localTime(new Date(Date.now()-30*60000))}],total:1})
    }
    if(p.endsWith('/findTaskQueueGenerate')){assert.deepEqual(body,{taskCode:'task0','taskVO.clientId':1,'taskVO.appCode':'app'});return reply([{id:'gen',taskCode:'task0',taskVO:{appCode:'app',taskCode:'task0',clientId:1},createTime:localTime(new Date(Date.now()-10000)),message:'执行计划于当前时间不匹配，不自动生成'}])}
    if(p.endsWith('/getPullPage'))return reply({rows:[{executionCode:'queue0',machineCode:'m',pullTime:localTime(new Date(Date.now()-10000)),message:'同一申报户同一系统不能同时执行不能出队列'}],total:1})
    if(p.endsWith('/loginAuth/pageList'))return reply({rows:[{appCode:'app',taskCode:'task0',clientId:1,accountNumber:'unit0',processStatus:0,loginStatus:0}],total:1})
    if(p.endsWith('/usbAccountPage'))return reply({rows:[{appCode:'app',taskCode:'task0',clientId:1,declareAccount:'unit0',status:4}],total:1})
    if(p.endsWith('/getByClientId/1'))return reply([{clientId:1,machineCode:'m',status:2}])
    if(p.endsWith('/client/execution/detail'))return reply([{executionCode:'execution0',flowCode:'flow',stepCode:'login',stepName:'验证码登录',error:'等待验证码',files:[{fileId:1}]}])
    if(p.endsWith('/offerSettings/page'))return reply({rows:[{uuid:'template',addrId:7,businessType:1}],total:1})
    if(p.endsWith('/getPolicyAddrDeadlineSettings/7/1'))return reply([{addrId:7,businessType:1,declareType:1,monthBegin:0,monthEnd:0,dayBegin:15,dayEnd:20}])
    if(p.includes('/offerSettings/columnRuleList/'))return reply([{fieldName:'示例字段',rule:'非空'}])
    if(p.includes('/offerSettings/findByUuid/'))return reply({uuid:'template',addrId:7,businessType:1})
    if(p.endsWith('/policy/sys/file/download/1')){
      assert.equal(req.method,'GET');assert.equal(req.headers.authorization,'Bearer test-token')
      res.setHeader('Content-Type','image/png');res.end(nativeImage.createFromBitmap(Buffer.from([0,0,255,255]),{width:1,height:1}).toPNG());return
    }
    throw new Error('Unexpected endpoint '+p)
  }catch(error){errors.push(error.message);res.writeHead(500);res.end(JSON.stringify({message:error.message}))}
})
const deadline=setTimeout(()=>{console.error('Task analysis acceptance timed out');app.exit(1)},60000)
app.on('web-contents-created',(_,contents)=>contents.on('preload-error',(_,file,error)=>errors.push(file+': '+error.message)))
app.on('browser-window-created',(_,win)=>win.webContents.once('did-finish-load',async()=>{
  if(!win.webContents.getURL().endsWith('/index.html'))return
  const run=code=>win.webContents.executeJavaScript(code,true)
  const wait=async code=>{for(let i=0;i<200;i++){if(await run(code))return;await new Promise(resolve=>setTimeout(resolve,30))}throw new Error('Timed out '+code)}
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint='http://127.0.0.1:'+server.address().port
    await run(`desktop.invoke('auth:login',{baseUrl:${JSON.stringify(endpoint+'/api')},username:'test',password:'offline'})`)
    await run(`desktop.invoke('settings:save',{remoteEnabled:true,connections:[{baseUrl:${JSON.stringify(endpoint)},debugToken:'debug-test'}],modelBaseUrl:${JSON.stringify(endpoint+'/v1')},modelName:'configured-analysis-model',modelApiKey:'model-key'})`)
    await run(`desktop.invoke('undeclared:save-settings',{keywords:['武汉-社保'],servers:[{baseServer:${JSON.stringify(endpoint)},username:'monitor',password:'monitor-secret'}]})`)
    await run('setView("taskMonitor")');await wait('window.taskMonitor?.allRows.length===2&&!taskMonitor.refreshing')
    assert.equal(await run('taskMonitor.elements.tableBody.querySelectorAll(".monitor-analyze-task").length'),2)
    assert.equal(await run('taskMonitor.elements.tableBody.querySelector(".monitor-reason-cell").textContent'),'未分析')
    assert.equal(await run('!!taskMonitor.elements.tableBody.querySelector(".monitor-actions .monitor-analyze-task")'),true)
    await run('taskMonitor.elements.tableBody.querySelector(".monitor-analyze-task").click()')
    await wait('!$("monitorHost").shadowRoot.getElementById("analyzeButton").disabled')
    assert.ok(await run('taskMonitor.allRows[0].analysisAttempted'))
    assert.equal(await run('taskMonitor.allRows[1].analysisAttempted'),undefined)
    assert.equal(await run('taskMonitor.elements.tableBody.querySelectorAll(".monitor-analyze-task").length'),1)
    await run(`(()=>{const root=$('monitorHost').shadowRoot;root.querySelector('.filter-field').value='customerName';root.querySelector('.filter-keyword').value='测试客户';taskMonitor.elements.filterForm.requestSubmit()})()`)
    assert.equal(await run('taskMonitor.elements.tableBody.rows.length'),1)
    assert.equal(await run('$("monitorHost").shadowRoot.querySelectorAll("th")[5].textContent'),'未完成原因')
    assert.match(await run('taskMonitor.elements.tableBody.querySelector(".monitor-reason").textContent'),/验证码等待/)
    assert.ok(!/依据|建议|缺失证据|原因分类/.test(await run('taskMonitor.elements.tableBody.querySelector(".monitor-reason").textContent')))
    assert.equal(await run('taskMonitor.elements.tableBody.querySelector(".monitor-evidence").open'),false)
    await run('taskMonitor.elements.tableBody.querySelector(".monitor-evidence summary").click()')
    assert.equal(await run('taskMonitor.elements.tableBody.querySelector(".monitor-evidence").open'),true)
    assert.match(await run('taskMonitor.elements.tableBody.querySelector(".monitor-analysis-full").textContent'),/业务最终办结凭证/)
    await run('taskMonitor.elements.tableBody.querySelector(".monitor-evidence summary").click()')
    assert.equal(await run('taskMonitor.allRows[1].incompleteReason==null'),true)
    assert.equal(await run('taskMonitor.elements.tableBody.querySelector(".monitor-takeover").disabled'),false)
    assert.match(await run('taskMonitor.elements.tableBody.querySelector(".monitor-evidence").textContent'),/已等待 30 分钟/)
    assert.match(await run('taskMonitor.elements.tableBody.querySelector(".monitor-evidence").textContent'),/同一申报户同一系统/)
    const modelReads=()=>requests.filter(item=>item.path==='/v1/chat/completions').length
    let reads=modelReads()
    await run('$("monitorHost").shadowRoot.getElementById("analyzeButton").click()')
    await wait('!$("monitorHost").shadowRoot.getElementById("analyzeButton").disabled')
    assert.equal(modelReads(),reads)
    await run('taskMonitor.refreshData()')
    await wait('!taskMonitor.refreshing')
    assert.match(await run('taskMonitor.allRows[0].incompleteReason'),/验证码等待/)
    flowIssue=true
    await run('taskMonitor.elements.tableBody.querySelector(".monitor-analysis-controls button").click()')
    await wait('!$("monitorHost").shadowRoot.getElementById("analyzeButton").disabled')
    assert.equal(await run('taskMonitor.elements.tableBody.querySelectorAll(".monitor-takeover").length'),1,await run('JSON.stringify(taskMonitor.allRows[0].analysisResult)'))
    assert.equal(await run('taskMonitor.allRows[1].incompleteReason==null'),true)
    assert.equal(await run('$("monitorHost").shadowRoot.querySelector("#analysisPanel,#analysisResults,#analysisStatus")'),null)
    assert.ok(imageReceived)
    assert.ok(requests.every(item=>!item.path.includes('declareOfferExportPage')&&!item.path.includes('/revoke')&&!item.path.includes('/remoteTask')))
    fs.writeFileSync(path.join(artifacts,'task-analysis-main.png'),(await win.webContents.capturePage()).toPNG())
    const folder=path.join(process.env.RPA_AGENT_TEST_DATA,'task-analysis')
    const checkpoints=fs.readdirSync(folder).filter(name=>name.endsWith('.session'))
    assert.ok(checkpoints.length>0)
    assert.ok(!fs.readFileSync(path.join(folder,checkpoints[0]),'utf8').includes('验证码等待'))
    holdModel=true;modelEntered=false
    await run('taskMonitor.elements.tableBody.querySelector(".monitor-analysis-link").click()')
    for(let i=0;i<100&&!modelEntered;i++)await new Promise(resolve=>setTimeout(resolve,30))
    assert.equal(modelEntered,true)
    const blocked=await run('desktop.invoke("undeclared:refresh").then(()=>"unexpected",error=>error.message)')
    assert.match(blocked,/先停止分析/)
    await run('$("monitorHost").shadowRoot.getElementById("stopAnalysis").click()')
    await wait('$("monitorHost").shadowRoot.getElementById("analyzeButton").disabled===false')
    assert.match(await run('$("monitorHost").shadowRoot.getElementById("analyzeButton").title'),/分析已停止/)
    sourceRows[0].noDeclaredCount=2
    await run('taskMonitor.refreshData()')
    assert.equal(await run('taskMonitor.allRows.every(row=>!row.incompleteReason)'),true)
    sourceRows[0].taskStatus='已停用';sourceRows[0].taskComment='用户不扫码'
    await run('taskMonitor.refreshData()');await wait('!taskMonitor.refreshing')
    await run('desktop.invoke("settings:save",{modelBaseUrl:"",modelName:""})')
    reads=modelReads()
    const evidenceReads=requests.filter(item=>/executionList|taskQueue\/page/.test(item.path)).length
    await run('$("monitorHost").shadowRoot.getElementById("analyzeButton").click()')
    await wait('!taskMonitor.analyzing&&!$("monitorHost").shadowRoot.getElementById("analyzeButton").disabled')
    assert.match(await run('taskMonitor.allRows[0].incompleteReason'),/已停用/)
    assert.match(await run('taskMonitor.allRows[0].incompleteReason'),/用户不扫码/)
    assert.equal(await run('taskMonitor.elements.tableBody.querySelector(".monitor-evidence summary").textContent'),'明细')
    assert.match(await run('taskMonitor.elements.tableBody.querySelector(".monitor-analysis-full").textContent'),/用户不扫码/)
    assert.equal(await run('taskMonitor.allRows[0].analysisResult.analysis.modelCalls'),0)
    assert.equal(await run('taskMonitor.elements.tableBody.querySelector(".monitor-takeover").disabled'),false)
    assert.equal(modelReads(),reads)
    assert.equal(requests.filter(item=>/executionList|taskQueue\/page/.test(item.path)).length,evidenceReads)
    sourceRows[1].taskStatus='已停用';sourceRows[1].taskComment='等待用户扫码'
    await run('taskMonitor.refreshData()')
    const previousAnalysis=await run('taskMonitor.allRows[0].analyzedAt')
    await run('$("monitorHost").shadowRoot.getElementById("clearFilterButton").click()')
    await run('$("monitorHost").shadowRoot.getElementById("analyzeButton").click()')
    await wait('!$("monitorHost").shadowRoot.getElementById("analyzeButton").disabled')
    assert.ok(await run('taskMonitor.allRows[1].analysisAttempted'))
    assert.ok(await run('taskMonitor.allRows[1].analyzedAt'))
    assert.equal(await run('taskMonitor.allRows[0].analyzedAt'),previousAnalysis)
    assert.deepEqual(errors,[])
    fs.writeFileSync(path.join(artifacts,'task-analysis-acceptance.json'),JSON.stringify({passed:true,checks:['main-window-entry','filtered-task-scope','configured-model','harness-tools','execution-detail','template-rules','authenticated-image','reason-column','purpose-progress','encrypted-checkpoints','stop-analysis','refresh-conflict','no-business-writes']},null,2))
    console.log('Task analysis acceptance passed: native main-window UI, Harness tools, current model, screenshot input, reasons, cancellation and encrypted evidence.')
    clearTimeout(deadline);server.close();app.exit(0)
  }catch(error){console.error(error.stack);console.error(errors);clearTimeout(deadline);server.close();app.exit(1)}
}))
require('../src/main')
