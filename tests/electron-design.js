'use strict'
const {app,BrowserWindow,dialog}=require('electron')
app.disableHardwareAcceleration()
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict')
const artifacts=path.resolve(__dirname,'../artifacts');fs.mkdirSync(artifacts,{recursive:true})
process.env.RPA_AGENT_TEST_DATA=fs.mkdtempSync(path.join(artifacts,'design-data-'))
let decision=0,confirmations=0,failAccounts=false,failDelete=false,failOrder=false
let holdFirstFlowList=true,releaseFirstFlowList
let holdAccounts=false,releaseAccounts
let badConnectStatus=false
let releaseProduction,productionResponse='success',stoppedExecutor=false
const performanceMetrics={}
const childRows=[{stepCode:'child-page',stepName:'子流程访问网页',actionCode:'page',actionArgs:'{"url":"https://example.test/child"}',targetArgs:'{}',level:0,number:0}]
const publicTemplates=[{flowCode:'public-flow',flowName:'公共引用流程',flowType:2}]
const h5Fields=require('../src/services/action-knowledge.json').actions.find(action=>action.actionCode==='h5Login').actionFields
const h5Definitions=h5Fields.map(field=>({fieldKey:field.key,fieldName:field.name,required:field.required?1:0,
  fieldType:field.dictOptions.length?'singleDropList':'text',robotDataDicts:field.dictOptions.map(option=>({dictCode:option.code,dictName:option.code})),
  cond:field.conditions.length?Object.fromEntries(field.conditions.map(condition=>{const colon=condition.indexOf(':');return [condition.slice(0,colon),condition.slice(colon+1).split(',')]})):''}))
dialog.showMessageBox=async()=>{confirmations++;return {response:decision}}
const errors=[],checks=[],requests=[]
let rows=[{stepCode:'one',stepName:'打开浏览器',actionCode:'page',actionArgs:'{"url":"https://example.test"}',targetArgs:'{}',level:0,number:0},
 {stepCode:'child',stepName:'访问首页',actionCode:'page',actionArgs:'{"url":"https://example.test/home"}',targetArgs:'{}',status:0,level:1,number:1},
 {stepCode:'two',stepName:'业务办理',actionCode:'page',actionArgs:'{"url":"https://example.test/business"}',targetArgs:'{}',level:0,number:2}]
const applications=[{id:1,appCode:'app',appName:'西安-社保',status:0,version:'V0.0.50',releaseTime:'2026-11-03T08:00:00Z',appArgs:'{}'},
 {id:2,appCode:'app2',appName:'南宁-社保',status:1,version:'V1.0.262',releaseTime:'2026-11-02T08:00:00Z',appArgs:'{}'}]
const flows=[{id:1,appCode:'app',flowCode:'flow',flowName:'养老登录',flowType:1,serviceItem:11,declareSystem:'social',declareSystemName:'养老系统',runSupport:'web',runSupportName:'谷歌浏览器',status:0,execOrder:1},
 {id:2,appCode:'app',flowCode:'flow2',flowName:'养老增员主流程',flowType:1,serviceItem:1,serviceItemName:'增员',declareSystem:'social',declareSystemName:'养老系统',runSupport:'web',runSupportName:'谷歌浏览器',status:1,execOrder:2},
 {id:3,appCode:'app',flowCode:'child-flow',flowName:'公用子流程',flowType:2,status:0,execOrder:3}]
