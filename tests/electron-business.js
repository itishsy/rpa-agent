'use strict'
// Acceptance through real Electron DOM/preload/IPC, isolated loopback services only.
const { app, BrowserWindow, dialog } = require('electron')
app.disableHardwareAcceleration()
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict')
const artifacts = path.resolve(__dirname, '../artifacts')
fs.mkdirSync(artifacts, { recursive: true })
process.env.RPA_AGENT_TEST_DATA = fs.mkdtempSync(path.join(artifacts, 'business-data-'))
let savePath = '', cancelSave = false, navigationDecision = 1, failRelease = false, failMonitor = false, failPayment = false, failAccounts = false, expireMonitor = false, monitorLogins = 0
let readonlySuggestion
dialog.showSaveDialog = async () => ({ canceled: cancelSave, filePath: savePath })
dialog.showMessageBox = async () => ({ response: navigationDecision })
const requests = [], cases = [], errors = []
const apps = Array.from({ length: 21 }, (_, i) => ({ id:i+1,appCode:i?'app'+i:'app',appName:i?'应用'+i:'武汉-社保',robotName:'社保',appArgs:'{"businessType":1001001,"addrId":1,"addrName":"武汉","extra":"保留"}',flowCount:3,version:'1.0',appStatus:1,status:0,appRemark:i===1?'<script>unsafe()</script>':'示例备注',serviceVOList:[{serviceItem:1,serviceStatus:1,serviceRemark:''}] }))
let flows = [
  {id:1,appCode:'app',flowCode:'flow',flowName:'增员主流程',flowType:1,serviceItem:1,serviceItemName:'增员',declareSystem:'s1',declareSystemName:'社保网',runSupport:'web',status:0,execOrder:2},
  {id:2,appCode:'app',flowCode:'login',flowName:'登录',flowType:1,serviceItem:11,serviceItemName:'登录',declareSystem:'s2',declareSystemName:'税务网',runSupport:'web',status:0,execOrder:1},
  {id:3,appCode:'app',flowCode:'child',flowName:'子流程',flowType:2,declareSystem:'s1',declareSystemName:'社保网',runSupport:'web',status:0,execOrder:3}
]
let steps = [{stepCode:'one',stepName:'步骤一',actionCode:'page',actionArgs:'{"mode":"simple","count":0}',targetArgs:'{}',level:0,number:0},
  {stepCode:'two',stepName:'步骤二',actionCode:'page',actionArgs:'{"mode":"simple","count":1}',targetArgs:'{}',skipTo:'步骤一',level:0,number:1}]
const definitions = [{fieldKey:'mode',fieldName:'模式',fieldType:'singleDropList',required:1,cond:'{"simple":["count"],"detail":["count","details"]}',robotDataDicts:[{dictCode:'simple',dictName:'简单'},{dictCode:'detail',dictName:'详细'}]},
  {fieldKey:'count',fieldName:'次数',fieldType:'number',required:1},{fieldKey:'details',fieldName:'说明',fieldType:'text',required:1}]
