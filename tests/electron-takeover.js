'use strict'
const {app,BrowserWindow,dialog}=require('electron');app.disableHardwareAcceleration()
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict')
const artifacts=path.resolve(__dirname,'../artifacts');fs.mkdirSync(artifacts,{recursive:true});process.env.RPA_AGENT_TEST_DATA=fs.mkdtempSync(path.join(artifacts,'takeover-data-'))
const {createAgentControl}=require('../../rpa-runtime/src/agent-control')
const token='takeover-debug-token-123456789';let saves=0,modelCalls=0,runtimePosts=0,popup
const application={id:1,appCode:'app-A',appName:'武汉-社保',appArgs:'{}',version:'1.0'}
const flow={id:1,appCode:'app-A',flowCode:'flow-A',flowName:'增员主流程',flowType:1,serviceItem:1,execOrder:1}
const step={stepCode:'one',stepName:'访问页面',actionCode:'page',actionArgs:'{"url":"https://example.test"}',targetArgs:'{}',level:0,number:0}
const errors=[]
const service=http.createServer(async(req,res)=>{try{
 let raw='';for await(const part of req)raw+=part;const u=new URL(req.url,'http://mock'),p=u.pathname,body=raw&&req.headers['content-type']?.includes('application/json')?JSON.parse(raw):{};let data
 if(p==='/v1/chat/completions'){
  modelCalls++;const done=body.messages.some(message=>message.role==='tool');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:done?{role:'assistant',content:'已生成候选补丁，请确认后应用。'}:{role:'assistant',content:'',tool_calls:[{id:'patch-call',type:'function',function:{name:'propose_dsl_patch',arguments:JSON.stringify({baseRevision:0,operations:[{op:'set',stepCode:'one',field:'waitBefore',value:3}]})}}]}}]}));return
 }
 if(p.endsWith('/oauth/token'))data={access_token:'offline-token',custId:1,custName:'验收客户',expires_in:3600}
 else if(p.endsWith('/sys/user/menu/listMenuByUser/1'))data={menus:[],tabs:[],buttons:[]}
 else if(p.endsWith('/robot/app/getAppData')||p.endsWith('/robot/app/page'))data={rows:[application],records:1,total:1}
 else if(p.endsWith('/robot/flow/list'))data=[flow]
 else if(p.endsWith('/robot/flow/step/list/flow-A'))data=[step]
 else if(p.endsWith('/robot/action/all'))data=[{actionCode:'page',actionName:'网页'}]
 else if(p.endsWith('/robot/action/args'))data=[{fieldKey:'url',fieldName:'网址',fieldType:'text',required:1}]
 else if(p.endsWith('/robot/action/target/args'))data=[]
 else if(p.endsWith('/robot/task/listAllTask'))data=[{taskCode:'task-A',taskName:'测试公司_001',accountNumber:'001'}]
 else if(p.endsWith('/robot/start/status'))data=0
 else if(p.endsWith('/robot/app/client/list'))data=[{id:1,appCode:'app-A',appName:'武汉-社保',taskCode:'task-A',accountNumber:'001',customerName:'测试公司',noDeclaredCount:1,machineCode:'machine-A',flowCode:'flow-A'}]
 else if(p.includes('/showServiceItemFlow/'))data=[{serviceItemName:'增员',noDeclaredCount:1}]
 else if(p.includes('/getRobotTaskConfigInfo/'))data={args:[]}
 else if(p.endsWith('/robot/flow/step/save')){saves++;data=true}
 else if(p.includes('/dict/')||p.endsWith('/robot/flow/listTemplate'))data=[]
 else throw Error('Unexpected endpoint '+p)
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:200,data}))
}catch(error){errors.push(error.message);res.writeHead(500);res.end(JSON.stringify({message:error.message}))}})
dialog.showMessageBox=async()=>({response:1})
const deadline=setTimeout(()=>{console.error('Takeover acceptance timed out');app.exit(1)},60000)
app.on('web-contents-created',(_e,contents)=>{contents.on('preload-error',(_event,_file,error)=>errors.push(error.message));contents.on('console-message',(_event,details,message)=>{if(details?.level==='error'||details===3)errors.push(details?.message||message)})})
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
 if(!win.webContents.getURL().endsWith('/index.html'))return
 const run=code=>win.webContents.executeJavaScript(code,true)
 const wait=async(code,execute=run)=>{for(let i=0;i<220;i++){if(await execute(code))return;await new Promise(resolve=>setTimeout(resolve,25))}throw Error('Timeout: '+code)}
 let control
 try{
  await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.address().port
  const runtime={config:{settings:{agentControlEnabled:true,agentControlPort:0,port:service.address().port,machineCode:'machine-A',executionMode:'production',agentTakeover:null},get:()=>token,async save(patch){Object.assign(this.settings,patch)}},runtime:{status:'Runnable',stops:0,starts:0,async probe(){return 0},async stop(){this.stops++},async start(){this.starts++}},requireAuth(){},async run(_label,work){runtimePosts++;return work()}}
  control=createAgentControl(runtime);await control.start();const runtimeBase='http://127.0.0.1:'+control.address().port
  await run(`(async()=>{await desktop.invoke('auth:login',{baseUrl:${JSON.stringify(base+'/api')},username:'test',password:'offline'});await desktop.invoke('settings:save',{remoteEnabled:true,connections:[{baseUrl:${JSON.stringify(base)},runtimeUrl:${JSON.stringify(runtimeBase)},debugToken:${JSON.stringify(token)}}],modelBaseUrl:${JSON.stringify(base+'/v1')},modelName:'offline-model'});await desktop.invoke('undeclared:save-settings',{keywords:'武汉-社保',servers:[{baseServer:${JSON.stringify(base)},username:'test',password:'offline'}],paymentServers:[]});await bootstrap();await initializeManagement();setView('taskMonitor')})()`)
  await wait('taskMonitor?.allRows.length===1&&!taskMonitor.refreshing')
  assert.equal(await run('taskMonitor.elements.tableBody.querySelector("td:last-child button").textContent'),'Agent接管')
  // The selected Runtime can differ from the task's historically assigned device.
  runtime.config.settings.machineCode='selected-runtime-device'
  const opened=new Promise(resolve=>app.once('browser-window-created',(_e,child)=>resolve(child)))
  await run('taskMonitor.elements.tableBody.querySelector("td:last-child button").click()');popup=await opened
  const pr=code=>popup.webContents.executeJavaScript(code,true)
  await wait('!!current?.proposal&&current.state==="completed"&&document.documentElement.dataset.designReady==="true"',pr)
  assert.equal(runtime.config.settings.executionMode,'debug');assert.equal(runtime.runtime.stops,1);assert.equal(runtime.runtime.starts,1)
  assert.equal(await pr('current.taskCode'),'task-A');assert.equal(await pr('current.scope.flowCode'),'flow-A')
  assert.equal(await pr('current.scope.executor'),base);assert.equal(await pr('$("mode").value'),'develop')
  assert.equal(popup.designTakeover.machineCode,'selected-runtime-device')
  assert.equal(runtime.config.settings.agentTakeover.machineCode,'selected-runtime-device')
  assert.equal(await pr('current.dsl.steps[0].waitBefore||0'),0);assert.equal(await pr('current.proposal.dsl.steps[0].waitBefore'),3);assert.equal(saves,0)
  assert.match(await pr('$("candidate").textContent'),/待审核/)
  const count=BrowserWindow.getAllWindows().length
  await run('taskMonitor.elements.tableBody.querySelector("td:last-child button").click()')
  await wait('!document.querySelector(".takeover-dialog[open]")')
  assert.equal(BrowserWindow.getAllWindows().length,count);assert.equal(runtimePosts,1);assert.equal(modelCalls,2)
  const reloaded=new Promise(resolve=>popup.webContents.once('did-finish-load',resolve));popup.webContents.reload();await reloaded
  await wait('current?.proposal&&document.documentElement.dataset.designReady==="true"',pr)
  assert.equal(modelCalls,2);assert.equal(runtimePosts,1);assert.equal(await pr('current.taskCode'),'task-A')
  await popup.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(resolve))');fs.writeFileSync(path.join(artifacts,'takeover-agent-candidate.png'),(await popup.webContents.capturePage()).toPNG())
  assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(artifacts,'takeover-acceptance.json'),JSON.stringify({passed:true,checks:['real-row-action','runtime-authenticated-switch-before-window','task-flow-selected-runtime-binding','task-device-mismatch-allowed','automatic-agent-diagnosis','patch-remains-unapplied-and-unsaved','duplicate-click-reuses-session'],scope:'isolated HTTP Runtime controller and model; no real executors'},null,2))
  console.log('Takeover acceptance passed: Runtime switch, window, account, automatic diagnosis, review-only patch, duplicate action')
  await control.close();service.close();clearTimeout(deadline);app.exit(0)
 }catch(error){console.error(error.stack,errors);if(popup&&!popup.isDestroyed())fs.writeFileSync(path.join(artifacts,'takeover-failure.png'),(await popup.webContents.capturePage()).toPNG());control?.close().catch(()=>{});service.close();clearTimeout(deadline);app.exit(1)}
}))
require('../src/main')
