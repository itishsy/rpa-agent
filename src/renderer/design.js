'use strict'
let workspaceOpening=false,taskLoading=false,taskLoadSequence=0,productionRunning=false
function selectPropertyTab(policy=false){
  for(const [tab,panel,active] of [['stepParametersTab','stepParametersPanel',!policy],['stepPolicyTab','stepPolicyPanel',policy]]){
    $(tab).setAttribute('aria-selected',String(active));$(tab).tabIndex=active?0:-1;$(panel).hidden=!active
  }
  if(policy)renderExecutionFields()
}
for(const [id,policy] of [['stepParametersTab',false],['stepPolicyTab',true]]){
  $(id).onclick=()=>selectPropertyTab(policy)
  $(id).onkeydown=event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
    event.preventDefault();const next=event.key==='Home'?false:event.key==='End'?true:!policy
    selectPropertyTab(next);$(next?'stepPolicyTab':'stepParametersTab').focus()
  }
}
$('actionCode').addEventListener('change',()=>loadActionSchemas().catch(error=>{$('actionSchema').textContent=error.message}))
const designAppCode=new URLSearchParams(location.search).get('designApp')
document.body.append($('designConnectDialog'))
async function chooseDesignExecutor(data,application){
  const executors=data.executors||[],saved=data.designExecutor
  if(saved&&executors.includes(saved)){
    $('executor').value=saved;document.title=(application.appName||application.appCode)+'（连接至 '+new URL(saved).host+'）';return
  }
  selectOptions($('designConnectExecutor'),executors,item=>item,item=>item,'请选择执行器')
  $('confirmDesignConnect').disabled=!executors.length
  $('designConnectError').textContent=executors.length?'':'尚未配置执行器，请在左侧执行器管理中添加连接后重新打开。'
  $('designFlowTab').textContent='RPA流程管理（'+(application.appName||application.appCode)+'）'
  const connected=new Promise(resolve=>{
    $('designConnectForm').onsubmit=async event=>{
      event.preventDefault();if($('confirmDesignConnect').disabled)return
      $('confirmDesignConnect').disabled=true;$('cancelDesignConnect').disabled=true;$('designConnectError').textContent='正在连接执行器…'
      try{
        const result=await invoke('design:connect',$('designConnectExecutor').value)
        $('executor').value=result.executor;document.title=result.title
        $('designConnectDialog').close();resolve()
      }catch(error){$('designConnectError').textContent=String(error.message).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'')}
      finally{$('confirmDesignConnect').disabled=false;$('cancelDesignConnect').disabled=false}
    }
  })
  $('cancelDesignConnect').onclick=()=>window.close()
  $('designConnectDialog').oncancel=event=>{event.preventDefault();if(!$('cancelDesignConnect').disabled)window.close()}
  $('designConnectDialog').showModal();await invoke('design:ready');await connected
}
$('taskSelectorHost').append($('task'))
const voidedStepsToggle=document.createElement('label');voidedStepsToggle.className='voided-steps-toggle'
const hideDisabledSteps=document.createElement('input');hideDisabledSteps.type='checkbox';hideDisabledSteps.id='hideDisabledSteps';hideDisabledSteps.setAttribute('aria-controls','stepTree')
voidedStepsToggle.append(hideDisabledSteps,document.createTextNode('隐藏禁用步骤'))
$('revision').before(voidedStepsToggle)
hideDisabledSteps.onchange=()=>$('stepTree').classList.toggle('hide-disabled',hideDisabledSteps.checked)
const viewExecutionDetails=document.createElement('button');viewExecutionDetails.id='viewExecutionDetails';viewExecutionDetails.type='button';viewExecutionDetails.textContent='查看执行明细';viewExecutionDetails.disabled=true
$('flowManagement').querySelector('.flow-filters').append($('organizeFlows'),$('newFlow'))
const executorStatusSection=document.createElement('section');executorStatusSection.className='saved-executor-status'
const executorStatusHeading=document.createElement('div');executorStatusHeading.className='panel-heading'
const executorStatusTitle=document.createElement('h2');executorStatusTitle.textContent='已保存连接状态'
executorStatusHeading.append(executorStatusTitle,$('refreshExecutors'));executorStatusSection.append(executorStatusHeading,$('executorSummary'),$('executorCards'),$('executorEmpty'))
$('executorStatusHost').append(executorStatusSection)
$('executorSettings').prepend($('executorPlatformControls'))
function updateDesignHeader() {
  if(!current)return
  $('workspaceFlowName').textContent=current.dsl.flowName||current.scope.flowCode
  $('designStepTab').textContent=current.dsl.flowName||current.scope.flowCode;$('designStepTab').hidden=false;$('designStepTabGroup').hidden=false
  $('stepExecutor').replaceChildren(...[...$('executor').options].map(option=>new Option(option.textContent,option.value)))
  $('stepExecutor').value=current.scope.executor
  $('stepCount').textContent='步骤（'+$('stepTree').querySelectorAll('.step-item').length+'）'
  const nativeBusy=productionRunning||current.productionRunning
  const busy=workspaceOpening||nativeBusy||['running','waiting_approval','stopping'].includes(current.state)
  $('stepExecutor').disabled=busy;$('retryTasks').disabled=busy||taskLoading;$('stepRun').disabled=busy||taskLoading;$('stepSave').disabled=busy||current.readOnly
  for(const id of ['runCurrent','runStep','runCandidate'])$(id).disabled=busy||taskLoading
  $('stepRun').textContent=nativeBusy?'运行中…':'运行'
  viewExecutionDetails.disabled=!!nativeBusy||!current.productionRun
  viewExecutionDetails.title=nativeBusy?'运行结束后查看执行明细':'查看当前流程最近一次常规运行的执行明细'
  $('task').disabled=busy||taskLoading
  for(const id of ['send','steer','continueRun','stopAgent','assertions','closeDesignStepTab'])$(id).disabled=!!nativeBusy
  updateComposerMode()
}
function updateComposerMode(){
  const onlyRun=$('mode').value==='run',nativeBusy=productionRunning||current?.productionRunning
  $('send').textContent=onlyRun?(nativeBusy?'运行中…':'运行'):'发送 ↑'
  $('send').disabled=!!nativeBusy||!!(onlyRun&&taskLoading)
  $('mode').disabled=!!nativeBusy
  $('request').disabled=onlyRun||!!nativeBusy
  $('request').placeholder=onlyRun?'仅运行已保存的流程，请选择申报账户后点击“运行”。':'描述你希望创建、排查或修复的流程…'
}
$('mode').add(new Option('仅运行','run'))
$('mode').addEventListener('change',updateComposerMode)
async function showStepProperties(location) {
  if(inputDirty()&&!await invoke('app:confirm-navigation'))return
  selectPropertyTab()
  selectWorkspaceStep(location)
  $('stepPropertiesDialog').querySelectorAll('.argument-json').forEach(details=>{details.open=false})
  $('stepPropertiesMessage').textContent=''
  if(!$('stepPropertiesDialog').open)$('stepPropertiesDialog').showModal()
}
async function closeStepProperties() {
  if(inputDirty()&&!await invoke('app:confirm-navigation'))return
  renderProperties();$('stepPropertiesDialog').close()
}
$('closeStepProperties').onclick=()=>closeStepProperties().catch(error=>notice(error.message,true))
$('stepPropertiesDialog').addEventListener('cancel',event=>{event.preventDefault();closeStepProperties().catch(error=>notice(error.message,true))})
async function showExecutionDetails(){
  if(!current)return
  const id=current.id,next=await invoke('agent:snapshot',id),run=next.productionRun
  if(!run)throw new Error('当前流程暂无执行记录')
  const result=run.artifactId?await invoke('agent:artifact',id,run.artifactId):[]
  if(current?.id!==id)return
  const state=({running:'运行中',completed:'已结束',failed:'运行失败',unknown:'执行结果未知'})[run.state]||'未知'
  showJson('执行明细',{},null,'流程：'+next.dsl.flowName+' · 账户：'+run.taskCode+' · '+state+(run.error?' · '+run.error:''))
  $('dialogJson').hidden=true
  const details=Array.isArray(result)?result:[]
  table($('dialogList'),[{key:'stepName',label:'步骤名称'},{label:'执行状态',format:row=>[1,'1'].includes(row.status)?'成功':[0,'0'].includes(row.status)?'失败':'未知'},
    {label:'开始时间',format:row=>shortTime(row.startTime)},{label:'结束时间',format:row=>shortTime(row.endTime)},{label:'错误信息',format:row=>row.error||row.errorStack}],details)
  if(!details.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='执行器未返回步骤执行记录。';$('dialogList').append(empty)}
}
viewExecutionDetails.onclick=()=>showExecutionDetails().catch(error=>notice(error.message,true))
async function runProductionFlow(){
  if(!current||productionRunning||current.productionRunning)return
  const id=current.id
  try{
    if(inputDirty()||JSON.stringify(current.dsl)!==JSON.stringify(current.savedBaseline))throw new Error('请先保存步骤配置，再运行服务器流程')
    if(!current.taskCode)throw new Error('请先选择申报账户')
    productionRunning=true;renderWorkspace(true)
    await invoke('workspace:run',id)
    if(current?.id===id)await showExecutionDetails()
  }catch(error){notice(error.message,true)}
  finally{productionRunning=false;if(current?.id===id){await refreshSnapshot().catch(error=>notice(error.message,true));renderWorkspace(true)}}
}
$('stepRun').onclick=runProductionFlow
$('stepSave').onclick=()=>$('saveFlow').click()
$('toggleAgent').onclick=()=>{
  const hidden=$('workspace').classList.toggle('agent-hidden');$('toggleAgent').setAttribute('aria-expanded',String(!hidden))
}
$('designFlowTab').onclick=()=>setView('flowManagement')
$('designStepTab').onclick=()=>setView('workspace')
$('closeDesignStepTab').onclick=async()=>{
  try{
    if(!current){clearWorkspace();setView('flowManagement');return}
    if(workspaceOpening||['running','waiting_approval','stopping'].includes(current.state))throw new Error('请先停止或等待当前轮次结束，再关闭步骤页')
    if(!await confirmNavigation())return
    await invoke('workspace:close',current.id)
    if($('stepPropertiesDialog').open)$('stepPropertiesDialog').close()
    clearWorkspace();setView('flowManagement')
  }catch(error){notice(error.message,true)}
}
$('stepExecutor').onchange=async()=>{
  if(!current||workspaceOpening)return
  const next=$('stepExecutor').value,previous=current.scope.executor
  if(next===previous)return
  if(!await confirmNavigation()){$('stepExecutor').value=previous;return}
  workspaceOpening=true;updateDesignHeader();$('task').disabled=true
  try{
    // A new executor gets a separate session and its own account list, with no
    // execution record, approval or account carried over from the previous host.
    const data=await invoke('workspace:open',{appCode:current.scope.appCode,flowCode:current.scope.flowCode,executor:next,deferTasks:true})
    $('executor').value=next;installWorkspace(data)
    notice(data.tasks?.error||'执行器已切换，请选择该执行器上的申报账户。',!!data.tasks?.error)
  }catch(error){$('stepExecutor').value=previous;notice(error.message,true)}
  finally{workspaceOpening=false;renderWorkspace(true);updateDesignHeader()}
}
async function refreshWorkspaceTasks(){
  if(!current)return
  const id=current.id,sequence=++taskLoadSequence
  taskLoading=true;$('task').disabled=true;$('task').setAttribute('aria-busy','true');updateDesignHeader()
  if(!$('task').value&&$('task').options[0])$('task').options[0].textContent='正在读取申报账户…'
  try{
    const data=await invoke('workspace:tasks',id)
    if(current?.id!==id||sequence!==taskLoadSequence)return
    const tasks=rowsOf(data);selectOptions($('task'),tasks,item=>item.taskCode,item=>item.taskName||item.accountName||item.username||item.taskCode,'请选择该执行器上的申报账户')
    $('task').value=tasks.some(item=>item.taskCode===current.taskCode)?current.taskCode:''
    if(current.taskCode&&!tasks.some(item=>item.taskCode===current.taskCode)){
      const next=await invoke('workspace:update',id,{taskCode:''})
      if(current?.id!==id)return
      current=next
    }
    notice(data?.error||stepIdentityRepairNotice(current)||'申报账户已更新。',!!data?.error)
  }finally{if(sequence===taskLoadSequence){taskLoading=false;$('task').removeAttribute('aria-busy');$('task').disabled=!current||['running','waiting_approval','stopping'].includes(current.state);updateDesignHeader()}}
}
$('retryTasks').onclick=()=>{if(!workspaceOpening)refreshWorkspaceTasks().catch(error=>notice(error.message,true))}
async function initializeDesignWindow(bootstrapData){
  if(!designAppCode)return
  try{
    await initializeManagement(bootstrapData)
    const application=bootstrapData?.designApplication||await business('application',{appCode:designAppCode})
    document.title=application.appName||application.appCode
    await chooseDesignExecutor(bootstrapData,application)
    await openFlowManagement(application,bootstrapData?.designTaskName||undefined,true)
    if(bootstrapData?.designTakeover){
      const takeover=bootstrapData.designTakeover
      if(!$('takeoverNotice')){const hint=document.createElement('p');hint.id='takeoverNotice';hint.className='reference-mode-hint';hint.textContent='此设备已由 Agent 接管，自动任务已暂停。补丁需确认后应用；结束后请在远端 Runtime 恢复生产模式。';document.querySelector('.agent>.panel-heading').after(hint)}
      if(!current||current.scope.flowCode!==takeover.flowCode){const flow=managed.completeFlows.find(item=>item.flowCode===takeover.flowCode);if(!flow)throw Error('接管流程不在当前应用中');await openManagedSteps(flow)}
      if(!takeover.started){await refreshWorkspaceTasks()
      if(![...$('task').options].some(option=>option.value===takeover.taskCode))throw Error('接管账户不在该执行器中，未启动诊断')
      current=await invoke('workspace:update',current.id,{taskCode:takeover.taskCode})}
      $('task').value=takeover.taskCode
      $('mode').value='develop';renderWorkspace(true);setView('workspace')
      if(!takeover.started)invoke('takeover:diagnose',current.id).catch(error=>notice(error.message,true)).finally(()=>refreshSnapshot().catch(error=>notice(error.message,true)))
    }
    if(current?.scope.appCode===designAppCode)setView('workspace')
  }catch(error){setView('flowManagement');notice(error.message,true)}
  finally{
    document.documentElement.dataset.designReady='true'
    // Hidden Electron windows may suspend animation frames. Flush layout before
    // showing the window without waiting for a frame that needs it to be visible.
    $('flowManagement').getBoundingClientRect()
    await invoke('design:ready')
  }
}
document.addEventListener('user-authenticated',()=>invoke('settings:get').then(settings=>{$('agentModel').textContent=settings.modelName?'· '+settings.modelName:'· 未配置模型'}).catch(()=>{}))