const server = http.createServer(async (req,res) => {
  try {
    let raw='';for await(const part of req)raw+=part
    const url=new URL(req.url,'http://mock'), p=url.pathname.replace(/^\/api\//,'/'), body=raw?(req.headers['content-type']?.includes('application/json')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw))):{}, params=Object.fromEntries(url.searchParams)
    requests.push({p,body,params,method:req.method,authorization:req.headers.authorization})
    if(p==='/v1/chat/completions'){
      const done=body.messages.some(message=>message.role==='tool'&&message.tool_call_id==='readonly-suggestion')
      const message=done?{role:'assistant',content:'已生成建议补丁，仅供审阅和临时调试。'}:{role:'assistant',content:'',tool_calls:[{id:'readonly-suggestion',type:'function',function:{name:'propose_dsl_patch',arguments:JSON.stringify({baseRevision:readonlySuggestion.revision,operations:[{op:'set',stepCode:readonlySuggestion.code,field:'waitBefore',value:13}]})}}]}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message}]}));return
    }
    let data=true
    if(p==='/oauth/token'){if(params.accData)monitorLogins++;data={access_token:params.accData?'monitor-token':'platform-token',expires_in:3600,custId:1,custName:'离线测试客户'}}
    else if(p==='/sys/user/menu/listMenuByUser/1')data={menus:[],tabs:[],buttons:[]}
    else if(p==='/oauth/check_token')data={active:true,exp:Date.now()/1000+3600}
    else if(p==='/robot/app/getAppData'||p==='/robot/app/page'){
      const query=Object.fromEntries((body.query||[]).map(q=>[q.property,q.value]));let found=apps.filter(a=>(!query.keyWord||a.appName.includes(query.keyWord))&&(!query.appCode||a.appCode===query.appCode)&&(!query.appStatusList?.length||query.appStatusList.includes(a.appStatus)))
      data={rows:found.slice(body.start||0,(body.start||0)+(body.size||100)),records:found.length}
    }else if(p==='/robot/app/type')data=[{robotCode:'social',robotName:'社保'}]
    else if(p==='/policy/declareAddr/addrList')data=[{id:1,name:'武汉'}]
    else if(p==='/robot/app/dynamic/field')data=[{fieldKey:'addrName',fieldName:'地区'},{fieldKey:'businessType',fieldName:'业务类型'}]
    else if(p==='/policy/sys/dict/getDictByKey')data=params.dataKey==='1001'?[{dictCode:1001001,dictName:'社保'}]:[{dictCode:'s1',dictName:'社保网'},{dictCode:'s2',dictName:'税务网'}]
    else if(p==='/robot/data/dict/10019')data=[{dictCode:'web',dictName:'浏览器'}]
    else if(p==='/robot/data/dict/10018')data=[{dictCode:'tag',dictName:'通用'}]
    else if(p==='/robot/app/updateApp'){Object.assign(apps[0],body);assert.equal(JSON.parse(body.appArgs).extra,'保留')}
    else if(p==='/robot/app/release'){if(failRelease){res.writeHead(403);res.end(JSON.stringify({message:'无发布权限'}));return}assert.equal(body.appCode,'app');assert.ok(body.comment)}
    else if(['/robot/app/offlineStatus','/robot/app/updateAppStatus','/robot/app/syncOut','/robot/app/activate'].includes(p)){assert.equal(params.appCode,'app');assert.deepEqual(body,{})}
    else if(p==='/robot/app/history')data=[{version:'0.9',comment:'旧版本',createName:'测试员'}]
    else if(p==='/robot/flow/list')data=flows.filter(f=>f.appCode===body.appCode&&(!body.flowTypeList?.length||body.flowTypeList.includes(f.flowType))&&(!body.serviceItemList?.length||body.serviceItemList.map(String).includes(String(f.serviceItem)))&&(!body.declareSystemList?.length||body.declareSystemList.includes(f.declareSystem)))
    else if(p==='/robot/flow/listTemplate')data=[{flowCode:'template',flowName:'模板'}]
    else if(p==='/robot/flow/showOneAppFlow')data=flows
    else if(['/robot/flow/add','/robot/flow/copyAdd','/robot/flow/relateAdd'].includes(p)){
      assert.deepEqual(body,{});const source=flows.find(f=>f.flowCode===params.flowCode)
      flows.push({...source,...params,id:100+flows.length,flowCode:'new'+flows.length,flowType:Number(params.flowType||source.flowType),execOrder:flows.length+1,status:0,...(p.endsWith('relateAdd')?{relationFlowCode:params.flowCode}:{})})
    }else if(p==='/robot/flow/editFlow'){assert.ok(body.id);assert.equal(params.flowCode,undefined);Object.assign(flows.find(f=>f.id===body.id),body)}
    else if(p==='/robot/flow/editFlowOrder'){
      const ordered=flows.slice().sort((a,b)=>a.execOrder-b.execOrder),index=ordered.findIndex(f=>f.id===body.id),[moving]=ordered.splice(index,1);ordered.splice(body.execOrder-1,0,moving);ordered.forEach((f,i)=>{f.execOrder=i+1})
    }else if(p==='/robot/flow/editFlowStatus'){assert.equal(body.appCode,'app');Object.assign(flows.find(f=>f.id===body.id),body)}
    else if(p==='/robot/flow/statusHistory'){assert.equal(body.historyType,2);assert.deepEqual(params,{});data=[{actionName:'调整状态',flowStatusName:'修复问题',remark:'测试原因',createName:'测试员'}]}
    else if(p==='/robot/flow/delete')flows=flows.filter(f=>f.flowCode!==params.flowCode)
    else if(p.startsWith('/robot/flow/step/list/'))data=steps
    else if(p.startsWith('/robot/client/app/getByFlowCode/'))data=flows.find(flow=>flow.flowCode===p.split('/').at(-1))
    else if(p==='/robot/flow/step/save'){assert.ok(Array.isArray(body));steps=body}
    else if(p==='/robot/action/all')data=[{actionCode:'page',actionName:'页面',groupName:'网页'}]
    else if(p==='/robot/action/args')data=definitions
    else if(p==='/robot/action/target/args')data=[]
    else if(p==='/robot/start/status')data=0
    else if(p==='/robot/task/listAllTask'){if(failAccounts){res.writeHead(500);res.end('{"message":"账户暂不可用"}');return}data=[{taskCode:'task',taskName:'测试账户'}]}
    else if(p==='/robot/debug/runs')data={status:'SUCCEEDED',executionCode:'reference-debug',snapshots:[]}
    else if(p==='/robot/app/client/list'){
      if(expireMonitor){expireMonitor=false;res.writeHead(401);res.end('{"message":"expired"}');return}
      if(failMonitor){res.writeHead(500);res.end('{"message":"monitor unavailable"}');return}
      assert.equal(req.headers.authorization,'Bearer monitor-token')
      data=[{id:1,appName:'武汉-社保',appCode:'app',customerName:'客户甲',custId:7,accountNumber:'001',taskCode:'task',taskStatus:'已停用',taskComment:'人工暂停',noDeclaredCount:3,auditCount:2,execCount:0}]
    }else if(p.startsWith('/robot/app/client/showServiceItemFlow/'))data=[{serviceItemName:'增员',noDeclaredCount:3}]
    else if(p.startsWith('/robot/app/client/getRobotTaskConfigInfo/'))data={args:[{argsKey:'socialLoginType',fieldName:'社保登录方式',argsValue:'密码'}]}
    else if(p==='/policy/customer/payFee/page'){
      assert.equal(req.headers.authorization,'Bearer platform-token');assert.deepEqual(body.query.find(q=>q.property==='robotStatuses').value,[11,21,31,25])
      if(failMonitor||failPayment){res.writeHead(500);res.end('{"message":"payment unavailable"}');return}
      data={records:[{id:1,addrName:'武汉',businessType:1,custId:7,accountNumber:'001',robotStatusName:'待缴费',paySystemName:'税务系统'}],total:1}
    }else {throw new Error('Unexpected endpoint '+req.url)}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:200,data}))
  }catch(error){errors.push(error.stack);res.writeHead(500);res.end(JSON.stringify({message:error.message}))}
})
const deadline=setTimeout(()=>{console.error('Business acceptance timed out');app.exit(1)},120000)
app.on('web-contents-created',(_e,contents)=>contents.on('preload-error',(_event,file,error)=>errors.push(file+': '+error.message)))
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
  if(!win.webContents.getURL().endsWith('/index.html'))return
  const run=code=>win.webContents.executeJavaScript(code,true)
  const wait=async(code,runner=run)=>{for(let i=0;i<100;i++){if(await runner(code))return;await new Promise(r=>setTimeout(r,30))}throw new Error('Timed out: '+code+'; notice='+await run('$("notice").textContent').catch(()=>''))}
  const mark=name=>{cases.push(name);console.log('PASS '+name)}
  const submit=async()=>{await run('$("businessForm").requestSubmit()');await wait('!businessPending');}
  const close=()=>run('$("businessClose").click()')
  const set=async(values)=>run(`for(const [key,value] of Object.entries(${JSON.stringify(values)})){const el=document.querySelector('[data-field="'+key+'"]');el.value=value;el.dispatchEvent(new Event('change'))}`)
  const snap=async(name,target=win)=>fs.writeFileSync(path.join(artifacts,name+'.png'),(await target.webContents.capturePage()).toPNG())
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint='http://127.0.0.1:'+server.address().port
    await run(`(async()=>{await desktop.invoke('auth:login',{baseUrl:${JSON.stringify(endpoint+'/api')},username:'test',password:'offline-user'});const saved=await desktop.invoke('platforms:save',[{name:'验收平台',url:${JSON.stringify(endpoint+'/api')},username:'test',password:'offline-test'}]);await desktop.invoke('platform:select',saved.platforms[0].id);await desktop.invoke('settings:save',{remoteEnabled:true,modelBaseUrl:${JSON.stringify(endpoint+'/v1')},modelName:'readonly-test',connections:[{baseUrl:${JSON.stringify(endpoint)},debugToken:'test'}]});await bootstrap();await loadApplications();await initializeManagement();setView('applications')})()`)
    assert.equal(await run('managed.rows.length'),20);assert.match(await run('$("managementPage").textContent'),/21/)
    await run('$("managementNext").click()');await wait('managed.rows.length===1');assert.equal(await run('$("managementNext").disabled'),true)
    await run('$("resetApplications").click()');await wait('managed.rows.length===20')
    await run('$("applicationKeyword").value="武汉";$("searchApplications").click()');await wait('managed.rows.length===1&&managed.rows[0].appCode==="app"')
    assert.equal(await run('document.querySelectorAll("#applicationTable script").length'),0)
    savePath=path.join(artifacts,'applications.csv');await run('$("exportApplications").click()');await wait('!$("exportApplications").disabled');assert.match(fs.readFileSync(savePath,'utf8'),/武汉-社保/)
    mark('应用分页、末页、关键字搜索、文本转义及当前页CSV导出')
    await run('applicationForm(managed.rows[0])');await set({appName:'武汉-社保',appRemark:'编辑备注'})
    await run('const status=document.querySelector(".service-row select");status.value="0";status.dispatchEvent(new Event("change"))')
    assert.equal(await run('$("businessForm").checkValidity()'),false)
    await run('const explanation=document.querySelector(".service-row input");explanation.value="暂不支持";explanation.dispatchEvent(new Event("input"))');await submit();assert.equal(await run('$("businessDialog").open'),false);assert.equal(apps[0].appRemark,'编辑备注')
    mark('编辑应用保留隐藏参数，未实现服务说明必填，保存后回读')
    await run('applicationOperation(managed.rows[0],"releaseApplication")');await set({changeReason:'修复流程',comment:'上线测试'})
    failRelease=true;await submit();assert.equal(await run('$("businessDialog").open'),true);assert.match(await run('$("businessError").textContent'),/403|权限/)
    failRelease=false;await submit();assert.equal(await run('$("businessDialog").open'),false)
    for(const operation of ['offlineApplication','statusApplication','syncApplication']){await run(`applicationOperation(managed.rows[0],${JSON.stringify(operation)})`);await set(operation==='statusApplication'?{appStatus:'4',remark:'验收'}:operation==='offlineApplication'?{appStatus:'1',comment:'验收'}:{comment:'验收'});await submit()}
    await run('showVersions(managed.rows[0])');await run('$("businessFields").querySelector("button").click()');await submit();assert.ok(requests.some(r=>r.p==='/robot/app/activate'&&r.params.version==='0.9'))
    mark('上线权限失败保留表单并重试、下架、状态、同步及版本激活')
    await snap('applications-acceptance')
    await run('openFlowManagement(managed.rows[0])');assert.equal(await run('managed.flows.length'),3)
    await run('[...$("flowServices").options].forEach(o=>o.selected=o.value==="1");$("searchManagedFlows").click()');await wait('managed.flows.length===1');assert.equal(await run('$("flowSystems").options.length'),2)
    await run('$("resetManagedFlows").click()');await wait('managed.flows.length===3')
    await run('flowForm("add")');await set({flowName:'新增子流程',flowType:'2',declareSystem:'s1',runSupport:'web'});assert.equal(await run('document.querySelector("[data-field=serviceItem]").disabled'),true);await submit();assert.equal(flows.length,4);assert.equal(flows.at(-1).serviceItem,'')
    await run('flowForm("add")');await set({flowName:'新增子流程',flowType:'2',declareSystem:'s1',runSupport:'web'});await submit();assert.match(await run('$("businessError").textContent'),/重复/);await close()
    await run('flowForm("edit",managed.completeFlows.find(f=>f.flowCode==="flow"))');await set({flowName:'增员主流程已编辑'});await submit();assert.equal(flows[0].flowName,'增员主流程已编辑')
    for(const mode of ['copyAdd','relateAdd']){await run(`flowForm(${JSON.stringify(mode)},managed.completeFlows.find(f=>f.flowCode==='flow'))`);await set({flowName:mode+'流程'});await submit()}
    assert.equal(flows.length,6);assert.equal(flows.at(-1).relationFlowCode,'flow')
    mark('流程筛选与统计、子流程字段联动、新增/重名拦截/编辑/复制/关联')
    await run('flowOrderForm(managed.completeFlows.find(f=>f.flowCode==="flow"))');await set({execOrder:'999'});assert.equal(await run('$("businessForm").checkValidity()'),false);await set({execOrder:'1'});await submit()
    await run('flowStatusForm(managed.completeFlows.find(f=>f.flowCode==="flow"))');await set({status:'4'});assert.equal(await run('$("businessForm").checkValidity()'),false);await set({comment:'测试原因'});await submit();assert.equal(flows.find(f=>f.flowCode==='flow').status,4)
    await run('flowHistory(managed.completeFlows[0])');assert.match(await run('$("businessFields").textContent'),/测试原因/);await close()
    await run('$("organizeFlows").click()');await wait('$("businessDialog").open');await submit();assert.equal(flows.slice().sort((a,b)=>a.execOrder-b.execOrder)[0].flowCode,'login')
    await run('deleteFlowForm(managed.completeFlows.find(f=>f.flowName==="copyAdd流程"))');await submit();assert.equal(flows.length,5)
    mark('完整列表排序范围、整理后回读、问题原因必填、状态历史及确认删除')
    await snap('flows-acceptance')
    await run('openManagedSteps(managed.completeFlows.find(f=>f.flowCode==="flow"))');await wait('document.querySelectorAll("[data-argument-key]").length===2')
    assert.equal(await run('document.querySelector("[data-argument-key=count]").value'),'0')
    await run('$("stepName").value="重命名步骤";$("commitStep").click()');await wait('current.dsl.steps[0].stepName==="重命名步骤"');assert.equal(await run('current.dsl.steps[1].skipTo'),'重命名步骤')
    await run('const mode=document.querySelector("[data-argument-key=mode]");mode.value="detail";mode.dispatchEvent(new Event("change"))');await wait('!!document.querySelector("[data-argument-key=details]")')
    await run('$("saveFlow").click()');await wait('!$("saveFlow").disabled');assert.equal(requests.filter(r=>r.p==='/robot/flow/step/save').length,0)
    await run('const detail=document.querySelector("[data-argument-key=details]");detail.value="说明内容";detail.dispatchEvent(new Event("input"));$("commitStep").click()');await wait('current.dsl.steps[0].actionArgs.details==="说明内容"')
    await run('$("saveFlow").click()');await wait('!$("saveFlow").disabled');assert.equal(steps[0].stepName,'重命名步骤');assert.equal(JSON.parse(steps[0].actionArgs).details,'说明内容')
    mark('步骤动态控件、条件显示、必填数值0、重命名同步跳转、未更新输入保存拦截、原生VO保存')
    await run(`for(const [key,value] of Object.entries({status:'0',failedStrategy:'2',failedRetry:'0',timeout:'10',waitBefore:'1',waitAfter:'2',maxExecuteNum:'3',failedSkipTo:'步骤二',falseSkipTo:'步骤二',skipCondition:'ctx.skip'})){const el=document.querySelector('[data-step-option="'+key+'"]');el.value=value;el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input'))}$("commitStep").click()`)
    await wait('current.dsl.steps[0].status===0');await run('$("saveFlow").click()');await wait('!$("saveFlow").disabled');assert.equal(steps[0].failedStrategy,2);assert.equal(steps[0].failedRetry,0);assert.equal(steps[0].timeout,10);assert.equal(steps[0].failedSkipTo,'步骤二')
    mark('原生流转控件：禁用、失败跳转、条件跳转、跳过表达式、零次重试、超时、等待和执行上限保存')
    await run('$("copyStep").click()');await wait('!$("copyStep").disabled');await run('$("pasteStep").click()');await wait('current.dsl.steps.length===3');await run('$("pasteStep").click()');await wait('current.dsl.steps.length===4')
    assert.equal(await run('new Set(current.dsl.steps.map(s=>s.stepCode)).size'),4);assert.equal(await run('new Set(current.dsl.steps.map(s=>s.stepName)).size'),4)
    await run('$("moveUp").click()');await wait('!$("moveUp").disabled');await snap('steps-acceptance')
    await run('selected=[0];renderWorkspace();$("deleteStep").click()');await wait('current.dsl.steps.length===3');assert.equal(await run('current.dsl.steps.some(s=>s.skipTo==="重命名步骤")'),false)
    while(await run('current.dsl.steps.length')){const count=await run('current.dsl.steps.length');await run('selected=[0];renderWorkspace();$("deleteStep").click()');await wait('current.dsl.steps.length==='+String(count-1))}
    const saves=requests.filter(r=>r.p==='/robot/flow/step/save').length
    await run('$("saveFlow").click()');await wait('!$("saveFlow").disabled');assert.equal(requests.filter(r=>r.p==='/robot/flow/step/save').length,saves)
    mark('重复粘贴生成唯一编码/名称、移动、删除清理跳转、最后步骤可删但空流程禁止保存')
    await run(`desktop.invoke('undeclared:save-settings',{keywords:'武汉-社保,武汉-社保',servers:[{baseServer:${JSON.stringify(endpoint)},username:'monitor',password:'encrypted-monitor-input'}]})`)
    const monitorLoaded=new Promise(resolve=>app.on('browser-window-created',(_e,w)=>w.webContents.once('did-finish-load',()=>{if(w.webContents.getURL().endsWith('/monitor.html'))resolve(w)})))
    await run('desktop.invoke("app:panel","monitor")');const monitor=await monitorLoaded, mr=async code=>{
      try { return await monitor.webContents.executeJavaScript(code.replace(/\b(elements|allRows|lastUpdatedAt|refreshing|lastRefreshFailed|refreshData|exportCurrentTasks)\b/g,"taskMonitor.$1"),true) }
      catch(error) { console.error('Monitor probe failed:',code);throw error }
    }
    await wait('lastUpdatedAt && !refreshing',mr);assert.equal(await mr('allRows.length'),2)
    assert.equal(await mr('elements.tableBody.querySelector(".task-details").querySelectorAll(".task-count").length'),0)
    assert.equal(await mr('elements.tableBody.querySelector(".task-audit").textContent'),'审核中（2）')
    assert.equal(await mr('elements.tableBody.querySelector(".task-details a").textContent'),'增员（3）')
    assert.equal(await mr('elements.tableBody.querySelector(".execution-count").textContent'),'0')
    assert.equal(await mr('[...elements.tableBody.querySelectorAll(".execution-count")].some(cell=>cell.textContent==="—")'),true)
    assert.match(await mr('elements.tableBody.textContent'),/人工暂停/);assert.match(await mr('elements.tableBody.textContent'),/审核中（2）/);assert.match(await mr('elements.tableBody.textContent'),/社保登录方式/)
    assert.equal(await mr('elements.keywords.value'),'武汉-社保');assert.equal(await mr('document.querySelector(".server-password").value'),'')
    await mr('elements.settingsForm.requestSubmit()');await wait('!refreshing',mr);assert.equal(monitorLogins,1)
    expireMonitor=true;await mr('refreshData()');assert.equal(monitorLogins,2)
    mark('监控关键字持久化重开、密码不回显、停用原因/审核数/登录备注、缓存复用及401重登录')
    failPayment=true;await mr('refreshData()');assert.equal(await mr('allRows.length'),1);assert.match(await mr('elements.message.textContent'),/payment unavailable/);failPayment=false;await mr('refreshData()')
    mark('监控部分源失败保留成功来源并显示警告')
    await mr('elements.filterButton.click();elements.filterPayFee.checked=false;elements.filterForm.requestSubmit()');assert.equal(await mr('elements.tableBody.children.length'),1)
    savePath=path.join(artifacts,'monitor-summary.txt');await mr('exportCurrentTasks()');assert.match(fs.readFileSync(savePath,'utf8'),/武汉-社保/)
    const before=fs.readFileSync(savePath,'utf8');cancelSave=true;await mr('exportCurrentTasks()');assert.equal(fs.readFileSync(savePath,'utf8'),before);cancelSave=false
    failMonitor=true;await mr('refreshData()');assert.equal(await mr('lastRefreshFailed'),true);assert.equal(await mr('allRows.length'),2)
    await mr('exportCurrentTasks()');assert.match(fs.readFileSync(savePath,'utf8'),/失败|旧数据|上次/);failMonitor=false;await mr('refreshData()')
    mark('监控缴费过滤、按已应用筛选导出、取消导出、全源失败保留旧数据并标识过期导出')
    navigationDecision=0
    const originalMain=await run('({view:document.body.dataset.currentView,session:current?.id,name:$("stepName").value})')
    const designCreated=new Promise(resolve=>app.once('browser-window-created',(_e,child)=>resolve(child)))
    await mr('document.querySelector(".task-details a").click()');const taskDesign=await designCreated
    const dr=code=>taskDesign.webContents.executeJavaScript(code,true)
    await wait('$("designConnectDialog").open',dr)
    await dr(`$('designConnectExecutor').value=${JSON.stringify(endpoint)};$('designConnectForm').requestSubmit()`)
    await wait('document.documentElement.dataset.designReady==="true"&&managed.flows.length>0',dr)
    assert.equal(taskDesign.getTitle(),'武汉-社保（连接至 '+new URL(endpoint).host+'）');assert.equal(taskDesign.getParentWindow(),null)
    assert.equal(await dr('managed.app.appCode'),'app')
    assert.equal(await dr('managed.flows.every(flow=>Number(flow.serviceItem)===1)&&managed.flows.some(flow=>flow.flowCode==="flow")'),true)
    assert.deepEqual(await run('({view:document.body.dataset.currentView,session:current?.id,name:$("stepName").value})'),originalMain)
    assert.equal(await mr('document.querySelector(".task-details a").hasAttribute("aria-busy")'),false)
    const fallbackCreated=new Promise(resolve=>app.once('browser-window-created',(_e,child)=>resolve(child)))
    await run(`desktop.invoke('monitor:open-flow',{baseServer:${JSON.stringify(endpoint)},appCode:'missing-code',appName:'武汉-社保',taskName:'增员'})`)
    const fallbackDesign=await fallbackCreated,fr=code=>fallbackDesign.webContents.executeJavaScript(code,true)
    await wait('$("designConnectDialog").open',fr)
    await fr(`$('designConnectExecutor').value=${JSON.stringify(endpoint)};$('designConnectForm').requestSubmit()`)
    await wait('document.documentElement.dataset.designReady==="true"',fr);assert.equal(await fr('managed.app.appCode'),'app')
    const windowsBefore=BrowserWindow.getAllWindows().length
    apps.push({...apps[0],id:999,appCode:'duplicate-app'})
    assert.match(await run(`desktop.invoke('monitor:open-flow',{appName:'武汉-社保',taskName:'增员'}).then(()=>'unexpected',error=>error.message)`),/同名应用/)
    apps.pop();assert.equal(BrowserWindow.getAllWindows().length,windowsBefore)
    assert.match(await run(`desktop.invoke('monitor:open-flow',{appName:'不存在的应用',taskName:'增员'}).then(()=>'unexpected',error=>error.message)`),/未找到/)
    assert.equal(BrowserWindow.getAllWindows().length,windowsBefore)
    const taskClosed=new Promise(resolve=>taskDesign.once('closed',resolve)),fallbackClosed=new Promise(resolve=>fallbackDesign.once('closed',resolve));taskDesign.close();fallbackDesign.close();await Promise.all([taskClosed,fallbackClosed])
    navigationDecision=1
    mark('监控任务打开独立设计窗并筛选服务，保留主窗口草稿；编码失效按名称匹配，同名或无权限不误开')
    await snap('monitor-acceptance',monitor)
    await run('openManagedSteps(managed.completeFlows.find(f=>f.relationFlowCode))');await wait('current?.readOnly&&document.querySelectorAll("[data-argument]").length>0')
    assert.equal(await run('$("commitStep").disabled&&$("saveFlow").disabled&&[...document.querySelectorAll("[data-step-option],[data-argument]")].every(el=>el.disabled)'),true)
    assert.match(await run('desktop.invoke("workspace:update",current.id,{dsl:current.dsl}).then(()=>"unexpected",error=>error.message)'),/只读/)
    await wait('!taskLoading')
    const referenceOriginal=await run('JSON.stringify(current.dsl)'),referenceSaves=requests.filter(item=>item.p==='/robot/flow/step/save').length
    await run('$("task").value="task";$("task").dispatchEvent(new Event("change"))');await wait('current.taskCode==="task"')
    await run('direct("run_current_dsl")');assert.equal(await run('current.runs[0].result.status'),'SUCCEEDED')
    readonlySuggestion=await run('({revision:current.revision,code:current.dsl.steps[0].stepCode})')
    await run('desktop.invoke("agent:start",current.id,{request:"分析引用流程并提供建议补丁",mode:"develop"});')
    await run('refreshSnapshot()')
    assert.equal(await run('current.proposal.advisoryOnly&&$("applyCandidate").disabled'),true)
    assert.equal(await run('JSON.stringify(current.dsl)'),referenceOriginal)
    await run('direct("run_proposed_dsl")');assert.equal(await run('current.runs[0].result.status'),'SUCCEEDED')
    assert.match(await run('desktop.invoke("workspace:candidate",current.id,"apply").then(()=>"unexpected",error=>error.message)'),/不能直接应用/)
    assert.match(await run('desktop.invoke("workspace:save",current.id).then(()=>"unexpected",error=>error.message)'),/只读/)
    assert.equal(requests.filter(item=>item.p==='/robot/flow/step/save').length,referenceSaves)
    assert.equal(await run('JSON.stringify(current.dsl)'),referenceOriginal)
    mark('引用流程可选账户并调试原流程/建议候选，补丁只供审阅，禁止直接修改/应用/保存')
    failAccounts=true;await run('openManagedSteps(managed.completeFlows.find(f=>f.flowCode==="flow"))');await wait('!taskLoading');assert.match(await run('$("notice").textContent'),/账户暂不可用/);assert.equal(await run('$("task").options.length'),1)
    failAccounts=false;await run('openManagedSteps(managed.completeFlows.find(f=>f.flowCode==="flow"))');await wait('!taskLoading');assert.equal(await run('$("task").options.length'),2)
    await run('flowStatusForm(managed.completeFlows[0]);managed.platformId="another-platform"');await set({comment:'跨平台保护验收'});await submit();assert.match(await run('$("businessError").textContent'),/用户已变化/);await run('managed.platformId=currentUser.id');await close()
    mark('关联流程原生控件与IPC只读保护、账户失败可重新打开重试、跨用户旧表单禁止提交')
    assert.deepEqual(errors,[])
    fs.writeFileSync(path.join(artifacts,'business-acceptance.json'),JSON.stringify({passed:true,scope:'isolated loopback Electron acceptance; no production calls',cases,requests:requests.length,screenshots:['applications-acceptance.png','flows-acceptance.png','steps-acceptance.png','monitor-acceptance.png']},null,2))
    console.log('Electron business acceptance passed: '+cases.length+' groups, '+requests.length+' requests')
    clearTimeout(deadline);server.close();app.exit(0)
  }catch(error){console.error(error.stack);console.error(errors);await snap('business-failure').catch(()=>{});fs.writeFileSync(path.join(artifacts,'business-failure.json'),JSON.stringify({cases,error:error.stack,requests:requests.slice(-8)},null,2));clearTimeout(deadline);server.close();app.exit(1)}
}))
require('../src/main')

