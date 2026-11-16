'use strict'
const {app,BrowserWindow,dialog}=require('electron');app.disableHardwareAcceleration()
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict')
const artifacts=path.resolve(__dirname,'../artifacts');fs.mkdirSync(artifacts,{recursive:true});process.env.RPA_AGENT_TEST_DATA=fs.mkdtempSync(path.join(artifacts,'takeover-data-'))
let pauses=0, restores=0, accountReads=0, emptyAccounts=false, popup, status='已启用', comment='原备注', failPause=false, failRestore=false
const application={id:1,appCode:'app-A',appName:'武汉-社保',appArgs:'{}',version:'1.0'}
const flow={id:1,appCode:'app-A',flowCode:'flow-A',flowName:'增员主流程',flowType:1,serviceItem:1,execOrder:1}
const step={stepCode:'one',stepName:'访问页面',actionCode:'page',actionArgs:'{"url":"https://example.test"}',targetArgs:'{}',level:0,number:0}
const errors=[]
const service=http.createServer(async(req,res)=>{try{
 let raw='';for await(const part of req)raw+=part;const u=new URL(req.url,'http://mock'),p=u.pathname,body=raw&&req.headers['content-type']?.includes('application/json')?JSON.parse(raw):{};let data
 if(p.endsWith('/oauth/token'))data={access_token:'offline-token',custId:1,custName:'验收客户',expires_in:3600}
 else if(p.endsWith('/sys/user/menu/listMenuByUser/1'))data={menus:[],tabs:[],buttons:[]}
 else if(p.endsWith('/robot/app/getAppData')||p.endsWith('/robot/app/page'))data={rows:[application],records:1,total:1}
 else if(p.endsWith('/robot/flow/list'))data=[flow]
 else if(p.endsWith('/robot/flow/step/list/flow-A'))data=[step]
 else if(p.endsWith('/robot/action/all'))data=[{actionCode:'page',actionName:'网页'}]
 else if(p.endsWith('/robot/action/args'))data=[{fieldKey:'url',fieldName:'网址',fieldType:'text',required:1}]
 else if(p.endsWith('/robot/action/target/args'))data=[]
 else if(p.endsWith('/robot/task/listAllTask')){
   accountReads++
   data=emptyAccounts?[]:[{taskCode:'task-A',taskName:'001'},{taskCode:'task-B',taskName:'002'}]
 }
 else if(p.endsWith('/robot/start/status'))data=0
 else if(p.endsWith('/robot/app/client/list'))data=[{id:1,appCode:'app-A',appName:'武汉-社保',taskCode:'task-A',accountNumber:'001',customerName:'测试公司',noDeclaredCount:1,taskStatus:status,taskComment:comment}]
 else if(p.endsWith('/robot/app/client/updateTaskStatus/app-A/task-A/0')){
   assert.equal(req.method,'POST');assert.equal(req.headers.authorization,'Bearer offline-token')
   if(failPause){res.end('{"code":500,"message":"停用失败"}');return}
   const nextComment=u.searchParams.get('comment')
   if(nextComment==='Agent接管调试中')pauses++
   else assert.ok(['人工停用','Agent接管中'].includes(nextComment))
   status='已停用';comment=nextComment;data=true
 }
 else if(p.endsWith('/robot/app/client/updateTaskStatus/app-A/task-A/1')){
   assert.equal(req.method,'POST');assert.equal(u.searchParams.get('comment'),'原备注')
   if(failRestore){res.end('{"code":500,"message":"恢复失败"}');return}
   restores++;status='已启用';comment=u.searchParams.get('comment');data=true
 }
 else if(p.includes('/showServiceItemFlow/'))data=[{serviceItem:1,serviceItemName:'增员',noDeclaredCount:1}]
 else if(p.includes('/getRobotTaskConfigInfo/'))data={args:[]}
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
 try{
  await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.address().port
  await run(`(async()=>{await desktop.invoke('auth:login',{baseUrl:${JSON.stringify(base+'/api')},username:'test',password:'offline'});await desktop.invoke('settings:save',{remoteEnabled:true,connections:[{baseUrl:${JSON.stringify(base)}}]});await desktop.invoke('undeclared:save-settings',{keywords:'武汉-社保',servers:[{baseServer:${JSON.stringify(base)},username:'test',password:'offline'}],paymentServers:[]});await bootstrap();await initializeManagement();setView('taskMonitor')})()`)
  await wait('taskMonitor?.allRows.length===1&&!taskMonitor.refreshing')
  const button='taskMonitor.elements.tableBody.querySelector(".monitor-takeover")'
  assert.equal(await run(button+'.disabled'),false)
  const monitorOpened=new Promise(resolve=>app.once('browser-window-created',(_e,child)=>resolve(child)))
  await run('taskMonitor.elements.tableBody.querySelector(".task-links a").click()')
  const monitorPopup=await monitorOpened
  const mr=code=>monitorPopup.webContents.executeJavaScript(code,true)
  await wait('$("designConnectDialog").open',mr)
  await mr(`$("designConnectExecutor").value=${JSON.stringify(base)};$("designConnectForm").requestSubmit()`)
  await wait('managed.flows.length===1&&!$("designConnectDialog").open',mr)
  await mr('$("flowManagementTable").querySelector("td.actions button").click()')
  await wait('current?.taskCode==="task-A"&&!taskLoading&&$("task").value==="task-A"&&!$("task").disabled',mr)
  assert.ok(accountReads>0)
  assert.equal(await mr('$("task").options.length'),3)
  await mr('$("task").value="task-B";$("task").dispatchEvent(new Event("change"))')
  await wait('current.taskCode==="task-B"',mr)
  emptyAccounts=true
  await mr('refreshWorkspaceTasks()')
  assert.equal(await mr('!taskLoadError&&$("task").value===""&&!current.taskCode'),true)
  emptyAccounts=false
  const monitorClosed=new Promise(resolve=>monitorPopup.once('closed',resolve))
  monitorPopup.close();await monitorClosed
  status='正在执行'
  assert.match(await run('desktop.invoke("monitor:account-takeover",{rowId:taskMonitor.allRows[0].id,serviceName:"增员"}).catch(error=>error.message)'),/运行中的任务不可接管/)
  assert.equal(pauses,0);assert.equal(BrowserWindow.getAllWindows().length,1)
  await run('taskMonitor.refreshData()')
  assert.equal(await run(button+'.disabled'),true)
  status='已启用';await run('taskMonitor.refreshData()')
  failPause=true
  assert.match(await run('desktop.invoke("monitor:account-takeover",{rowId:taskMonitor.allRows[0].id,serviceName:"增员"}).catch(error=>error.message)'),/停用失败/)
  assert.equal(BrowserWindow.getAllWindows().length,1)
  failPause=false
  const opened=new Promise(resolve=>app.once('browser-window-created',(_e,child)=>resolve(child)))
  await run(button+'.click()');popup=await opened
  const pr=code=>popup.webContents.executeJavaScript(code,true)
  await wait('$("designConnectDialog").open',pr)
  await pr(`$("designConnectExecutor").value=${JSON.stringify(base)};$("designConnectForm").requestSubmit()`)
  await wait('current?.scope.flowCode==="flow-A"&&document.documentElement.dataset.designReady==="true"',pr)
  assert.equal(await pr('$("flowServices").value'),'1')
  await wait('taskMonitor.allRows[0].taskComment==="Agent接管调试中"')
  await wait('$("overviewTakeovers").textContent==="1/1"')
  assert.equal(pauses,1)
  assert.match(await run('taskMonitor.elements.tableBody.textContent'),/已停用（Agent接管调试中）/)
  await wait('!taskLoading&&$("task").value==="task-A"&&$("task").disabled',pr)
  emptyAccounts=true
  await pr('refreshWorkspaceTasks()')
  assert.equal(await pr('!taskLoadError&&$("task").value===""&&!current.taskCode'),true)
  emptyAccounts=false
  assert.match(await pr('desktop.invoke("workspace:update",current.id,{taskCode:"task-B"}).catch(error=>error.message)'),/仅允许使用被接管/)
  await run(button+'.click()')
  assert.equal(BrowserWindow.getAllWindows().length,2)
  assert.equal(await run('$("overviewTakeovers").textContent'),'1/1')
  failRestore=true
  const restoreFailed=new Promise(resolve=>{
    dialog.showMessageBox=async (_win,options)=>{if(options?.message==='恢复申报户状态失败')resolve();return {response:1}}
  })
  popup.close();await restoreFailed
  assert.equal(popup.isDestroyed(),false)
  assert.equal(status,'已停用')
  failRestore=false
  const closed=new Promise(resolve=>popup.once('closed',resolve))
  setTimeout(()=>popup.close(),50)
  await closed
  await wait('taskMonitor.allRows[0].taskStatus==="已启用"&&taskMonitor.allRows[0].taskComment==="原备注"')
  await wait('$("overviewTakeovers").textContent==="0/1"')
  assert.equal(restores,1)
  status='已停用';comment='Agent接管调试中';await run('taskMonitor.refreshData()')
  assert.match(await run('desktop.invoke("monitor:account-takeover",{rowId:taskMonitor.allRows[0].id,serviceName:"增员"}).catch(error=>error.message)'),/已有旧接管标记/)
  assert.equal(pauses,1)
  for(const priorComment of ['人工停用','Agent接管中']){
    comment=priorComment;await run('taskMonitor.refreshData()')
    const reopened=new Promise(resolve=>app.once('browser-window-created',(_e,child)=>resolve(child)))
    await run(button+'.click()');popup=await reopened
    await wait('$("designConnectDialog").open',pr)
    assert.equal(comment,'Agent接管调试中')
    const closedDisabled=new Promise(resolve=>popup.once('closed',resolve))
    popup.close();await closedDisabled
    assert.equal(status,'已停用');assert.equal(comment,priorComment)
  }
  assert.equal(pauses,3);assert.equal(restores,1)
  assert.deepEqual(errors,[])
  console.log('Takeover acceptance passed: running status, failed pause, account remark and service-specific designer')
  service.close();clearTimeout(deadline);app.exit(0)
 }catch(error){console.error(error.stack,errors);service.close();clearTimeout(deadline);app.exit(1)}
}))
require('../src/main')