// Each flow keeps its own session and unfinished property inputs while switching tabs.
const workspaceTabs=new Map()
const tabDraftFields=['stepName','actionCode','actionArgs','targetArgs','stepOptions','dsl','request','mode']
function rememberWorkspaceTab(){
  const tab=current&&workspaceTabs.get(current.id);if(!tab)return
  tab.data.session=structuredClone(current)
  tab.data.tasks=[...$('task').options].filter(option=>option.value).map(option=>({taskCode:option.value,taskName:option.textContent}))
  tab.data.tasksPending=taskLoading
  tab.view={selected:structuredClone(selected),values:Object.fromEntries(tabDraftFields.map(id=>[id,$(id).value])),dirty:inputDirty(),
    treeScroll:$('stepTree').scrollTop,timeline:[...$('timeline').childNodes].map(node=>node.cloneNode(true)),timelineScroll:$('timeline').scrollTop}
}
function registerWorkspaceTab(data){
  const old=workspaceTabs.get(data.session.id)
  workspaceTabs.set(data.session.id,{data:{...data},view:old?.view})
  renderWorkspaceTabs()
}
function clearWorkspaceTabs(){workspaceTabs.clear();document.querySelectorAll('.extra-flow-tab').forEach(node=>node.remove())}
function findWorkspaceTab(appCode,flowCode,executor){
  for(const [id,{data}] of workspaceTabs)if(data.session.scope.appCode===appCode&&data.session.scope.flowCode===flowCode&&data.session.scope.executor===executor)return id
}
function hasOtherWorkspaceDrafts(){return [...workspaceTabs].some(([id,tab])=>id!==current?.id&&(tab.view?.dirty||pretty(tab.data.session.dsl)!==pretty(tab.data.session.savedBaseline)))}
function renderWorkspaceTabs(){
  document.querySelectorAll('.extra-flow-tab').forEach(node=>node.remove())
  for(const [id,tab] of workspaceTabs){
    if(id===current?.id){$('designTabs').append($('designStepTabGroup'));continue}
    const group=document.createElement('div');group.className='closable-step-tab extra-flow-tab';group.dataset.sessionId=id
    const button=document.createElement('button');button.textContent=tab.data.session.dsl.flowName||tab.data.session.scope.flowCode;button.title=button.textContent
    button.onclick=()=>switchWorkspaceTab(id).catch(error=>notice(error.message,true))
    const close=document.createElement('button');close.textContent='×';close.className='close-flow-tab';close.title='关闭流程页';close.setAttribute('aria-label','关闭 '+button.textContent)
    close.onclick=()=>closeWorkspaceTab(id).catch(error=>notice(error.message,true));group.append(button,close);$('designTabs').append(group)
  }
}
function assertTabSwitchable(){if(workspaceOpening||productionRunning||current?.productionRunning||['running','waiting_approval','stopping'].includes(current?.state))throw new Error('请等待当前运行结束，再切换流程页')}
async function switchWorkspaceTab(id){
  if(id===current?.id){setView('workspace');return}
  assertTabSwitchable()
  const tab=workspaceTabs.get(id);if(!tab)throw new Error('流程页已关闭')
  rememberWorkspaceTab();workspaceOpening=true
  try{
    const data={...tab.data,session:await invoke('agent:snapshot',id)},view=tab.view
    installWorkspace(data)
    if(view){
      selected=structuredClone(view.selected);renderWorkspace()
      for(const [key,value] of Object.entries(view.values))$(key).value=value
      loadActionSchemas().catch(error=>notice(error.message,true));if(!$('stepPolicyPanel').hidden)renderExecutionFields()
      $('stepTree').scrollTop=view.treeScroll;$('timeline').replaceChildren(...view.timeline.map(node=>node.cloneNode(true)));$('timeline').scrollTop=view.timelineScroll
    }
    $('flow').value=current.scope.flowCode;setView('workspace')
  }finally{workspaceOpening=false;if(current)renderWorkspace(true)}
}
async function openSubflowTab(stepCode){
  assertTabSwitchable();if(!current)return
  const source=current
  rememberWorkspaceTab();workspaceOpening=true;updateDesignHeader()
  try{
    const data=await invoke('workspace:open',{appCode:source.scope.appCode,executor:source.scope.executor,sourceSessionId:source.id,stepCode,openSessionIds:[...workspaceTabs.keys()],deferTasks:true})
    const existing=workspaceTabs.has(data.session.id)
    if(existing){workspaceOpening=false;await switchWorkspaceTab(data.session.id)}
    else{installWorkspace(data);setView('workspace')}
  }finally{workspaceOpening=false;if(current)renderWorkspace(true)}
}
async function closeWorkspaceTab(id){
  assertTabSwitchable();rememberWorkspaceTab()
  const tab=workspaceTabs.get(id);if(!tab)return
  if((tab.view?.dirty||pretty(tab.data.session.dsl)!==pretty(tab.data.session.savedBaseline))&&!await invoke('app:confirm-navigation'))return
  await invoke('workspace:close',id);workspaceTabs.delete(id)
  if(id===current?.id){
    if($('stepPropertiesDialog').open)$('stepPropertiesDialog').close()
    current=null
    const next=[...workspaceTabs.keys()].pop()
    if(next)await switchWorkspaceTab(next)
    else{clearWorkspace();setView('flowManagement')}
  }else renderWorkspaceTabs()
}
$('closeDesignStepTab').onclick=()=>closeWorkspaceTab(current?.id).catch(error=>notice(error.message,true))
