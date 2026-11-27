'use strict'
let workspaceOpening=false,taskLoading=false,taskLoadSequence=0,taskLoadError=''
const pendingProductionRuns = new Set()
const productionRunningFor = session => !!session && (pendingProductionRuns.has(session.id) || session.productionRunning)
const stepRefresh = document.createElement('button')
stepRefresh.id = 'stepRefresh'
stepRefresh.type = 'button'
stepRefresh.textContent = '刷新'
stepRefresh.title = '重新加载当前流程与申报账户'
const propertyTabs = [
  ['stepParametersTab', 'stepParametersPanel'],
  ['stepJsonTab', 'stepJsonPanel']
]
function selectPropertyTab(selectedTab = 'stepParametersTab'){
  for(const [tab,panel] of propertyTabs){
    const active = tab === selectedTab
    $(tab).setAttribute('aria-selected',String(active));$(tab).tabIndex=active?0:-1;$(panel).hidden=!active
  }
  renderExecutionFields()
}
for(const [index,[id]] of propertyTabs.entries()){
  $(id).onclick=()=>selectPropertyTab(id)
  $(id).onkeydown=event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
    event.preventDefault()
    const last=propertyTabs.length-1
    const next=event.key==='Home'?0:event.key==='End'?last:(index+(event.key==='ArrowLeft'?last:1))%propertyTabs.length
    const [nextId]=propertyTabs[next]
    selectPropertyTab(nextId);$(nextId).focus()
  }
}
$('actionCode').addEventListener('change',()=>loadActionSchemas().catch(error=>{$('actionSchema').textContent=error.message}))
const designAppCode=new URLSearchParams(location.search).get('designApp')
document.body.append($('designConnectDialog'))
async function chooseDesignExecutor(data,application){
  const executors=data.executors||[],saved=data.designExecutor
  if(saved&&executors.includes(saved)){
    $('executor').value=saved;document.title=(application.appName||application.appCode)+'（连接至 '+saved.replace(/^https?:\/\//,'')+'）';return
  }
  const picker=$('designConnectExecutor')
  const serviceFeedback=document.createElement('p')
  serviceFeedback.id='designConnectServiceFeedback';serviceFeedback.className='muted';serviceFeedback.hidden=true
  serviceFeedback.setAttribute('role','status')
  picker.closest('label').after(serviceFeedback)
  picker.setAttribute('aria-describedby',serviceFeedback.id)
  selectOptions(picker,executors,item=>item,item=>data.executorNames?.[item]?data.executorNames[item]+' · '+item:item,'请选择执行器')
  picker.disabled=true
  $('confirmDesignConnect').disabled=true
  $('designConnectError').textContent=executors.length?'正在读取后台服务名称…':'尚未配置执行器，请在左侧执行器管理中添加连接后重新打开。'
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
  $('designConnectDialog').showModal()
  await invoke('design:ready')
  if(executors.length){
    const results=await Promise.allSettled(executors.map(address=>invoke('executor:service-name',address)))
    const unavailable=new Map()
    results.forEach((result,index)=>{
      const address=executors[index]
      if(result.status==='rejected'){
        unavailable.set(address,'读取失败，请重新打开选择窗口。')
        return
      }
      const {name,reason}=result.value
      if(reason)unavailable.set(address,reason)
      if(!name)return
      for(const select of [picker,$('executor'),$('stepExecutor')]){
        const option=[...select.options].find(item=>item.value===address)
        if(option)option.textContent=name+' · '+address
      }
    })
    const updateServiceFeedback=()=>{
      const reason=picker.value?unavailable.get(picker.value):unavailable.size&&`${unavailable.size} 个执行器未能读取实时后台服务名称。选择执行器可查看原因。`
      serviceFeedback.hidden=!reason
      serviceFeedback.textContent=reason||''
    }
    picker.onchange=updateServiceFeedback
    updateServiceFeedback()
    picker.disabled=false
    $('confirmDesignConnect').disabled=false
    $('designConnectError').textContent=''
    if(document.activeElement===$('cancelDesignConnect'))picker.focus()
  }
  await connected
}
$('taskSelectorHost').append($('task'))
const voidedStepsToggle=document.createElement('label');voidedStepsToggle.className='voided-steps-toggle'
const hideDisabledSteps=document.createElement('input');hideDisabledSteps.type='checkbox';hideDisabledSteps.id='hideDisabledSteps';hideDisabledSteps.setAttribute('aria-controls','stepTree')
voidedStepsToggle.append(hideDisabledSteps,document.createTextNode('隐藏禁用步骤'))
document.querySelector('#workspace .step-view-tabs').append(voidedStepsToggle)
hideDisabledSteps.onchange=()=>{$('stepTree').classList.toggle('hide-disabled',hideDisabledSteps.checked);updatePropertyNavigation()}
const viewExecutionDetails=document.createElement('button');viewExecutionDetails.id='viewExecutionDetails';viewExecutionDetails.type='button';viewExecutionDetails.textContent='查看执行明细';viewExecutionDetails.disabled=true
const syncProductionButton=document.createElement('button')
syncProductionButton.type='button';syncProductionButton.id='syncProduction';syncProductionButton.textContent='同步生产'
$('flowManagement').querySelector('.flow-filters').append($('organizeFlows'),$('newFlow'),syncProductionButton)
action('syncProduction',openProductionSync)
const executorStatusSection=document.createElement('section');executorStatusSection.className='saved-executor-status'
$('executorCards').classList.add('executor-grid')
const executorStatusHeading=document.createElement('div');executorStatusHeading.className='panel-heading'
const executorStatusTitle=document.createElement('h2');executorStatusTitle.textContent='已保存连接状态'
const executorStatusActions=document.createElement('div');executorStatusActions.className='row'
const configureExecutors=document.createElement('button');configureExecutors.id='configureExecutors';configureExecutors.textContent='连接配置';configureExecutors.onclick=openExecutorSettings
executorStatusActions.append($('refreshExecutors'),configureExecutors)
executorStatusHeading.append(executorStatusTitle,executorStatusActions);executorStatusSection.append(executorStatusHeading,$('executorSummary'),$('executorCards'),$('executorEmpty'))
$('executorStatusHost').append(executorStatusSection)
$('executorSettings').prepend($('executorPlatformControls'))
function updateDesignHeader() {
  if(!current)return
  $('workspaceFlowName').textContent=current.dsl.flowName||current.scope.flowCode
  $('stepExecutor').replaceChildren(...[...$('executor').options].map(option=>new Option(option.textContent,option.value)))
  $('stepExecutor').value=current.scope.executor
  $('stepCount').textContent='步骤（'+$('stepTree').querySelectorAll('.step-item').length+'）'
  renderStepView()
  const nativeBusy=productionRunningFor(current)
  const busy=workspaceOpening||nativeBusy||['running','waiting_approval','stopping'].includes(current.state)
  $('stepExecutor').disabled=busy;$('retryTasks').disabled=busy||taskLoading;$('stepRun').disabled=busy||!!accountSelectionProblem();$('stepSave').disabled=busy||current.readOnly||savingFlow
  $('retryWorkspaceAccounts').disabled=busy||taskLoading
  stepRefresh.disabled=busy||savingFlow||taskLoading||pendingAccountSelections.has(current.id)
  for(const id of ['runCurrent','runWithCapturePoints','runStep','runCandidate'])$(id).disabled=busy||!!accountSelectionProblem()
  $('stepRun').textContent=nativeBusy?'运行中…':'运行'
  viewExecutionDetails.disabled = !!nativeBusy || !(current.productionRun || current.runs.some(run => run.evidenceState !== 'deleted'))
  viewExecutionDetails.title = nativeBusy ? '运行结束后查看执行明细' : '查看当前流程最近一次执行的明细'
  $('task').disabled=busy||taskLoading||pendingAccountSelections.has(current.id)||!!taskLoadError||!!current.takeoverTaskCode
  for(const id of ['send','steer','continueRun','stopAgent'])$(id).disabled=!!nativeBusy
  $('continueRun').disabled=busy||!!accountSelectionProblem()
  const rootId = workspaceRootId(current.id)
  const root = rootId === current.id ? current : workspaceTabs.get(rootId)?.data.session
  $('closeDesignStepTab').disabled = !!productionRunningFor(root)
  updateComposerMode()
}
const pendingComposerSends = new Set()
const pendingAccountSelections = new Set()
function accountSelectionProblem() {
  if (taskLoading || pendingAccountSelections.has(current?.id)) return '正在核对申报账户，请稍候'
  if (taskLoadError) return '申报账户加载失败，请重新读取'
  if (!current?.taskCode || $('task').value !== current.taskCode) return '请先在顶部选择申报账户'
  return ''
}
function updateComposerMode(){
  const nativeBusy=productionRunningFor(current)
  const agentBusy=['running','waiting_approval','stopping'].includes(current?.state)
  const mode=$('mode').value
  const debugging=mode==='develop',runOnly=mode==='dslRun'
  const accountProblem = debugging || runOnly ? accountSelectionProblem() : ''
  $('send').disabled=workspaceOpening||pendingComposerSends.has(current?.id)||nativeBusy||agentBusy||!!accountProblem||!!attachmentUploads.get(current?.id)?.size
  $('send').title=accountProblem || '发送'
  $('mode').disabled=nativeBusy||agentBusy
  $('composerEngine').disabled=nativeBusy||agentBusy||runOnly
  $('steer').disabled=!!nativeBusy||current?.turn?.engine==='codex-cli'&&agentBusy
  $('composerModel').disabled=nativeBusy||agentBusy||runOnly||!$('composerModel').value
  $('request').disabled=nativeBusy
  $('attachFile').disabled=nativeBusy||runOnly
  $('request').placeholder=accountProblem || (runOnly?'可填写运行备注，留空时可确认默认提示词…':debugging?'描述要排查或修复的问题，留空时可确认默认提示词…':'请描述需要配置的步骤…')
  $('mode').title=runOnly?'运行当前 DSL 并采集执行证据':debugging?'运行并诊断，修复建议以候选补丁呈现':'根据需求生成候选步骤'
}
$('mode').addEventListener('change',updateComposerMode)
$('request').addEventListener('input',updateComposerMode)
updateComposerMode()
let propertyNavigationPending=false,rowStepNavigation=null
async function navigateStepRow(location,open=false){
  const code=current&&atPath(current.dsl,location)?.stepCode
  if(!code)return
  if(rowStepNavigation){if(rowStepNavigation.code===code&&open)rowStepNavigation.open=true;return}
  const intent={sessionId:current.id,code,open};rowStepNavigation=intent
  try{
    if(inputDirty()&&!await invoke('app:confirm-navigation'))return
    if(current?.id!==intent.sessionId)return
    let target;visitSteps(current.dsl.steps,(step,path)=>{if(step.stepCode===code)target=path})
    if(!target)return
    if(intent.open)await showStepProperties(target,false,true)
    else selectWorkspaceStep(target)
  }finally{rowStepNavigation=null}
}
function propertyStepSequence(){
  if(!current)return []
  const hidden=$('hideDisabledSteps')?.checked,rows=[...$('stepTree').querySelectorAll('.step-row')]
  const visible=new Set(rows.filter(row=>!hidden||!row.classList.contains('step-filtered-voided')).map(row=>row.dataset.stepCode))
  const steps=[];visitSteps(current.dsl.steps,(step,location)=>{if(visible.has(step.stepCode))steps.push({code:step.stepCode,location})});return steps
}
function updatePropertyNavigation(){
  const steps=propertyStepSequence(),index=steps.findIndex(item=>item.code===selectedStep()?.stepCode)
  $('previousStepProperties').disabled=propertyNavigationPending||index<=0
  $('nextStepProperties').disabled=propertyNavigationPending||index<0||index>=steps.length-1
  $('propertyStepPosition').textContent=index<0?'':(index+1)+' / '+steps.length
}
async function showStepProperties(location,preserveTab=false,confirmed=false) {
  if(propertyNavigationPending||!current)return
  const sessionId=current.id,code=atPath(current.dsl,location)?.stepCode
  if(!code)return
  propertyNavigationPending=true;updatePropertyNavigation()
  try{
    if(!confirmed&&inputDirty()&&!await invoke('app:confirm-navigation'))return
    if(current?.id!==sessionId)return
    let target;visitSteps(current.dsl.steps,(step,path)=>{if(step.stepCode===code)target=path})
    if(!target)throw new Error('步骤已变化，请重新选择')
    if(!preserveTab)selectPropertyTab()
    selectWorkspaceStep(target)
    $('stepPropertiesMessage').textContent=''
    const dialog = $('stepPropertiesDialog')
    if(!dialog.open){
      dialog.showModal()
      $('stepName').focus({preventScroll:true})
    }
    dialog.querySelectorAll('.step-settings-scroll').forEach(panel=>{panel.scrollTop=0})
    $('stepTree').querySelector('[data-step-code="'+CSS.escape(code)+'"]')?.scrollIntoView({block:'nearest',inline:'nearest'})
  }finally{propertyNavigationPending=false;updatePropertyNavigation()}
}
async function adjacentStepProperties(direction){
  const steps=propertyStepSequence(),index=steps.findIndex(item=>item.code===selectedStep()?.stepCode),next=steps[index+direction]
  if(index>=0&&next)await showStepProperties(next.location,true)
}
$('previousStepProperties').onclick=()=>adjacentStepProperties(-1).catch(error=>notice(error.message,true))
$('nextStepProperties').onclick=()=>adjacentStepProperties(1).catch(error=>notice(error.message,true))
async function closeStepProperties() {
  if($('stepPropertiesDialog').inert)return
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
  showJson('执行明细',{},null,'流程：'+next.dsl.flowName+' · 账户：'+run.taskCode+' · '+state+(run.error?' · '+run.error:''),{scrollList:true})
  $('dialogJson').hidden=true
  const details=Array.isArray(result)?result:[]
  table($('dialogList'),[{key:'stepName',label:'步骤名称'},{label:'执行状态',format:row=>[1,'1'].includes(row.status)?'成功':[0,'0'].includes(row.status)?'失败':'未知'},
    {label:'开始时间',format:row=>shortTime(row.startTime)},{label:'结束时间',format:row=>shortTime(row.endTime)},{label:'错误信息',format:row=>row.error||row.errorStack}],details)
  if(!details.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='执行器未返回步骤执行记录。';$('dialogList').append(empty)}
}
viewExecutionDetails.onclick = () => {
  const run = current?.runs.find(item => item.evidenceState !== 'deleted'), production = current?.productionRun
  const open = run && (!production || run.at >= production.startedAt)
    ? showDebugExecutionDetails(current.id, run.artifactId)
    : showExecutionDetails()
  open.catch(error => notice(error.message, true))
}
async function runProductionFlow(){
  if(!current||productionRunningFor(current))return
  const id=current.id
  try{
    if(inputDirty()||JSON.stringify(current.dsl)!==JSON.stringify(current.savedBaseline))throw new Error('请先保存步骤配置，再运行服务器流程')
    const problem = accountSelectionProblem()
    if(problem)throw new Error(problem)
    pendingProductionRuns.add(id);renderWorkspace(true)
    await invoke('agent:start',id,{mode:'run'})
    if(current?.id===id && document.body.dataset.currentView==='workspace')await showExecutionDetails()
  }catch(error){notice(error.message,true)}
  finally{pendingProductionRuns.delete(id);if(current?.id===id){await refreshSnapshot().catch(error=>notice(error.message,true));renderWorkspace(true)}}
}
$('stepRun').onclick=runProductionFlow
stepRefresh.onclick=async()=>{
  if(!current||stepRefresh.disabled)return
  const id=current.id, selectedCode=selectedStep()?.stepCode, uncommitted=inputDirty()
  workspaceOpening=true
  stepRefresh.textContent='刷新中…'
  renderWorkspace(true)
  try {
    const next=await invoke('workspace:reload',id,uncommitted)
    if(!next||current?.id!==id)return
    snapshotRequest++
    current=next
    const tab=workspaceTabs.get(id)
    if(tab)tab.data.session=next
    renderWorkspaceTabs()
    selected=null
    if(selectedCode)visitSteps(next.dsl.steps,(step,location)=>{if(step.stepCode===selectedCode)selected=location})
    if(!selected&&next.dsl.steps.length)selected=[0]
    renderWorkspace()
    await refreshWorkspaceTasks()
    if(current?.id===id&&!taskLoadError)notice(stepIdentityRepairNotice(current)||'流程和申报账户已刷新。')
  } catch(error) {
    notice(String(error.message).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,''),true)
  } finally {
    workspaceOpening=false
    stepRefresh.textContent='刷新'
    if(current)renderWorkspace(true)
  }
}
$('toggleAgent').onclick=()=>{
  const hidden=$('workspace').classList.toggle('agent-hidden');$('toggleAgent').setAttribute('aria-expanded',String(!hidden))
}
$('designFlowTab').onclick=()=>setView('flowManagement')
$('designStepTab').onclick=()=>switchWorkspaceTab(workspaceRootId(current?.id)).catch(error=>notice(error.message,true))
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
  taskLoading=true;taskLoadError='';$('task').disabled=true;$('task').setAttribute('aria-busy','true');updateTaskLoadFeedback('正在从当前执行器读取申报账户…',false);updateDesignHeader()
  if(!$('task').value&&$('task').options[0])$('task').options[0].textContent='正在读取申报账户…'
  try{
    const data=await invoke('workspace:tasks',id)
    if(current?.id!==id||sequence!==taskLoadSequence)return
    if(data?.error)throw new Error(data.error)
    const tasks=data.tasks
    selectOptions($('task'),tasks,item=>item.taskCode,item=>item.taskName||item.accountName||item.username||item.taskCode,'请选择该执行器上的申报账户')
    current.taskCode=data.taskCode
    $('task').value=data.taskCode
    updateTaskLoadFeedback(tasks.length?'':'该应用暂无申报账户，请核对执行器客户配置及应用同步情况。',false)
    const tab=workspaceTabs.get(id);if(tab){tab.data.tasks=tasks;tab.data.tasksPending=false;tab.data.taskLoadError=''}
    if(document.body.dataset.currentView==='workspace')notice(stepIdentityRepairNotice(current)||'申报账户已更新。')
  }catch(error){
    if(current?.id!==id||sequence!==taskLoadSequence)return
    const reason=String(error.message).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'')
    taskLoadError='申报账户加载失败：'+reason+(/运行时发生异常/.test(reason)?'。请检查执行器应用同步及运行时平台登录状态，并更新账户接口。':'')
    if(!$('task').value&&$('task').options[0])$('task').options[0].textContent='申报账户加载失败，请重新读取'
    updateTaskLoadFeedback(taskLoadError,true)
    const tab=workspaceTabs.get(id);if(tab){tab.data.tasksPending=false;tab.data.taskLoadError=taskLoadError}
  }finally{if(sequence===taskLoadSequence){taskLoading=false;$('task').removeAttribute('aria-busy');updateDesignHeader()}}
}
function updateTaskLoadFeedback(message,error=false){
  $('taskLoadFeedback').hidden=!message;$('taskLoadFeedback').classList.toggle('error',error);$('taskLoadMessage').textContent=message
  $('retryWorkspaceAccounts').disabled=taskLoading
}
$('retryWorkspaceAccounts').onclick=()=>$('retryTasks').click()
$('retryTasks').onclick=()=>{if(!workspaceOpening)refreshWorkspaceTasks().catch(error=>notice(error.message,true))}
async function initializeDesignWindow(bootstrapData){
  if(!designAppCode)return
  try{
    await initializeManagement(bootstrapData)
    const application=bootstrapData?.designApplication||await business('application',{appCode:designAppCode})
    document.title=application.appName||application.appCode
    await chooseDesignExecutor(bootstrapData,application)
    await openFlowManagement(application,bootstrapData?.designTaskName||undefined,true,bootstrapData?.designServiceItem)
    const initialFlow=managed.flows.find(item=>item.flowCode===bootstrapData?.designInitialFlowCode)
    if(initialFlow&&!current)await openManagedSteps(initialFlow)
    if(bootstrapData?.designTakeover){
      const takeover=bootstrapData.designTakeover
      if(!$('takeoverNotice')){const hint=document.createElement('p');hint.id='takeoverNotice';hint.className='reference-mode-hint';hint.textContent='此设备已由 Agent 接管，自动任务已暂停。补丁需确认后应用；结束后请在远端 Runtime 恢复生产模式。';document.querySelector('.agent>.panel-heading').after(hint)}
      if(!current||current.scope.flowCode!==takeover.flowCode){const flow=managed.completeFlows.find(item=>item.flowCode===takeover.flowCode);if(!flow)throw Error('接管流程不在当前应用中');await openManagedSteps(flow)}
      if(!takeover.started)await refreshWorkspaceTasks()
      $('mode').value='develop';renderWorkspace(true);setView('workspace')
      if(!takeover.started&&current.taskCode===takeover.taskCode)invoke('takeover:diagnose',current.id).catch(error=>notice(error.message,true)).finally(()=>refreshSnapshot().catch(error=>notice(error.message,true)))
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

// Each flow keeps its own session and unfinished property inputs while switching tabs.
const workspaceTabs=new Map()
const stepViewModes=new Map()
let inlineDslTree=null,inlineDslRequest=null,inlineDslRaw=false
function selectDslFormat(raw){
  inlineDslRaw=raw
  const ready=!!inlineDslRequest?.document
  $('stepDslTree').hidden=!ready||raw;$('stepDslSource').hidden=!ready||!raw
  $('dslStructure').setAttribute('aria-pressed',String(!raw));$('dslRaw').setAttribute('aria-pressed',String(raw))
  $('expandStepDsl').hidden=raw;$('collapseStepDsl').hidden=raw
  for(const id of ['expandStepDsl','collapseStepDsl','copyStepDsl'])$(id).disabled=!ready
}
$('dslStructure').onclick=()=>selectDslFormat(false)
$('dslRaw').onclick=()=>selectDslFormat(true)
$('expandStepDsl').onclick=()=>inlineDslTree?.expand()
$('collapseStepDsl').onclick=()=>inlineDslTree?.collapse()
async function loadInlineDsl(request){
  $('stepDslMessage').textContent='正在加载流程及引用的子流程…'
  $('retryStepDsl').hidden=true
  selectDslFormat(inlineDslRaw)
  try{
    const {dsl,diagnostics}=await invoke('workspace:dsl',request.sessionId)
    if(inlineDslRequest!==request||workspaceRootId(current?.id)!==request.sessionId)return
    request.document=dsl
    request.total=countDslSteps(dsl)
    request.partial=!!diagnostics.length
    $('stepDslMessage').textContent=diagnostics.map(item=>item.message).join('；')
    $('retryStepDsl').hidden=!diagnostics.length
  }catch(error){
    if(inlineDslRequest!==request||workspaceRootId(current?.id)!==request.sessionId)return
    $('stepDslMessage').textContent='DSL 加载失败：'+error.message
    $('retryStepDsl').hidden=false
  }
  if(inlineDslRequest===request)renderStepView()
}
$('retryStepDsl').onclick=()=>{inlineDslRequest=null;renderStepView()}
function countDslSteps(dsl){
  let total=0
  for(const flow of [dsl,...(dsl.subflows||[])])visitSteps(flow.steps,()=>total++)
  return total
}
function renderStepView(){
  if(!current)return
  const rootId=workspaceRootId(current.id)
  const onRoot=current.id===rootId
  const root=onRoot?current:workspaceTabs.get(rootId).data.session
  const dsl=onRoot&&stepViewModes.get(rootId)==='dsl'
  $('stepTree').hidden=dsl;$('stepDslPanel').hidden=!dsl
  let rootSteps=0,hasCalls=false
  visitSteps(root.dsl.steps,step=>{
    rootSteps++
    if(['subFlow','finalFlow'].includes(step.actionCode))hasCalls=true
  })
  $('stepsViewTab').textContent='步骤（'+rootSteps+'）'
  for(const [id,active] of [['stepsViewTab',onRoot&&!dsl],['dslViewTab',dsl]]){
    $(id).setAttribute('aria-selected',String(active))
    $(id).tabIndex=active||(!onRoot&&id==='stepsViewTab')?0:-1
  }
  const versions=[...workspaceTabs.values()].map(tab=>{
    const session=tab.data.session.id===current.id?current:tab.data.session
    return [session.id,session.revision]
  })
  const source=JSON.stringify([root.revision,versions])
  if(source!==inlineDslRequest?.source||rootId!==inlineDslRequest?.sessionId){
    inlineDslRequest=null
    if(dsl||hasCalls){
      inlineDslRequest={source,sessionId:rootId}
      loadInlineDsl(inlineDslRequest)
    }
  }
  const request=inlineDslRequest
  const document=request?.document
  const total=document?request.total:rootSteps
  const partial=document?request.partial:hasCalls
  $('dslViewTab').textContent='DSL（'+total+(partial?'+':'')+'）'
  $('dslViewTab').title=partial?'当前已加载的步骤数，部分子流程尚未载入':'包含主流程及引用子流程的步骤总数'
  if(dsl&&document&&!request.rendered){
    request.rendered=true
    $('stepDslSource').textContent=pretty(document)
    inlineDslTree=window.createInlineJsonTree(document)
    $('stepDslTree').replaceChildren(inlineDslTree.root)
  }
  selectDslFormat(inlineDslRaw)
}
for(const [id,mode] of [['stepsViewTab','steps'],['dslViewTab','dsl']]){
  $(id).onclick=async()=>{
    if(!current)return
    const rootId=workspaceRootId(current.id)
    try{
      if(current.id!==rootId)await switchWorkspaceTab(rootId)
      stepViewModes.set(rootId,mode)
      renderStepView()
    }catch(error){notice(error.message,true)}
  }
  $(id).onkeydown=event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
    event.preventDefault();const target=event.key==='Home'?'stepsViewTab':event.key==='End'?'dslViewTab':id==='stepsViewTab'?'dslViewTab':'stepsViewTab'
    $(target).click();$(target).focus()
  }
}
$('copyStepDsl').onclick=async()=>{
  const document=inlineDslRequest?.document
  if(!document)return
  try{await invoke('clipboard:write',pretty(document));notice('DSL 已复制。')}
  catch(error){notice('复制失败：'+error.message,true)}
}
const tabDraftFields=['stepName','actionCode','actionArgs','targetArgs','stepOptions','dsl','request','mode']
function rememberWorkspaceTab(){
  const tab=current&&workspaceTabs.get(current.id);if(!tab)return
  tab.data.session=structuredClone(current)
  tab.data.tasks=[...$('task').options].filter(option=>option.value).map(option=>({taskCode:option.value,taskName:option.textContent}))
  tab.data.tasksPending=taskLoading
  tab.data.taskLoadError=taskLoadError
  tab.view={selected:structuredClone(selected),values:Object.fromEntries(tabDraftFields.map(id=>[id,$(id).value])),dirty:inputDirty(),
    treeScroll:$('stepTree').scrollTop,timeline:[...$('timeline').childNodes].map(node=>node.cloneNode(true)),timelineScroll:$('timeline').scrollTop,seenSequence}
}
function registerWorkspaceTab(data,parentSessionId){
  const old=workspaceTabs.get(data.session.id)
  workspaceTabs.set(data.session.id,{data:{...data},view:old?.view,parentSessionId:old?old.parentSessionId:parentSessionId})
  renderWorkspaceTabs()
}
function clearWorkspaceTabs(){
  workspaceTabs.clear()
  stepViewModes.clear()
  inlineDslRequest=null
  document.querySelectorAll('.extra-flow-tab').forEach(node=>node.remove())
  $('subflowTabs').hidden=true
}
function findWorkspaceTab(appCode,flowCode,executor){
  for(const [id,{data}] of workspaceTabs)if(data.session.scope.appCode===appCode&&data.session.scope.flowCode===flowCode&&data.session.scope.executor===executor)return id
}
function hasOtherWorkspaceDrafts(){return [...workspaceTabs].some(([id,tab])=>id!==current?.id&&(tab.view?.dirty||pretty(tab.data.session.dsl)!==pretty(tab.data.session.savedBaseline)))}
function workspaceRootId(id){
  while(workspaceTabs.has(workspaceTabs.get(id)?.parentSessionId)){
    id=workspaceTabs.get(id).parentSessionId
  }
  return id
}
function renderWorkspaceTabs(){
  document.querySelectorAll('.extra-flow-tab').forEach(node=>node.remove())
  const rootId=workspaceRootId(current?.id)
  const root=workspaceTabs.get(rootId)?.data.session
  const rootButton=$('designStepTab'),rootGroup=$('designStepTabGroup'),subflowTabs=$('subflowTabs')
  rootGroup.hidden=!root
  rootButton.hidden=!root
  if(root)rootButton.textContent=root.dsl.flowName||root.scope.flowCode
  for(const [id,tab] of workspaceTabs){
    if(id===rootId){$('designTabs').append(rootGroup);continue}
    const subflow=workspaceTabs.has(tab.parentSessionId)
    if(subflow&&workspaceRootId(id)!==rootId)continue
    const group=document.createElement('div');group.className='closable-step-tab extra-flow-tab';group.dataset.sessionId=id
    const button=document.createElement('button');button.textContent=tab.data.session.dsl.flowName||tab.data.session.scope.flowCode;button.title=button.textContent
    if(subflow){
      group.classList.add('subflow-tab')
      if(id===current?.id)button.setAttribute('aria-current','true')
    }
    button.onclick=()=>switchWorkspaceTab(id).catch(error=>notice(error.message,true))
    const close=document.createElement('button');close.textContent='×';close.className='close-flow-tab';close.title='关闭流程页';close.setAttribute('aria-label','关闭 '+button.textContent)
    close.onclick=()=>closeWorkspaceTab(id).catch(error=>notice(error.message,true));group.append(button,close)
    const container=subflow?subflowTabs:$('designTabs')
    container.append(group)
  }
  subflowTabs.hidden=!subflowTabs.childElementCount
}
function assertTabSwitchable(){if(workspaceOpening)throw new Error('正在打开流程，请稍候')}
async function switchWorkspaceTab(id){
  if(id===current?.id){setView('workspace');return}
  assertTabSwitchable()
  const tab=workspaceTabs.get(id);if(!tab)throw new Error('流程页已关闭')
  rememberWorkspaceTab();workspaceOpening=true
  try{
    const data={...tab.data,session:await invoke('agent:snapshot',id)},view=tab.view
    installWorkspace(data)
    $('executor').value = current.scope.executor
    if(view){
      selected=structuredClone(view.selected);renderWorkspace()
      for(const [key,value] of Object.entries(view.values))$(key).value=value
      loadActionSchemas().catch(error=>notice(error.message,true));renderExecutionFields()
      $('stepTree').scrollTop=view.treeScroll;$('timeline').replaceChildren(...view.timeline.map(node=>node.cloneNode(true)));$('timeline').scrollTop=view.timelineScroll
      for (const event of current.events) {
        if (event.sequence > view.seenSequence) renderAgentTimelineEvent(event)
      }
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
    if(existing){
      if(workspaceRootId(data.session.id)!==workspaceRootId(source.id)){
        workspaceTabs.get(data.session.id).parentSessionId=source.id
      }
      workspaceOpening=false
      await switchWorkspaceTab(data.session.id)
    }
    else{installWorkspace(data,source.id);setView('workspace')}
  }finally{workspaceOpening=false;if(current)renderWorkspace(true)}
}
async function closeWorkspaceTab(id){
  assertTabSwitchable();rememberWorkspaceTab()
  const tab=workspaceTabs.get(id);if(!tab)return
  if((tab.view?.dirty||pretty(tab.data.session.dsl)!==pretty(tab.data.session.savedBaseline))&&!await invoke('app:confirm-navigation'))return
  await invoke('workspace:close',id);workspaceTabs.delete(id)
  stepViewModes.delete(id)
  for(const child of workspaceTabs.values()){
    if(child.parentSessionId===id)child.parentSessionId=tab.parentSessionId
  }
  if(id===current?.id){
    if($('stepPropertiesDialog').open)$('stepPropertiesDialog').close()
    current=null
    const next=workspaceTabs.has(tab.parentSessionId)?tab.parentSessionId:[...workspaceTabs.keys()].pop()
    if(next)await switchWorkspaceTab(next)
    else{clearWorkspace();setView('flowManagement')}
  }else{renderWorkspaceTabs();renderStepView()}
}
$('closeDesignStepTab').onclick=()=>closeWorkspaceTab(workspaceRootId(current?.id)).catch(error=>notice(error.message,true))
