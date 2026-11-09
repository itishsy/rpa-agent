'use strict'
const {app,BrowserWindow,nativeImage}=require('electron')
app.disableHardwareAcceleration()
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict')
const {localTime}=require('../src/services/task-analysis')
const artifacts=path.resolve(__dirname,'../artifacts');fs.mkdirSync(artifacts,{recursive:true})
process.env.RPA_AGENT_TEST_DATA=fs.mkdtempSync(path.join(artifacts,'task-analysis-data-'))
const requests=[],errors=[];let holdModel=false,modelEntered=false,imageReceived=false
const sourceRows=[0,1].map(i=>({id:i+1,appCode:'app',appName:'武汉-社保',taskCode:'task'+i,accountNumber:'unit'+i,
  customerName:i?'其他客户':'测试客户',addrId:7,businessType:1,taskStatus:'已启用',noDeclaredCount:1,auditCount:0}))
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk
  const url=new URL(req.url,'http://local'),p=url.pathname,body=raw?JSON.parse(raw):{}
  requests.push({path:p,body})
  const reply=data=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:200,data}))}
  try{
    if(p==='/v1/chat/completions'){
      assert.equal(req.headers.authorization,'Bearer model-key');assert.equal(body.model,'configured-analysis-model')
      assert.ok(!raw.includes('task-password-secret'))
      modelEntered=true;if(holdModel)return
      const names=new Set(body.messages.flatMap(message=>(message.tool_calls||[]).map(call=>call.function.name)))
      let calls
      if(!names.has('execution_detail'))calls=[['execution_detail',{executionCode:'execution0',flowCode:'flow'}]]
      else if(!names.has('offer_templates'))calls=[['task_config',{}],['offer_templates',{}]]
      else if(!names.has('column_rules'))calls=[['column_rules',{uuid:'template'}],['template_detail',{uuid:'template'}]]
      else if(!names.has('execution_image'))calls=[['execution_image',{fileId:'1'}]]
      else {imageReceived=body.messages.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url'));assert.equal(imageReceived,true,JSON.stringify(body.messages.filter(message=>message.role==='tool').slice(-2)))}
      const message=calls?{role:'assistant',content:'',tool_calls:calls.map(([name,args],index)=>({id:name+'-'+index,type:'function',function:{name,arguments:JSON.stringify({...args,_purpose:'确认'+name+'对应的未完成证据'})}}))}
        :{role:'assistant',content:'未完成原因：验证码等待未完成。\n依据：execution0 的登录步骤提示等待验证码。\n建议：完成验证码后核对原任务状态。\n缺失证据：业务最终办结凭证尚未取得。'}
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
      return reply({rows:[{appCode:'app',taskCode:'task0',declareAccount:'unit0',status:1}],total:1})
    }
    if(p.endsWith('/client/execution/detail'))return reply([{executionCode:'execution0',flowCode:'flow',stepCode:'login',stepName:'验证码登录',error:'等待验证码',files:[{fileId:1}]}])
    if(p.endsWith('/offerSettings/page'))return reply({rows:[{uuid:'template',addrId:7,businessType:1}],total:1})
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
    await run(`(()=>{const root=$('monitorHost').shadowRoot;root.querySelector('.filter-field').value='customerName';root.querySelector('.filter-keyword').value='测试客户';taskMonitor.elements.filterForm.requestSubmit()})()`)
    assert.equal(await run('taskMonitor.elements.tableBody.rows.length'),1)
    assert.equal(await run('$("monitorHost").shadowRoot.querySelectorAll("th")[5].textContent'),'未完成原因')
    await run('$("monitorHost").shadowRoot.getElementById("analyzeButton").click()')
    await wait('$("monitorHost").shadowRoot.getElementById("analyzeButton").disabled===false')
    assert.match(await run('taskMonitor.elements.tableBody.querySelector(".monitor-reason").textContent'),/验证码等待/)
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
    await run('$("monitorHost").shadowRoot.getElementById("analyzeButton").click()')
    for(let i=0;i<100&&!modelEntered;i++)await new Promise(resolve=>setTimeout(resolve,30))
    assert.equal(modelEntered,true)
    const blocked=await run('desktop.invoke("undeclared:refresh").then(()=>"unexpected",error=>error.message)')
    assert.match(blocked,/先停止分析/)
    await run('$("monitorHost").shadowRoot.getElementById("stopAnalysis").click()')
    await wait('$("monitorHost").shadowRoot.getElementById("analyzeButton").disabled===false')
    assert.match(await run('$("monitorHost").shadowRoot.getElementById("analyzeButton").title'),/分析已停止/)
    await run('taskMonitor.refreshData()')
    assert.equal(await run('taskMonitor.allRows.every(row=>!row.incompleteReason)'),true)
    assert.deepEqual(errors,[])
    fs.writeFileSync(path.join(artifacts,'task-analysis-acceptance.json'),JSON.stringify({passed:true,checks:['main-window-entry','filtered-task-scope','configured-model','harness-tools','execution-detail','template-rules','authenticated-image','reason-column','purpose-progress','encrypted-checkpoints','stop-analysis','refresh-conflict','no-business-writes']},null,2))
    console.log('Task analysis acceptance passed: native main-window UI, Harness tools, current model, screenshot input, reasons, cancellation and encrypted evidence.')
    clearTimeout(deadline);server.close();app.exit(0)
  }catch(error){console.error(error.stack);console.error(errors);clearTimeout(deadline);server.close();app.exit(1)}
}))
require('../src/main')