const servers=[0,1].map(index=>http.createServer(async(req,res)=>{
  try{
    let raw='';for await(const chunk of req)raw+=chunk
    const u=new URL(req.url,'http://mock'),p=u.pathname;let data
    const body=raw&&req.headers['content-type']?.includes('application/json')?JSON.parse(raw):{}
    requests.push({server:index,path:p,method:req.method,body,params:Object.fromEntries(u.searchParams)})
    if(p.endsWith('/oauth/token'))data={access_token:'test-token',custId:1,custName:'验收客户',expires_in:3600}
    else if(p.endsWith('/sys/user/menu/listMenuByUser/1'))data={menus:[],tabs:[],buttons:[]}
    else if(p.endsWith('/oauth/check_token'))data={active:true,exp:Date.now()/1000+3600}
    else if(p.endsWith('/robot/app/getAppData'))data={rows:applications,total:2}
    else if(p.endsWith('/robot/app/page'))data={rows:applications,total:2}
    else if(p.endsWith('/robot/flow/list')){
      if(holdFirstFlowList){holdFirstFlowList=false;await new Promise(resolve=>{releaseFirstFlowList=resolve})}
      data=flows.filter(flow=>(!body.flowTypeList?.length||body.flowTypeList.includes(flow.flowType))&&(!body.serviceItemList?.length||body.serviceItemList.includes(flow.serviceItem))&&(!body.declareSystemList?.length||body.declareSystemList.includes(flow.declareSystem)))
    }
    else if(p.endsWith('/policy/sys/dict/getDictByKey'))data=[{dictCode:'social',dictName:'养老系统'}]
    else if(p.endsWith('/robot/data/dict/10019'))data=[{dictCode:'web',dictName:'谷歌浏览器'}]
    else if(p.endsWith('/robot/data/dict/10018'))data=[]
    else if(p.endsWith('/robot/flow/listTemplate'))data=publicTemplates
    else if(p.endsWith('/robot/flow/editFlow')){assert.ok(body.id);Object.assign(flows.find(flow=>flow.id===body.id),body);data=true}
    else if(p.endsWith('/robot/flow/editFlowOrder')){
      if(failOrder){res.writeHead(500);res.end('{"message":"排序服务暂不可用"}');return}
      assert.ok(body.id);const ordered=flows.slice().sort((a,b)=>a.execOrder-b.execOrder),position=ordered.findIndex(flow=>flow.id===body.id),[moving]=ordered.splice(position,1);ordered.splice(body.execOrder-1,0,moving);ordered.forEach((flow,i)=>{flow.execOrder=i+1});data=true
    }else if(p.endsWith('/robot/flow/delete')){
      if(failDelete){res.writeHead(500);res.end('{"message":"删除暂时失败"}');return}
      const position=flows.findIndex(flow=>flow.flowCode===u.searchParams.get('flowCode'));assert.ok(position>=0);flows.splice(position,1);data=true
    }
    else if(p.includes('/robot/flow/step/list/'))data=p.endsWith('/child-flow')||p.endsWith('/public-flow')?childRows:rows
    else if(p.endsWith('/robot/flow/step/save')){rows=body;data=true}
    else if(p.endsWith('/robot/action/all'))data=[{actionCode:'page',actionName:'网页',groupName:'浏览器'},{actionCode:'h5Login',actionName:'H5登录'},{actionCode:'subFlow',actionName:'调用流程'}]
    else if(p.endsWith('/robot/action/args'))data=u.searchParams.get('dataCode')==='h5Login'?h5Definitions:u.searchParams.get('dataCode')==='subFlow'?[{fieldKey:'flowName',fieldName:'流程名称',fieldType:'text',required:1}]:[{fieldKey:'url',fieldName:'访问地址',fieldType:'text',required:1}]
    else if(p.endsWith('/robot/action/target/args'))data=u.searchParams.get('dataCode')==='h5Login'?[{fieldKey:'attrType',fieldName:'操作对象',fieldType:'singleDropList',robotDataDicts:[{dictCode:'xpath',dictName:'XPath'}]},{fieldKey:'attrValue',fieldName:'属性值'}]:[]
    else if(p.endsWith('/robot/task/listAllTask')){
      if(holdAccounts){holdAccounts=false;await new Promise(resolve=>{releaseAccounts=resolve})}
      if(index===1&&failAccounts){res.writeHead(500);res.end('{"message":"账户读取暂时失败"}');return}
      data=[{taskCode:index?'account-two':'account-one',taskName:index?'第二执行器账户':'第一执行器账户'}]
    }else if(p.includes('/robot/start/remoteTaskFlow/')){
      await new Promise(resolve=>{releaseProduction=resolve})
      if(productionResponse==='disconnect'){req.socket.destroy();return}
      if(productionResponse==='failure'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:500,message:'常规运行失败'}));return}
      data=[{stepCode:'one',stepName:'打开浏览器',status:1},{stepCode:'two',stepName:'业务办理',status:0,error:'模拟步骤错误'}]
    }else if(p.endsWith('/robot/start/status'))data=badConnectStatus?99:stoppedExecutor?-1:0
    else {throw new Error('Unexpected endpoint '+p)}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:200,data}))
  }catch(error){errors.push(error.message);res.writeHead(500);res.end(JSON.stringify({message:error.message}))}
}))
const deadline=setTimeout(()=>{console.error('Design acceptance timed out');app.exit(1)},60000)
app.on('web-contents-created',(_event,contents)=>{
  contents.on('preload-error',(_e,file,error)=>errors.push(file+': '+error.message))
  contents.on('console-message',(_e,details,message)=>{if(details?.level==='error'||details===3)errors.push(details?.message||message)})
})
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
  if(!win.webContents.getURL().endsWith('/index.html'))return
  const run=code=>win.webContents.executeJavaScript(code,true)
  const wait=async(code,execute=run)=>{for(let i=0;i<150;i++){if(await execute(code))return;await new Promise(resolve=>setTimeout(resolve,30))}throw new Error('Timed out '+code)}
  const shot=async(name,target=win)=>{target.show();target.focus();await new Promise(resolve=>setTimeout(resolve,160));await Promise.race([target.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'),new Promise(resolve=>setTimeout(resolve,250))]);fs.writeFileSync(path.join(artifacts,name+'.png'),(await target.webContents.capturePage()).toPNG())}
  let popup
  try{
    await Promise.all(servers.map(server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))))
    const endpoints=servers.map(server=>'http://127.0.0.1:'+server.address().port)
    await run(`(async()=>{await desktop.invoke('auth:login',{baseUrl:${JSON.stringify(endpoints[0]+'/api')},username:'test',password:'offline-user'});const result=await desktop.invoke('platforms:save',[{name:'测试平台',url:${JSON.stringify(endpoints[0]+'/api')},username:'test',password:'offline'}]);await desktop.invoke('platform:select',result.platforms[0].id);await desktop.invoke('settings:save',{remoteEnabled:true,connections:${JSON.stringify(endpoints.map(baseUrl=>({baseUrl,debugToken:'offline'})))},modelName:'离线模型'});await bootstrap();await initializeManagement();setView('applications')})()`)
    await wait('managed.rows.length===2')
    assert.equal(await run('$("applications").hidden'),false)
    assert.deepEqual(await run('[...$("applicationTable").querySelectorAll("th")].map(th=>th.textContent)'),['应用名称','版本状态','版本号','最新发布时间','操作'])
    assert.deepEqual(await run('[...$("applicationTable").querySelectorAll("td.actions")].map(cell=>[...cell.querySelectorAll("button")].map(button=>button.textContent))'),[['流程设计'],['流程设计']])
    assert.match(await run('$("applicationTable").textContent'),/V0.0.50/)
    checks.push('home-application-table-five-headers','only-design-row-action','application-version-and-release-data')
    await shot('design-home-applications')
    const initialFlowReads=requests.filter(item=>item.path.endsWith('/robot/flow/list')).length,initialAppReads=requests.filter(item=>item.path.endsWith('/robot/app/page')).length
    const opened=new Promise(resolve=>app.once('browser-window-created',(_event,child)=>resolve(child)))
    await run('$("applicationTable").querySelector("td.actions button").click()');popup=await opened
    const pr=code=>popup.webContents.executeJavaScript(code,true)
    const firstShown=new Promise(resolve=>popup.once('show',()=>pr('({view:document.body.dataset.currentView,applications:getComputedStyle($("applications")).display})').then(resolve)))
    await wait('$("designConnectDialog").open',pr)
    assert.equal(await pr('$("designConnectDialog").getBoundingClientRect().width>300'),true)
    assert.equal(requests.filter(item=>item.path.endsWith('/robot/flow/list')).length,initialFlowReads)
    await shot('design-connect-executor',popup)
    badConnectStatus=true
    await pr(`$('designConnectExecutor').value=${JSON.stringify(endpoints[0])};$('designConnectForm').requestSubmit()`)
    await wait('!$("confirmDesignConnect").disabled&&$("designConnectError").textContent.includes("无法连接")',pr)
    assert.equal(await pr('$("designConnectDialog").open'),true)
    badConnectStatus=false;await pr('$("designConnectForm").requestSubmit()')
    for(let i=0;i<150&&!releaseFirstFlowList;i++)await new Promise(resolve=>setTimeout(resolve,20))
    assert.ok(releaseFirstFlowList)
    assert.equal(popup.isVisible(),true)
    assert.equal(await pr('getComputedStyle($("applications")).display'),'none')
    assert.equal(await pr('document.body.dataset.currentView'),'flowManagement')
    releaseFirstFlowList()
    await wait('document.documentElement.dataset.designReady==="true"',pr)
    assert.deepEqual(await firstShown,{view:'flowManagement',applications:'none'})
    performanceMetrics.designFlowReads=requests.filter(item=>item.path.endsWith('/robot/flow/list')).length-initialFlowReads
    performanceMetrics.designApplicationReads=requests.filter(item=>item.path.endsWith('/robot/app/page')).length-initialAppReads
    assert.equal(performanceMetrics.designFlowReads,1);assert.equal(performanceMetrics.designApplicationReads,1)
    checks.push('design-opens-with-one-flow-and-one-application-read')
    checks.push('slow-initial-load-never-shows-home','first-visible-frame-is-flow-management')
    assert.equal(popup.getTitle(),'西安-社保（连接至 '+new URL(endpoints[0]).host+'）');assert.equal(popup.getParentWindow(),null)
    checks.push('executor-choice-before-flow-loading','executor-connection-failure-retains-picker','window-title-shows-selected-executor')
    assert.equal(popup.isMenuBarVisible(),false)
    assert.equal(await run('document.body.dataset.currentView'),'applications')
    assert.equal(await pr('getComputedStyle(document.querySelector(".sidebar")).display'),'none')
    assert.equal(await pr('getComputedStyle($("flowManagement").querySelector(".panel-heading")).display'),'none')
    assert.equal(await pr('managed.flows.length'),2)
    assert.deepEqual(await pr('[...$("flowManagementTable").querySelectorAll("th")].map(header=>header.textContent)'),['执行顺序','服务项目','流程类型','申报系统','运行载体','流程名称','备注','标签','更新时间','操作'])
    assert.equal(await pr('!!$("flowStatistics")'),false)
    assert.equal(await pr('Math.abs($("designTabs").getBoundingClientRect().bottom-$("flowManagement").getBoundingClientRect().top)<=1'),true)
    assert.equal(await pr('[...document.querySelectorAll(".flow-filter-caption")].every(label=>label.classList.contains("sr-only"))'),true)
    checks.push('compact-flow-columns-without-status-or-step-count','flow-statistics-removed','tabs-connected-to-flow-panel','filter-labels-accessible-without-title-row')
    assert.equal(await pr('$("newFlow").getBoundingClientRect().width>0&&$("organizeFlows").getBoundingClientRect().width>0'),true)
    assert.deepEqual(await pr('[...$("flowManagementTable").querySelectorAll("td.actions")].map(cell=>[...cell.querySelectorAll("button")].map(button=>button.textContent))'),[['AI配置','编辑'],['AI配置','编辑']])
    assert.equal(await pr('getComputedStyle($("flowServices")).display'),'none')
    assert.equal(await pr('document.querySelector(".flow-type-options").getBoundingClientRect().right<=document.querySelector(".flow-filter-trigger").getBoundingClientRect().left'),true)
    await pr('document.querySelector("#flowServices").parentElement.querySelector(".flow-filter-trigger").click()');await wait('$("flowServicesPopup").matches(":popover-open")',pr)
    await pr('$("flowServicesPopup").querySelector("input[type=search]").value="增员";$("flowServicesPopup").querySelector("input[type=search]").dispatchEvent(new Event("input"))')
    assert.equal(await pr('[...$("flowServicesPopup").querySelectorAll(".flow-filter-options label")].filter(label=>!label.hidden).length'),1)
    await shot('design-flow-filter',popup)
    await pr('[...$("flowServicesPopup").querySelectorAll("input[type=checkbox]")].find(box=>box.value==="1").click();$("searchManagedFlows").click()');await wait('managed.flows.length===1',pr)
    assert.equal(await pr('managed.flows[0].flowCode'),'flow2')
    assert.equal(requests.filter(item=>item.path.endsWith('/robot/flow/list')).at(-1).body.serviceItemList[0],1)
    await pr('$("resetManagedFlows").click()');await wait('managed.flows.length===3',pr)
    assert.equal(await pr('$("flowServicesPopup").querySelector("input[type=search]").value'),'')
    await pr('[...$("flowTypes").options].forEach(option=>option.selected=option.value==="1");$("searchManagedFlows").click()');await wait('managed.flows.length===2',pr)
    checks.push('design-window-without-native-menu','only-step-and-edit-row-actions','searchable-checkbox-dropdown-filter','filter-query-and-reset')
    checks.push('native-application-design-window','no-duplicate-flow-header-or-sidebar','main-flow-default-filter')
    await shot('design-flow-list',popup)
    await pr('desktop.invoke("appearance:save",{mode:"light",accent:"blue",density:"comfortable"})');await shot('design-flow-list-light',popup)
    await pr('desktop.invoke("appearance:save",{mode:"dark",accent:"blue",density:"comfortable"})')
    await pr('$("flowManagementTable").querySelectorAll("td.actions button")[1].click()');await wait('$("businessDialog").open&&!!document.querySelector("[data-field=execOrder]")',pr)
    assert.equal(await pr('document.querySelector("[data-field=execOrder]").max'),'3')
    await pr('document.querySelector("[data-field=execOrder]").value="999"');assert.equal(await pr('$("businessForm").checkValidity()'),false)
    failOrder=true;await pr('document.querySelector("[data-field=execOrder]").value="3";$("businessForm").requestSubmit()');await wait('!businessPending&&$("businessError").textContent.includes("排序未完成")',pr)
    assert.equal(await pr('$("businessDialog").open'),true)
    failOrder=false;await pr('$("businessForm").requestSubmit()');await wait('!businessPending&&!$("businessDialog").open',pr)
    assert.equal(flows.find(flow=>flow.flowCode==='flow').execOrder,3)
    await pr('$("flowManagementTable").querySelectorAll("td.actions button")[1].click()');await wait('$("businessDialog").open&&!!$("deleteEditedFlow")',pr)
    assert.equal(await pr('$("deleteEditedFlow").disabled'),true)
    await pr('document.querySelector(".flow-delete-zone summary").click()');assert.equal(await pr('$("deleteEditedFlow").getBoundingClientRect().width>0'),true)
    await shot('design-flow-edit',popup)
    failDelete=true;await pr('$("confirmFlowDeletion").click();$("deleteEditedFlow").click()');await wait('!businessPending&&$("businessError").textContent.includes("删除暂时失败")',pr)
    assert.equal(await pr('$("businessDialog").open'),true);assert.equal(flows.length,3)
    failDelete=false;await pr('$("deleteEditedFlow").click()');await wait('!businessPending&&!$("businessDialog").open',pr);assert.equal(flows.length,2)
    checks.push('edit-order-complete-range-and-save','edit-delete-confirmation-required','delete-failure-retains-dialog-and-retries')
    holdAccounts=true
    const stepOpenStart=Date.now(),stepOpenReads=requests.filter(item=>item.path.endsWith('/robot/flow/list')).length
    await pr('$("flowManagementTable").querySelector("td.actions button").click()');await wait('current?.scope.flowCode==="flow"',pr)
    performanceMetrics.stepPageOpenMs=Date.now()-stepOpenStart
    assert.equal(await pr('document.body.dataset.currentView==="workspace"&&taskLoading&&$("stepRun").disabled'),true)
    assert.equal(requests.filter(item=>item.path.endsWith('/robot/flow/list')).length-stepOpenReads,1)
    await pr('window.originalStepRow=$("stepTree").firstElementChild;showStepProperties([0])')
    assert.equal(await pr('$("stepPropertiesDialog").open&&$("stepTree").firstElementChild===window.originalStepRow'),true)
    await pr('$("closeStepProperties").click()')
    for(let i=0;i<150&&!releaseAccounts;i++)await new Promise(resolve=>setTimeout(resolve,20))
    assert.ok(releaseAccounts);releaseAccounts();await wait('!taskLoading&&$("task").options.length===2',pr)
    checks.push('step-editor-opens-before-slow-account-response','step-open-avoids-redundant-flow-list','property-dialog-does-not-rebuild-step-tree')
    const firstSession=await pr('current.id'),beforeTabClose=confirmations
    assert.equal(await pr('$("stepTree").querySelectorAll(".step-modified").length'),0)
    assert.equal(await pr('$("stepTree").querySelector("[data-step-code=child]").classList.contains("step-voided")'),true)
    const openAnother=async (appCode,endpoint=endpoints[0])=>{
      const created=new Promise(resolve=>app.once('browser-window-created',(_event,child)=>resolve(child)))
      await run(`desktop.invoke('design:open',{platformId:managed.platformId,appCode:${JSON.stringify(appCode)}})`)
      const child=await created,execute=code=>child.webContents.executeJavaScript(code,true)
      await wait('$("designConnectDialog").open',execute)
      await execute(`$('designConnectExecutor').value=${JSON.stringify(endpoint)};$('designConnectForm').requestSubmit()`)
      await wait('document.documentElement.dataset.designReady==="true"',execute)
      return {child,execute}
    }
    const otherApp=await openAnother('app2'),sameApp=await openAnother('app')
    assert.equal(popup.isModal(),false);assert.equal(otherApp.child.isModal(),false);assert.equal(sameApp.child.isModal(),false);assert.equal(win.isEnabled(),true)
    const minimized=new Promise(resolve=>win.once('minimize',resolve));win.minimize();await minimized
    await new Promise(resolve=>setTimeout(resolve,150))
    assert.equal(win.isMinimized(),true)
    for(const design of [popup,otherApp.child,sameApp.child]){
      assert.equal(design.getParentWindow(),null);assert.equal(design.isVisible(),true);assert.equal(design.isMinimized(),false)
    }
    assert.equal(await pr('document.body.dataset.currentView'),'workspace')
    const restored=new Promise(resolve=>win.once('restore',resolve));win.restore();await restored
    for(const design of [popup,otherApp.child,sameApp.child])assert.equal(design.isVisible(),true)
    checks.push('main-minimize-keeps-all-design-windows-visible','main-restore-preserves-independent-design-windows')
    assert.equal(await otherApp.execute('managed.app.appCode'),'app2')
    await sameApp.execute('openManagedSteps(managed.flows.find(row=>row.flowCode==="flow"))')
    await wait('!!current&&!taskLoading',sameApp.execute)
    assert.notEqual(await sameApp.execute('current.id'),firstSession)
    assert.match(await sameApp.execute(`desktop.invoke('workspace:attach',${JSON.stringify(firstSession)}).then(()=>'unexpected',error=>error.message)`),/另一个窗口/)
    await sameApp.execute('$("stepName").value="另一窗口独立草稿";$("commitStep").click()')
    await wait('current.dsl.steps[0].stepName==="另一窗口独立草稿"',sameApp.execute)
    assert.equal(await pr('current.dsl.steps[0].stepName'),'打开浏览器')
    decision=1
    const sameClosed=new Promise(resolve=>sameApp.child.once('closed',resolve));sameApp.child.close();await sameClosed
    const otherClosed=new Promise(resolve=>otherApp.child.once('closed',resolve));otherApp.child.close();await otherClosed
    decision=0
    assert.equal(popup.isDestroyed(),false);assert.equal(win.isEnabled(),true);assert.equal(await pr('current.id'),firstSession)
    checks.push('multiple-design-windows-do-not-block-main-window','same-app-windows-have-independent-editing-sessions','closing-one-design-keeps-other-windows-and-drafts')
    const beforeMultiClose=confirmations
    await pr('$("stepName").value="Tab 未提交输入";$("closeDesignStepTab").click()')
    for(let i=0;i<100&&confirmations===beforeMultiClose;i++)await new Promise(resolve=>setTimeout(resolve,10))
    assert.ok(confirmations>beforeMultiClose);assert.equal(await pr('current.id'),firstSession)
    decision=1;await pr('$("closeDesignStepTab").click()');await wait('!current&&$("designStepTabGroup").hidden&&document.body.dataset.currentView==="flowManagement"',pr)
    assert.equal(popup.isDestroyed(),false)
    decision=0;await pr('$("flowManagementTable").querySelector("td.actions button").click()');await wait('!!current&&current.id!=='+JSON.stringify(firstSession),pr)
    assert.equal(await pr('$("toggleAgent").getAttribute("aria-expanded")'),'true')
    assert.equal(await pr('$("stepPropertiesDialog").open'),false)
    assert.equal(await pr('getComputedStyle($("toggleAgent")).display'),'none')
    assert.equal(await pr('document.querySelector(".step-workspace-toolbar").contains($("retryTasks"))'),false)
    assert.equal(await pr('$("stepExecutor").previousElementSibling.classList.contains("sr-only")'),true)
    assert.equal(await pr('$("task").closest(".agent-composer-controls").contains($("mode"))&&$("mode").nextElementSibling===$("send")'),true)
    assert.equal(await pr('$("designPageActions").contains($("stepSave"))&&$("viewExecutionDetails").disabled'),true)
    assert.equal(await pr('getComputedStyle(document.querySelector(".step-workspace-toolbar")).display'), 'none')
    checks.push('account-mode-send-on-agent-bottom-row','save-and-disabled-filter-on-tabbar')
    assert.equal(await pr('document.querySelector(".agent>.panel-heading").contains($("agentSessionMenuTrigger"))&&["runCurrent","assertions","history","stopAgent","viewExecutionDetails","steer"].every(id=>$("agentSessionMenu").contains($(id)))'),true)
    await pr('$("agentSessionMenuTrigger").click()');await wait('$("agentSessionMenu").matches(":popover-open")',pr)
    await pr('$("assertions").click()');await wait('$("jsonDialog").open',pr)
    assert.equal(await pr('$("agentSessionMenu").matches(":popover-open")'),false)
    await pr('$("jsonDialog").close()')
    checks.push('step-tab-close-can-cancel-unsaved-input','step-tab-closes-without-closing-window','step-tab-can-reopen','top-labels-and-agent-refresh-buttons-removed','agent-actions-consolidated-at-footer','footer-assertions-open-and-dismiss-menu')
    assert.equal(await pr('getComputedStyle($("workspace").querySelector(".agent")).display'),'flex')
    assert.equal(await pr('getComputedStyle($("workspace").querySelector(".toolbar")).display'),'none')
    assert.equal(await pr('$("stepExecutor").value'),endpoints[0])
    assert.equal(await pr('$("task").options[1].value'),'account-one')
    assert.equal(await pr('$("stepTree").querySelectorAll(".step-row.child").length'),1)
    checks.push('default-two-column-agent-open','no-extra-metadata-selector-rail','executor-before-account','nested-step-rows')
    assert.equal(await pr('getComputedStyle($("notice")).display'),'none')
    assert.equal(await pr('getComputedStyle(document.querySelector(".step-workspace-toolbar>div:first-child")).display'),'none')
    assert.equal(await pr('getComputedStyle(document.querySelector(".steps>.panel-heading")).display'),'none')
    assert.equal(await pr('$("stepCount").textContent'),'步骤（3）')
    assert.equal(await pr('$("hideDisabledSteps").checked'),false)
    assert.equal(await pr('$("hideDisabledSteps").parentElement.textContent'),'隐藏禁用步骤')
    assert.equal(await pr('getComputedStyle($("stepTree").querySelector("[data-step-code=child]")).display'),'flex')
    const filterRevision=await pr('current.revision')
    await pr('$("stepName").value="筛选时保留输入";$("hideDisabledSteps").click()')
    assert.equal(await pr('getComputedStyle($("stepTree").querySelector("[data-step-code=child]")).display'),'none')
    assert.equal(await pr('$("stepName").value'),'筛选时保留输入')
    assert.equal(await pr('current.revision'),filterRevision)
    assert.equal(await pr('$("stepCount").textContent'),'步骤（3）')
    await pr('$("hideDisabledSteps").click();renderProperties()')
    checks.push('compact-step-count-header-includes-voided-and-nested-steps','voided-checkbox-filters-display-without-changing-draft-or-input')
    assert.equal(await pr('[...$("stepTree").querySelectorAll(".step-row")].every(row=>row.getBoundingClientRect().height<=42)'),true)
    const drag=async(sourceCode,targetCode,position='before')=>pr(`(()=>{const list=[...$('stepTree').querySelectorAll('.step-row')],source=list.find(row=>row.dataset.stepCode===${JSON.stringify(sourceCode)}),target=list.find(row=>row.dataset.stepCode===${JSON.stringify(targetCode)}),transfer=new DataTransfer(),rect=target.getBoundingClientRect();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer,clientY:${JSON.stringify(position)}==='after'?rect.bottom-1:rect.top+1}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:transfer}))})()`)
    await drag('one','two','after');await wait('current.dsl.steps[0].stepCode==="two"',pr)
    assert.equal(await pr('current.dsl.steps[1].children[0].stepCode'),'child')
    assert.equal(rows[0].stepCode,'one')
    const revision=await pr('current.revision');await drag('two','child');assert.equal(await pr('current.revision'),revision)
    assert.match(await pr('$("stepToast").textContent'),/同一层级/)
    await drag('one','two');await wait('current.dsl.steps[0].stepCode==="one"',pr)
    await pr('$("stepTree").querySelector(".step-add").click()');await wait('$("stepInsertDialog").open',pr)
    await shot('design-step-insert',popup)
    await pr('$("stepInsertCommand").value="page";$("stepInsertName").value="行内新增步骤";$("stepInsertForm").requestSubmit()');await wait('current.dsl.steps.length===3&&!$("stepInsertDialog").open',pr)
    assert.equal(await pr('current.dsl.steps[1].stepName'),'行内新增步骤')
    await pr('showStepProperties([1])');await wait('$("actionFields").querySelector("[data-argument-key=url]")',pr)
    await pr('const urlInput=$("actionFields").querySelector("[data-argument-key=url]");urlInput.value="https://example.test/new";urlInput.dispatchEvent(new Event("input"));$("commitStep").click()');await wait('current.dsl.steps[1].actionArgs.url==="https://example.test/new"',pr)
    await pr('$("closeStepProperties").click()');await wait('!$("stepPropertiesDialog").open',pr)
    await pr('selected=[0];renderWorkspace();$("copyStep").click();$("stepTree").querySelector(".step-add").click();$("stepInsertMode").value="paste";$("stepInsertMode").dispatchEvent(new Event("change"));$("stepInsertForm").requestSubmit()');await wait('current.dsl.steps.length===4&&!$("stepInsertDialog").open',pr)
    assert.notEqual(await pr('current.dsl.steps[1].stepCode'),'one')
    assert.notEqual(await pr('current.dsl.steps[1].children[0].stepCode'),'child')
    await pr('selected=[1];renderWorkspace();$("deleteStep").click()');await wait('current.dsl.steps.length===3',pr)
    await pr('$("stepTree").querySelector(".step-add").click();$("stepInsertMode").value="copy";$("stepInsertMode").dispatchEvent(new Event("change"));$("stepInsertForm").requestSubmit()');await wait('current.dsl.steps.length===4&&!$("stepInsertDialog").open',pr)
    assert.notEqual(await pr('current.dsl.steps[1].children[0].stepCode'),'child')
    await pr('selected=[1];renderWorkspace();$("deleteStep").click()');await wait('current.dsl.steps.length===3',pr)
    await pr('$("stepTree").querySelector(".step-add").click();$("stepInsertLevel").value="child";$("stepInsertCommand").value="page";$("stepInsertName").value="弹框子步骤";$("stepInsertForm").requestSubmit()');await wait('current.dsl.steps[0].children.length===2&&!$("stepInsertDialog").open',pr)
    assert.equal(await pr('current.dsl.steps[0].children[1].stepName'),'弹框子步骤')
    await pr('$("stepTree").querySelectorAll(".step-row.child .step-add")[1].click()')
    assert.equal(await pr('$("stepInsertLevel").querySelector("[value=child]").disabled'),true)
    await pr('$("closeStepInsert").click();selected=[0,"children",1];renderWorkspace();$("deleteStep").click()');await wait('current.dsl.steps[0].children.length===1',pr)
    await pr('$("stepTree").querySelector(".step-add").click();$("stepInsertName").value=current.dsl.steps[0].stepName;$("stepInsertForm").requestSubmit()');await wait('$("stepInsertError").textContent.includes("已存在")',pr)
    assert.equal(await pr('$("stepInsertDialog").open&&current.dsl.steps.length===3'),true)
    await pr('$("stepInsertName").value="过期新增";stepInsertTarget.revision--;$("stepInsertForm").requestSubmit()');await wait('$("stepInsertError").textContent.includes("版本已变化")',pr)
    await pr('$("closeStepInsert").click();window.savedInsertDsl=structuredClone(current.dsl);updateDsl({...current.dsl,steps:[]})');await wait('current.dsl.steps.length===0',pr)
    await pr('$("stepTree").querySelector("button").click()');assert.equal(await pr('$("stepInsertDialog").open&&$("stepInsertLevel").disabled&&!$("jsonDialog").open'),true)
    await pr('$("stepInsertCommand").value="page";$("stepInsertName").value="首个步骤";$("stepInsertForm").requestSubmit()');await wait('current.dsl.steps.length===1&&!$("stepInsertDialog").open',pr)
    await pr('updateDsl(window.savedInsertDsl)');await wait('current.dsl.steps.length===3',pr)
    checks.push('plus-dialog-copies-current-branch-with-new-identifiers','plus-dialog-adds-child-and-prevents-third-level','plus-dialog-retains-form-on-name-conflict','plus-dialog-rejects-stale-revision','empty-flow-uses-the-same-add-dialog')
    checks.push('compact-single-line-step-rows','step-page-headings-and-banner-removed','drag-moves-whole-branch-without-auto-saving','cross-level-drop-is-rejected','row-add-inserts-at-anchor','row-paste-rebuilds-branch-identifiers')
    await shot('design-step-agent',popup)
    await pr('$("task").value="account-one";$("task").dispatchEvent(new Event("change"))');await wait('current.taskCode==="account-one"',pr)
    await pr('$("stepTree").querySelector(".step-settings").click()');await wait('$("stepPropertiesDialog").open',pr)
    assert.equal(await pr('$("targetFields").closest("section").querySelector("h3").textContent'), '目标参数')
    assert.equal(await pr('$("actionFields").closest("section").querySelector("h3").textContent'), '行为参数')
    assert.equal(await pr('[...document.querySelectorAll(".argument-json")].every(details=>!details.open)'),true)
    await pr('$("actionArgs").closest("details").open=true;$("actionArgs").dispatchEvent(new Event("input"));$("actionArgs").closest("details").open=false')
    checks.push('target-and-action-parameter-sections','parameter-json-collapsed-by-default')
    assert.equal(await pr(`['flowGraph','showDsl','loadAction','moveUp','moveDown','deleteStep','recording','captureArgument','imageArgument'].every(id=>!$(id).getClientRects().length)`),true)
    assert.equal(await pr('!$("stepParametersPanel").hidden&&$("stepPolicyPanel").hidden'),true)
    await pr('$("stepPolicyTab").click()')
    assert.equal(await pr('$("stepParametersPanel").hidden&&!$("stepPolicyPanel").hidden&&$("stepPolicyTab").getAttribute("aria-selected")==="true"'),true)
    await pr('document.querySelector("[data-step-option=timeout]").value="77";document.querySelector("[data-step-option=timeout]").dispatchEvent(new Event("input"));$("stepParametersTab").click()')
    assert.equal(await pr('JSON.parse($("stepOptions").value).timeout'),77)
    await pr('$("stepName").value="修复后的养老登录";$("commitStep").click()');await wait('current.dsl.steps[0].stepName==="修复后的养老登录"',pr)
    assert.equal(await pr('current.dsl.steps[0].timeout'),77)
    assert.equal(await pr('$("stepTree").querySelector("[data-step-code=one]").classList.contains("step-modified")'),true)
    await pr('$("stepPolicyTab").dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true}))')
    assert.equal(await pr('document.activeElement.id'), 'stepParametersTab')
    await shot('design-step-properties',popup)
    await pr('$("stepPropertiesDialog").scrollTop=10000')
    assert.equal(await pr('$("closeStepProperties").getBoundingClientRect().top>=$("stepPropertiesDialog").getBoundingClientRect().top'),true)
    checks.push('step-properties-marked-actions-removed','step-properties-tabs-retain-parameter-and-policy-edits','step-properties-keyboard-tabs-and-sticky-close')
    await pr('$("closeStepProperties").click()');await wait('!$("stepPropertiesDialog").open',pr)
    assert.equal(await pr('getComputedStyle($("stepTree").querySelector(".step-modified")).backgroundColor!==getComputedStyle($("stepTree").querySelector(".step-voided")).backgroundColor'),true)
    await shot('design-step-states-dark',popup)
    await pr('desktop.invoke("appearance:save",{mode:"light",accent:"blue",density:"comfortable"})');await wait('document.documentElement.dataset.theme==="light"',pr);await shot('design-step-states-light',popup)
    await pr('desktop.invoke("appearance:save",{mode:"dark",accent:"blue",density:"comfortable"})')
    await pr('$("stepSave").click()');await wait('!$("saveFlow").disabled',pr);assert.equal(rows[0].stepName,'修复后的养老登录')
    assert.equal(await pr('$("stepTree").querySelectorAll(".step-modified").length'),0)
    assert.equal(await pr('$("stepTree").querySelector("[data-step-code=child]").classList.contains("step-voided")'),true)
    checks.push('voided-step-background-on-open','modified-step-background-clears-only-after-save','selected-and-voided-step-states-in-both-themes')
    checks.push('step-gear-opens-properties','toolbar-save-keeps-native-format')
    const nativePath='/api/robot/start/remoteTaskFlow/account-one/flow',debugCount=requests.filter(item=>item.path.includes('/robot/debug/')).length,turnBefore=await pr('current.turn?.id||null'),beforeRunConfirmations=confirmations
    await pr('$("request").value="仅运行时不发送模型";$("mode").value="run";$("mode").dispatchEvent(new Event("change"))')
    assert.equal(await pr('$("send").textContent'),'运行')
    assert.equal(await pr('$("request").disabled'),true)
    await pr('$("send").click()')
    for(let i=0;i<150&&!releaseProduction;i++)await new Promise(resolve=>setTimeout(resolve,20))
    assert.ok(releaseProduction)
    await wait('current.productionRunning&&$("stepRun").disabled',pr)
    assert.equal(await pr('$("task").disabled&&$("stepSave").disabled&&$("runCurrent").disabled&&$("send").disabled&&$("stopAgent").disabled'),true)
    await pr('$("send").click()')
    assert.equal(requests.filter(item=>item.path===nativePath).length,1)
    assert.equal(requests.find(item=>item.path===nativePath).method,'GET')
    assert.match(await pr('desktop.invoke("workspace:update",current.id,{taskCode:""}).then(()=>"unexpected",error=>error.message)'),/运行期间/)
    assert.match(await pr('desktop.invoke("workspace:run",current.id).then(()=>"unexpected",error=>error.message)'),/运行|等待/)
    assert.equal(confirmations,beforeRunConfirmations)
    await shot('design-production-running',popup)
    releaseProduction();releaseProduction=null
    await wait('$("jsonDialog").open&&!productionRunning&&!current.productionRunning&&!$("stepRun").disabled',pr)
    assert.equal(await pr('$("dialogTitle").textContent'),'执行明细')
    assert.match(await pr('$("dialogList").textContent'),/成功.*失败.*模拟步骤错误/s)
    assert.equal(requests.filter(item=>item.path.includes('/robot/debug/')).length,debugCount)
    assert.equal(await pr('current.turn?.id||null'),turnBefore)
    await pr('$("jsonDialog").close()')
    const readsBeforeDetails=requests.length
    await pr('$("stepName").value="查看明细时保留";$("agentSessionMenuTrigger").click()');await wait('$("agentSessionMenu").matches(":popover-open")',pr)
    await pr('$("viewExecutionDetails").click()');await wait('$("jsonDialog").open',pr)
    assert.equal(await pr('$("agentSessionMenu").matches(":popover-open")'),false)
    assert.match(await pr('$("dialogList").textContent'),/模拟步骤错误/)
    assert.equal(await pr('$("stepName").value'),'查看明细时保留')
    assert.equal(requests.length,readsBeforeDetails)
    await pr('$("jsonDialog").close();renderProperties()')
    checks.push('save-button-in-step-header-and-details-beside-run','details-reopens-saved-execution-without-rerun-or-losing-input')
    checks.push('run-button-calls-normal-run-get-with-account-and-flow','normal-run-never-starts-agent-or-dsl-debug','normal-run-blocks-duplicate-clicks-and-edits-without-permission-prompt','normal-run-displays-executor-step-results')
    productionResponse='failure';await pr('$("send").click()')
    for(let i=0;i<150&&!releaseProduction;i++)await new Promise(resolve=>setTimeout(resolve,20))
    assert.ok(releaseProduction);releaseProduction();releaseProduction=null
    await wait('!productionRunning&&!current.productionRunning&&!$("stepRun").disabled',pr)
    assert.equal(await pr('current.productionRun.state'),'failed')
    assert.equal(await pr('!!current.executionUncertain'),false)
    assert.equal(await pr('$("jsonDialog").open'),false)
    await pr('$("viewExecutionDetails").click()');await wait('$("jsonDialog").open',pr)
    assert.match(await pr('$("dialogHelp").textContent'),/运行失败.*常规运行失败/)
    assert.equal(await pr('$("dialogList").textContent.includes("模拟步骤错误")'),false)
    await pr('$("jsonDialog").close()')
    const nativeCount=requests.filter(item=>item.path===nativePath).length
    await pr('$("stepName").value="未提交输入";$("send").click()');await wait('$("stepToast").textContent.includes("先保存")',pr)
    assert.equal(requests.filter(item=>item.path===nativePath).length,nativeCount)
    await pr('renderProperties()')
    checks.push('normal-run-error-releases-busy-state','normal-run-rejects-unsaved-property-input')
    productionResponse='disconnect';await pr('$("send").click()')
    for(let i=0;i<150&&!releaseProduction;i++)await new Promise(resolve=>setTimeout(resolve,20))
    assert.ok(releaseProduction);releaseProduction();releaseProduction=null
    await wait('!productionRunning&&current.executionUncertain&&current.executorBlocked',pr)
    assert.equal(await pr('current.productionRun.state'),'unknown')
    assert.equal(await pr('$("reconcileExecutor").hidden'),false)
    const afterDisconnect=requests.filter(item=>item.path===nativePath).length
    assert.match(await pr('desktop.invoke("workspace:run",current.id).then(()=>"unexpected",error=>error.message)'),/未核对/)
    assert.equal(requests.filter(item=>item.path===nativePath).length,afterDisconnect)
    stoppedExecutor=true;await pr('desktop.invoke("agent:reconcile",current.id)');await wait('!current.executionUncertain&&!current.executorBlocked',pr);stoppedExecutor=false
    checks.push('disconnected-normal-run-is-unknown-and-not-replayed','normal-run-shares-executor-quarantine-and-stopped-reconciliation')
    await pr('$("mode").value="generate";$("mode").dispatchEvent(new Event("change"))')
    assert.equal(await pr('$("send").textContent'),'发送 ↑')
    assert.equal(await pr('$("request").disabled'),false)
    assert.equal(await pr('$("request").value'),'仅运行时不发送模型')
    await pr('$("mode").value="develop";$("mode").dispatchEvent(new Event("change"))')
    checks.push('run-only-mode-preserves-input-and-switches-back-to-agent-modes')
    await pr(`(async()=>{window.beforeH5Dsl=structuredClone(current.dsl);const args=${JSON.stringify(Object.fromEntries(h5Fields.map(field=>[field.key,'fixture'])))};args.validateType='qrCode';args.inputType='input';await updateDsl({...current.dsl,steps:current.dsl.steps.concat({stepCode:'h5-test',stepName:'h5扫码登录',actionCode:'h5Login',actionArgs:args,targetArgs:{attrType:'xpath',attrValue:'//input'}})});await showStepProperties([current.dsl.steps.length-1])})()`)
    await wait('!!$("actionFields").querySelector("[data-argument-key=qrCodeXpath]")',pr)
    const beforeDropdownRequests=requests.length
    assert.equal(await pr('!!$("actionFields").querySelector("[data-argument-key=inputType]")'),false)
    await pr(`window.originalTargetControl=$('targetFields').firstElementChild;window.chooseH5=(key,value)=>{const control=$('actionFields').querySelector('[data-argument-key="'+key+'"]');control.value=value;control.dispatchEvent(new Event('change'))};chooseH5('validateType','sms')`)
    await pr(`const smsInput=$('actionFields').querySelector('[data-argument-key=smsXpath]');smsInput.value='sms-locator';smsInput.dispatchEvent(new Event('input'));chooseH5('inputType','input')`)
    assert.equal(await pr('!!$("actionFields").querySelector("[data-argument-key=inputType]")&&!!$("actionFields").querySelector("[data-argument-key=inputXpath]")&&!$("actionFields").querySelector("[data-argument-key=qrCodeXpath]")'),true)
    await pr('chooseH5("inputType","keyboard")')
    assert.equal(await pr('!!$("actionFields").querySelector("[data-argument-key=inputXpath]")'),false)
    await pr('chooseH5("validateType","qrCode")')
    assert.equal(await pr('!!$("actionFields").querySelector("[data-argument-key=qrCodeXpath]")&&!$("actionFields").querySelector("[data-argument-key=inputType]")'),true)
    assert.equal(await pr('JSON.parse($("actionArgs").value).smsXpath'), 'sms-locator')
    assert.equal(await pr('$("targetFields").firstElementChild===window.originalTargetControl'),true)
    assert.equal(requests.length,beforeDropdownRequests)
    assert.equal(await pr('Math.abs($("stepName").parentElement.getBoundingClientRect().top-$("actionCode").parentElement.getBoundingClientRect().top)<2'),true)
    await shot('design-h5-dropdown-linkage',popup)
    await pr('renderProperties();closeStepProperties();updateDsl(window.beforeH5Dsl)');await wait('current.dsl.steps.every(step=>step.stepCode!=="h5-test")',pr)
    checks.push('h5-primary-and-nested-dropdown-linkage','hidden-branch-values-preserved-without-reviving-fields','dropdown-change-keeps-target-panel-and-avoids-new-requests','compact-name-and-command-layout')
    const rootSession=await pr('current.id'),beforeTabConfirmations=confirmations
    await pr(`window.beforeTabDsl=structuredClone(current.dsl);updateDsl({...current.dsl,steps:current.dsl.steps.concat({stepCode:'call-child',stepName:'调用公用子流程',actionCode:'subFlow',actionArgs:{flowName:'公用子流程'},targetArgs:{}})})`)
    await wait('!!$("stepTree").querySelector(".step-open-subflow")',pr)
    await pr('$("stepName").value="主流程未提交输入";$("stepTree").querySelector(".step-open-subflow").click()')
    await wait('current.scope.flowCode==="child-flow"&&!workspaceOpening&&!taskLoading',pr)
    const childSession=await pr('current.id')
    assert.equal(await pr('workspaceTabs.size'),2);assert.equal(await pr('current.taskCode'),'account-one')
    assert.equal(await pr('current.dsl.steps[0].stepCode'),'child-page')
    assert.equal(confirmations,beforeTabConfirmations)
    await pr('$("stepName").value="子流程未保存修改";$("commitStep").click()');await wait('current.dsl.steps[0].stepName==="子流程未保存修改"',pr)
    await pr(`document.querySelector('.extra-flow-tab[data-session-id="${rootSession}"]>button').click()`)
    await wait('current?.id==='+JSON.stringify(rootSession)+'&&!workspaceOpening',pr)
    assert.equal(await pr('$("stepName").value'),'主流程未提交输入')
    assert.equal(await pr('current.dsl.steps.some(step=>step.stepCode==="call-child")'),true)
    await pr('$("stepTree").querySelector(".step-open-subflow").click()');await wait('current?.id==='+JSON.stringify(childSession)+'&&!workspaceOpening',pr)
    assert.equal(await pr('workspaceTabs.size'),2);assert.equal(await pr('current.dsl.steps[0].stepName'),'子流程未保存修改')
    await shot('design-subflow-tabs',popup)
    const beforeChildClose=confirmations;await pr('$("closeDesignStepTab").click()')
    for(let i=0;i<100&&confirmations===beforeChildClose;i++)await new Promise(resolve=>setTimeout(resolve,10))
    assert.ok(confirmations>beforeChildClose);assert.equal(await pr('current.id'),childSession)
    decision=1;await pr('$("closeDesignStepTab").click()');await wait('current?.id==='+JSON.stringify(rootSession)+'&&!workspaceOpening',pr);decision=0
    assert.equal(await pr('workspaceTabs.size'),1)
    assert.match(await pr(`desktop.invoke('agent:snapshot',${JSON.stringify(childSession)}).then(()=>'unexpected',error=>error.message)`),/重新打开/)
    await pr('$("stepTree").querySelector(".step-open-subflow").click()');await wait('current?.scope.flowCode==="child-flow"&&!workspaceOpening',pr)
    assert.notEqual(await pr('current.id'),childSession);assert.equal(await pr('current.dsl.steps[0].stepName'),'子流程访问网页')
    await pr('$("closeDesignStepTab").click()');await wait('current?.id==='+JSON.stringify(rootSession)+'&&!workspaceOpening',pr)
    await pr('renderProperties();const next=structuredClone(current.dsl);next.steps.find(step=>step.stepCode==="call-child").actionArgs.flowName="公共引用流程";updateDsl(next)')
    await wait('current.dsl.steps.some(step=>step.actionArgs?.flowName==="公共引用流程")',pr)
    await pr('$("stepTree").querySelector(".step-open-subflow").click()');await wait('current.scope.flowCode==="public-flow"&&!workspaceOpening',pr)
    assert.equal(await pr('current.readOnly&&$("stepSave").disabled&&$("commitStep").disabled'),true)
    assert.match(await pr('desktop.invoke("workspace:save",current.id).then(()=>"unexpected",error=>error.message)'),/引用流程只读/)
    await pr('$("closeDesignStepTab").click()');await wait('current?.id==='+JSON.stringify(rootSession)+'&&!workspaceOpening',pr)
    await pr('renderProperties();updateDsl(window.beforeTabDsl)');await wait('!current.dsl.steps.some(step=>step.stepCode==="call-child")',pr)
    checks.push('subflow-step-opens-own-configuration-tab','tab-switch-keeps-parent-input-and-child-draft','reopen-subflow-reuses-its-tab','dirty-tab-close-can-cancel-and-return-to-parent','public-subflow-template-remains-readonly','discarded-child-draft-is-removed-from-active-execution-dependencies')
    failAccounts=true
    const alternate=await openAnother('app',endpoints[1]),ar=alternate.execute
    await ar('openManagedSteps(managed.flows.find(flow=>flow.flowCode==="flow"))');await wait('!!current&&!taskLoading',ar)
    assert.equal(await ar('current.taskCode||""'),'');assert.equal(await ar('$("task").options.length'),1);assert.match(await ar('$("notice").textContent'),/账户读取暂时失败/)
    failAccounts=false;await ar('$("retryTasks").click()');await wait('$("task").options.length===2',ar)
    assert.equal(await ar('$("task").options[1].value'),'account-two');assert.equal(await ar('current.runs.length'),0)
    assert.equal(await pr('current.scope.executor'),endpoints[0])
    assert.match(await pr(`desktop.invoke('workspace:open',{appCode:'app',flowCode:'flow',executor:${JSON.stringify(endpoints[1])}}).then(()=>'unexpected',error=>error.message)`),/本窗口/)
    const alternateClosed=new Promise(resolve=>alternate.child.once('closed',resolve));alternate.child.close();await alternateClosed
    checks.push('executor-switch-rebinds-session-and-clears-account','account-failure-retry-without-losing-editor','no-cross-executor-execution-history')
    popup.setSize(1040,700);await shot('design-step-compact',popup)
    assert.equal(await pr('document.documentElement.scrollWidth<=innerWidth'),true)
    performanceMetrics.largeFlow=await pr(`(async()=>{
      const original=structuredClone(current.dsl)
      await updateDsl({...current.dsl,steps:current.dsl.steps.concat(Array.from({length:500},(_,index)=>({stepCode:'perf-'+index,stepName:'性能步骤'+index,actionCode:'page',actionArgs:{url:'https://example.test'},targetArgs:{}})))})
      const firstRow=$('stepTree').firstElementChild,times=[]
      for(let index=0;index<5;index++){
        const start=performance.now();await showStepProperties([current.dsl.steps.length-1-index]);times.push(performance.now()-start)
        if($('stepTree').firstElementChild!==firstRow)throw new Error('打开属性不应重建步骤树')
        await closeStepProperties()
      }
      const result={steps:$('stepTree').querySelectorAll('.step-row').length,propertyOpenMs:times.map(value=>Math.round(value*100)/100)}
      await updateDsl(original);return result
    })()`)
    assert.ok(performanceMetrics.largeFlow.steps>=500)
    checks.push('large-flow-property-open-preserves-step-tree')
    for(let i=0;i<80;i++)flows.push({...flows[0],id:100+i,flowCode:'scroll-'+i,flowName:'列表滚动验证 '+i,execOrder:4+i})
    await pr('setView("flowManagement");refreshManagedFlows()');await wait('managed.flows.length>80',pr)
    assert.equal(await pr('$("flowManagementTable").scrollHeight>$("flowManagementTable").clientHeight'),true)
    assert.equal(await pr('$("mainContent").scrollHeight<=$("mainContent").clientHeight+1'),true)
    await shot('design-flow-scroll',popup);await pr('setView("workspace")')
    await pr('$("stepName").value="尚未更新的输入"')
    const before=confirmations;popup.close();await new Promise(resolve=>setTimeout(resolve,100));assert.ok(confirmations>before);assert.equal(popup.isDestroyed(),false)
    decision=1;const closed=new Promise(resolve=>popup.once('closed',resolve));popup.close();await closed
    checks.push('compact-window-layout','unsaved-popup-close-can-cancel')
    const survivingDesign=await openAnother('app2')
    const mainClosed=new Promise(resolve=>win.once('closed',resolve));win.close();await mainClosed
    assert.equal(survivingDesign.child.isDestroyed(),false);assert.equal(survivingDesign.child.isVisible(),true)
    checks.push('closing-main-keeps-independent-design-open')
    assert.deepEqual(errors,[])
    checks.push('partial-sort-failure-explained-and-retryable','long-flow-list-scrolls-inside-window')
    fs.writeFileSync(path.join(artifacts,'design-acceptance.json'),JSON.stringify({passed:true,checks,performanceMetrics,requests:requests.length,scope:'isolated loopback services',screenshots:['design-home-applications.png','design-flow-list.png','design-flow-list-light.png','design-flow-edit.png','design-flow-filter.png','design-flow-scroll.png','design-step-agent.png','design-step-compact.png','design-step-properties.png','design-step-insert.png']},null,2))
    console.log('Design acceptance passed: '+checks.length+' checks');clearTimeout(deadline);servers.forEach(server=>server.close());app.exit(0)
  }catch(error){console.error(error.stack,errors);await shot('design-failure',popup&&!popup.isDestroyed()?popup:win).catch(()=>{});clearTimeout(deadline);servers.forEach(server=>server.close());app.exit(1)}
}))
require('../src/main')
