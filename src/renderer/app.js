'use strict'
const $ = id => document.getElementById(id)
const invoke = (name, ...args) => window.desktop.invoke(name, ...args)
const pretty = value => JSON.stringify(value, null, 2)
let current = null, selected = null, copied = null, flowRows = [], historyRows = [], approvals = null
let page = 1, resources = null, connections = [], seenSequence = 0, unsubscribe, captureTimer, snapshotRequest = 0
const schemaCache = new Map()
let argumentSchemaSequence=0
const pageSize = 50

function notice(message, error = false) {
  $('notice').textContent = message; $('notice').className = error ? 'error' : ''
  if(document.body.dataset.currentView==='workspace'&&typeof showStepNotice==='function')showStepNotice(message,error)
  if($('stepPropertiesDialog')?.open){$('stepPropertiesMessage').textContent=message;$('stepPropertiesMessage').className=error?'form-error':'muted'}
}
function action(id, work) {
  $(id).addEventListener('click', async () => {
    $(id).disabled = true
    try { await work() } catch (error) { notice(error.message, true) }
    finally {
      $(id).disabled = false
      if (id === 'managementNext') $(id).disabled = !managed.hasNext
      if (id === 'managementPrevious') $(id).disabled = managed.page <= 1
      if (current && ['addStep','pasteStep','commitStep','commitDsl','deleteStep','moveUp','moveDown','saveFlow','recording','captureArgument','imageArgument'].includes(id)) renderWorkspace(true)
    }
  })
}
function requireCurrent() { if (!current) throw new Error('请先打开流程'); return current.id }
function clearWorkspace() {
  if(typeof clearWorkspaceTabs==='function')clearWorkspaceTabs()
  taskLoadSequence++;taskLoading=false
  current = null; selected = null; approvals = null; snapshotRequest++
  $('revision').textContent = '未打开'; $('agentState').textContent = 'idle'; $('stepTree').replaceChildren(); $('stepTree').textContent = '请选择流程并打开步骤设置'
  $('dsl').value = '{}'; $('stepName').value = ''; $('actionCode').value = ''
  for (const id of ['actionArgs','targetArgs','stepOptions']) $(id).value = '{}'
  $('actionFields').replaceChildren(); $('targetFields').replaceChildren(); $('approval').hidden = true; $('candidate').hidden = true
  $('executionFields').replaceChildren()
  if($('stepToast'))$('stepToast').hidden=true
  document.querySelectorAll('#stepInsertMenu:popover-open,.agent-action-menu:popover-open').forEach(menu=>menu.hidePopover())
  $('designStepTab').hidden=true;$('designStepTabGroup').hidden=true;$('workspaceFlowName').textContent=''
}
function selectOptions(element, rows, value, label, placeholder) {
  const old = element.value
  element.replaceChildren()
  if (placeholder) element.add(new Option(placeholder, ''))
  rows.forEach(row => element.add(new Option(label(row), value(row))))
  if ([...element.options].some(option => option.value === old)) element.value = old
}
function rowsOf(data) { return Array.isArray(data) ? data : data?.rows || data?.records || data?.list || [] }
async function bootstrap() {
  const value = await invoke('app:bootstrap')
  window.platformConnected=value.connected
  document.documentElement.dataset.platformConnected=String(value.connected)
  $('version').textContent = 'v' + value.version + ' · Electron'
  selectOptions($('platform'), value.platforms, item => item.id, item => item.name + ' · ' + item.username, '选择服务平台')
  $('platform').value = value.executorPlatformId || ''
  selectOptions($('executor'), value.executors, item => item, item => item)
  if (!current && value.activeSessions?.length) {
    const attached = await invoke('workspace:attach', value.activeSessions[0].id)
    const session = attached.session
    selectOptions($('application'), [{ appCode: session.scope.appCode, appName: session.dsl.appName }], item => item.appCode, item => item.appName || item.appCode)
    selectOptions($('flow'), [{ flowCode: session.scope.flowCode, flowName: session.dsl.flowName }], item => item.flowCode, item => item.flowName || item.flowCode)
    $('executor').value = session.scope.executor
    installWorkspace(attached)
    notice('已重新连接运行中的会话，可以继续批准、补充指令或停止。')
  }
  if (value.connected) document.dispatchEvent(new CustomEvent('user-authenticated',{detail:value}))
  return value
}
async function loadApplications() {
  const data = await invoke('platform:request', { path: 'robot/app/getAppData', body: { page, start: (page - 1) * pageSize, size: pageSize, query: [] } })
  selectOptions($('application'), rowsOf(data), item => item.appCode, item => item.appName || item.appCode, '选择应用')
  $('appPage').textContent = page
  notice('已读取第 ' + page + ' 页应用')
}
async function loadFlows() {
  if (!$('application').value) throw new Error('请选择应用')
  flowRows = await invoke('platform:request', { path: 'robot/flow/list', body: { appCode: $('application').value } })
  selectOptions($('flow'), flowRows, item => item.flowCode, item => (item.relationFlowCode ? '↗ ' : '') + item.flowName, '选择流程')
}
function appendMessage(content, kind = '') {
  if (!content) return
  if ($('timeline').querySelector('.welcome')) $('timeline').replaceChildren()
  const item = document.createElement('div')
  item.className = 'message ' + kind
  item.textContent = content
  if(kind==='event-line')item.title=content
  $('timeline').append(item)
  while ($('timeline').children.length > 150) $('timeline').firstChild.remove()
  $('timeline').scrollTop = $('timeline').scrollHeight
}
function visitSteps(steps, callback, path = []) {
  steps.forEach((step, index) => {
    const location = [...path, index]
    callback(step, location)
    if (step.body) visitSteps(step.body, callback, [...location, 'body'])
    if (step.children) visitSteps(step.children, callback, [...location, 'children'])
  })
}
function atPath(dsl, location) { return location.reduce((value, key) => value?.[key], dsl.steps) }
function selectedStep() { return current && selected ? atPath(current.dsl, selected) : null }
function selectWorkspaceStep(location){
  selected=location
  $('stepTree').querySelector('.step-item.active')?.classList.remove('active')
  const step=selectedStep()
  if(step)$('stepTree').querySelector('[data-step-code="'+CSS.escape(step.stepCode)+'"] .step-item')?.classList.add('active')
  renderProperties()
}
function renderProperties() {
  const step = selectedStep()
  $('stepTitle').textContent = step?.stepName || '步骤属性'
  $('stepName').value = step?.stepName || ''
  $('actionCode').value = step?.actionCode || ''
  $('actionArgs').value = pretty(step?.actionArgs || {})
  $('targetArgs').value = pretty(step?.targetArgs || {})
  const options = step ? Object.fromEntries(Object.entries(step).filter(([key]) => !['stepCode', 'stepName', 'actionCode', 'actionArgs', 'targetArgs', 'body', 'children'].includes(key))) : {}
  $('stepOptions').value = pretty(options)
  if(document.documentElement.dataset.windowMode==='design'&&$('stepPolicyPanel').hidden)$('executionFields').replaceChildren()
  else renderExecutionFields()
  $('actionFields').replaceChildren(); $('targetFields').replaceChildren()
  if (step) loadActionSchemas().catch(error => { $('actionSchema').textContent = error.message })
}
function renderExecutionFields() {
  const container=$('executionFields');container.replaceChildren()
  const step=selectedStep();if(!step)return
  let values;try{values=JSON.parse($('stepOptions').value)}catch(_){return}
  const scope=window.stepStructure.scopes(current.dsl.steps).find(list=>list.some(item=>item.stepCode===step.stepCode))||[]
  const jumps=scope.map(item=>[item.stepName,item.stepName])
  const fields=[['status','使用状态',[[1,'启用'],[0,'禁用']]],['failedStrategy','执行失败策略',[[0,'终止'],[1,'忽略'],[2,'跳转']]],
    ['skipTo','成功后跳转',jumps],['failedSkipTo','失败后跳转',jumps],['falseSkipTo','条件不成立跳转',jumps],['skipCondition','跳过此步骤条件'],
    ['failedRetry','失败重试次数',null],['timeout','执行超时（秒）',null],['waitBefore','执行前等待（秒）',null],['waitAfter','执行后等待（秒）',null],['maxExecuteNum','最多执行次数',null]]
  for(const [key,title,options] of fields){
    const label=document.createElement('label');label.textContent=title
    const control=document.createElement(options?'select':'input');control.dataset.stepOption=key
    if(options)control.replaceChildren(new Option('默认 / 不指定',''),...options.map(option=>new Option(option[1],String(option[0]))))
    else if(options===null){control.type='number';control.min='0';control.step='1'}
    control.value=values[key]??'';control.disabled=stepEditingBlocked()
    control.addEventListener(options?'change':'input',()=>{
      try{const next=JSON.parse($('stepOptions').value);if(control.value==='')delete next[key];else next[key]=options===null||['status','failedStrategy'].includes(key)?Number(control.value):control.value;$('stepOptions').value=pretty(next)}
      catch(error){notice(error.message,true)}
    });label.append(control);container.append(label)
  }
}
$('stepOptions').addEventListener('input',renderExecutionFields)
async function loadActionSchemas() {
  const sequence=++argumentSchemaSequence
  if (!current || !$('actionCode').value) return
  const sessionId = current.id, stepCode = selectedStep()?.stepCode, code = $('actionCode').value
  const key = current.scope.platformId + ':' + code
  if (!schemaCache.has(key)) {
    const loading = Promise.all(['robot/action/args','robot/action/target/args'].map(path => invoke('platform:request', { path, params: { dataCode: code } })))
    schemaCache.set(key, loading)
    loading.catch(() => schemaCache.delete(key))
  }
  const [actions, targets] = await schemaCache.get(key)
  if (sequence!==argumentSchemaSequence||current?.id !== sessionId || selectedStep()?.stepCode !== stepCode || $('actionCode').value !== code) return
  $('actionSchema').textContent = ''
  for (const [name, definitions, container] of [['actionArgs',actions,$('actionFields')],['targetArgs',targets,$('targetFields')]]) {
    if (!Array.isArray(definitions)) throw new Error('指令参数定义不是数组')
    const renderGroup=()=>{
    if(current?.id!==sessionId||selectedStep()?.stepCode!==stepCode||$('actionCode').value!==code)return
    let values
    try { values = JSON.parse($(name).value) } catch (_) { return }
    container.replaceChildren()
    const fields = window.argumentFields.visible(definitions, values)
    if(!fields.some(definition=>!definition.hidden)){
      const empty=document.createElement('p');empty.className='muted';empty.textContent='此指令暂无可配置参数';container.append(empty)
    }
    for (const definition of fields) {
      if (definition.hidden) continue
      const label = document.createElement('label'); label.textContent = (Number(definition.required)===1?'* ':'') + (definition.fieldName || definition.fieldKey)
      const options = definition.robotDataDicts || [], select = ['single','singleDropList'].includes(definition.fieldType)
      const control = document.createElement(select?'select':'input'); control.dataset.argument = name; control.dataset.argumentKey = definition.fieldKey
      if(select){control.add(new Option('请选择',''));for(const option of options)control.add(new Option(option.dictName,String(option.dictCode)))}
      else control.type = definition.fieldType === 'date' ? 'date' : definition.fieldType === 'number' ? 'number' : 'text'
      const value = values[definition.fieldKey] ?? ''
      if(select&&value!==''&&![...control.options].some(option=>option.value===String(value)))control.add(new Option(String(value),String(value)))
      control.value = typeof value === 'object'?pretty(value):value
      control.disabled = stepEditingBlocked()
      const change = () => {
        try {
          if(current?.id!==sessionId||selectedStep()?.stepCode!==stepCode||$('actionCode').value!==code)return
          const next=JSON.parse($(name).value),option=options.find(item=>String(item.dictCode)===control.value)
          next[definition.fieldKey]=select&&option?option.dictCode:control.value;$(name).value=pretty(next)
          if(select){
            const section=container.closest('.step-argument-section'),scrollTop=section?.scrollTop
            renderGroup();if(section)section.scrollTop=scrollTop
            container.querySelector('[data-argument-key="'+CSS.escape(definition.fieldKey)+'"]')?.focus({preventScroll:true})
          }
        }
        catch(error){notice(error.message,true)}
      }
      control.addEventListener(select?'change':'input',change);label.append(control)
      if(definition.comment){const hint=document.createElement('span');hint.className='field-hint';hint.textContent=definition.comment;label.append(hint)}
      container.append(label)
    }
    }
    renderGroup()
  }
}
function renderWorkspace(preserveInputs = false) {
  if (!current) return
  $('revision').textContent = 'revision ' + current.revision + (current.readOnly ? ' · 只读' : '')
  $('agentState').textContent = current.state
  const approval = current.pendingApproval
  approvals = approval?.id || null; $('approval').hidden = !approval
  if (approval) $('approvalText').textContent = approval.tool + '\n' + pretty(approval.args) + (approval.execution ? '\n执行范围：\n' + pretty(approval.execution) : '')
  $('reconcileExecutor').hidden = productionRunning || current.productionRunning || !(current.executionUncertain || current.executorBlocked)
  if (!preserveInputs) $('dsl').value = pretty(current.dsl)
  $('stepTree').replaceChildren()
  $('stepTree').classList.toggle('empty', !current.dsl.steps.length)
  if (!current.dsl.steps.length) {
    const add=document.createElement('button');add.textContent='＋ 添加第一个步骤';add.disabled=stepEditingBlocked();add.onclick=()=>$('addStep').click();$('stepTree').append(add)
  }
  const stepStates=window.stepState.classifySteps(current.dsl,current.savedBaseline),voidedBranches=[]
  let visibleSteps=0
  visitSteps(current.dsl.steps, (step, location) => {
    const button = document.createElement('button')
    button.className = 'step-item' + (location.length > 1 ? ' child' : '') + (pretty(selected) === pretty(location) ? ' active' : '')
    const name = document.createElement('span'); name.textContent = step.stepName
    button.title=step.stepName+' · '+step.actionCode
    const state=stepStates.get(step.stepCode),labels=[]
    if(state.voided)voidedBranches.push(location)
    const filtered=voidedBranches.some(parent=>parent.every((part,index)=>location[index]===part))
    if(!filtered)visibleSteps++
    if(state.modified)labels.push(state.added?'新增':'未保存')
    if(state.voided)labels.push('已作废')
    const code = document.createElement('small'); code.textContent = step.actionCode
    button.append(name, code)
    if(labels.length){
      const badges=document.createElement('span');badges.className='step-state-tags'
      for(const text of labels){const badge=document.createElement('em');badge.textContent=text;badges.append(badge)}
      button.append(badges);button.title+=' · '+labels.join(' · ');button.setAttribute('aria-label',button.title)
    }
    button.onclick = async () => { if(inputDirty()&&!await invoke('app:confirm-navigation'))return;selectWorkspaceStep(location) }
    const row=document.createElement('div');row.className='step-row'+(location.length>1?' child':'')
    row.classList.toggle('step-filtered-voided',filtered)
    row.classList.toggle('step-modified',state.modified);row.classList.toggle('step-voided',state.voided)
    const handle=document.createElement('span');handle.className='step-drag-handle';handle.textContent='⠿';handle.title='拖动调整同层级步骤顺序';handle.setAttribute('aria-hidden','true')
    const actions=document.createElement('div');actions.className='step-row-actions'
    const settings=document.createElement('button');settings.className='step-settings';settings.textContent='⚙';settings.title='设置步骤属性';settings.setAttribute('aria-label','设置 '+step.stepName+' 的属性')
    const add=document.createElement('button');add.className='step-add';add.textContent='＋';add.title='新增或粘贴步骤';add.setAttribute('aria-label','在 '+step.stepName+' 旁新增或粘贴步骤');add.disabled=stepEditingBlocked()
    add.onclick=()=>{try{showStepInsert(location,add)}catch(error){notice(error.message,true)}}
    settings.onclick=()=>showStepProperties(location).catch(error=>notice(error.message,true))
    const copy=document.createElement('button');copy.textContent='⧉';copy.title='复制步骤';copy.setAttribute('aria-label','复制 '+step.stepName)
    copy.onclick=async()=>{if(inputDirty()&&!await invoke('app:confirm-navigation'))return;selected=location;renderWorkspace();$('copyStep').click()}
    const remove=document.createElement('button');remove.textContent='×';remove.title='删除步骤';remove.setAttribute('aria-label','删除 '+step.stepName)
    remove.disabled=stepEditingBlocked()
    remove.onclick=async()=>{if(inputDirty()&&!await invoke('app:confirm-navigation'))return;selected=location;renderWorkspace();$('deleteStep').click()}
    actions.append(add)
    if(['subFlow','finalFlow'].includes(step.actionCode)){
      const open=document.createElement('button');open.className='step-open-subflow';open.textContent='↗';open.title='打开子流程配置';open.setAttribute('aria-label','打开 '+(step.actionArgs?.flowName||step.stepName)+' 子流程配置')
      open.onclick=()=>openSubflowTab(step.stepCode).catch(error=>notice(error.message,true));actions.append(open)
      button.ondblclick=open.onclick
    }
    actions.append(settings,copy,remove);row.append(handle,button,actions);$('stepTree').append(row)
    if(typeof attachStepDragging==='function')attachStepDragging(row,step)
  })
  if(stepStates.size&&!visibleSteps){const hint=document.createElement('p');hint.className='voided-steps-empty muted';hint.textContent='暂无启用步骤，取消勾选“隐藏禁用步骤”可查看。';$('stepTree').append(hint)}
  $('candidate').hidden = !current.proposal
  $('candidateDsl').textContent = current.proposal ? pretty(current.proposal) : ''
  $('plan').replaceChildren()
  for (const item of current.plan || []) {
    const line = document.createElement('div'); line.textContent = ({ pending: '○ ', in_progress: '◉ ', completed: '✓ ' })[item.status] + item.text
    $('plan').append(line)
  }
  const blocked = current.readOnly || productionRunning || current.productionRunning || ['running','waiting_approval','stopping'].includes(current.state)
  $('applyCandidate').disabled=blocked||!!current.proposal?.advisoryOnly
  $('referenceModeHint').hidden=!current.readOnly
  $('applyCandidate').title=current.readOnly||current.proposal?.advisoryOnly?'引用流程建议仅供审阅或临时调试，不能直接应用':''
  $('candidate').querySelector('summary').textContent=current.proposal?.advisoryOnly?'建议补丁（引用流程，仅供审阅，可临时运行调试）':'待审核候选补丁'
  for(const id of ['addStep','pasteStep','commitStep','commitDsl','deleteStep','moveUp','moveDown','saveFlow','recording','captureArgument','imageArgument'])$(id).disabled=blocked
  for(const id of ['stepName','actionCode','actionArgs','targetArgs','stepOptions','dsl'])$(id).disabled=blocked
  for(const control of document.querySelectorAll('[data-step-option],[data-argument]'))control.disabled=blocked
  $('task').disabled=taskLoading||['running','waiting_approval','stopping'].includes(current.state)
  if (!preserveInputs) renderProperties()
  if(typeof updateDesignHeader==='function')updateDesignHeader()
}
function stepIdentityRepairNotice(session) {
  if (!session || session.serverChanged) return ''
  const repaired = (session.editorRows || []).flatMap(row => [row, ...(row.list || [])]).filter(row => Object.hasOwn(row, 'sourceStepCode'))
  return repaired.length ? '流程已打开：已为 ' + repaired.length + ' 个重复或缺失编码的步骤分配唯一标识，全部步骤已保留。服务器配置尚未修改。' : ''
}
async function openFlow(sessionId) {
  if(workspaceOpening)return false
  if(!sessionId&&typeof findWorkspaceTab==='function'){
    const tab=findWorkspaceTab($('application').value,$('flow').value,$('executor').value)
    if(tab){await switchWorkspaceTab(tab);await refreshWorkspaceTasks();return true}
  }
  workspaceOpening=true
  $('flowManagementTable').setAttribute('aria-busy','true')
  try{
  if (!$('application').value || !$('flow').value) throw new Error('请选择应用和流程')
  if (sessionId !== current?.id && typeof rememberWorkspaceTab!=='function' && !await confirmNavigation()) {
    for(const [id,code,name] of [['application',current.scope.appCode,current.dsl.appName],['flow',current.scope.flowCode,current.dsl.flowName]]){
      if(![...$(id).options].some(option=>option.value===code))$(id).add(new Option(name||code,code))
      $(id).value=code
    }
    return false
  }
  const data = await invoke('workspace:open', { appCode: $('application').value, flowCode: $('flow').value, executor: $('executor').value, sessionId, deferTasks:true })
  installWorkspace(data)
  $('workspace').classList.remove('agent-hidden');$('toggleAgent').setAttribute('aria-expanded','true')
  setView('workspace')
  notice(current.serverChanged ? '服务器基线已变化，当前恢复会话只能审阅；请新建会话合并变更。' : data.tasks?.error || '流程已打开；候选补丁应用后可保存，业务核验独立记录。', !!current.serverChanged)
  if (stepIdentityRepairNotice(current)) notice(stepIdentityRepairNotice(current))
  return true
  }finally{workspaceOpening=false;$('flowManagementTable').removeAttribute('aria-busy');if(current)updateDesignHeader()}
}
function installWorkspace(data) {
  if(typeof rememberWorkspaceTab==='function')rememberWorkspaceTab()
  taskLoadSequence++;taskLoading=false
  snapshotRequest++
  current = data.session; selected = current.dsl.steps.length ? [0] : null; seenSequence = current.sequence
  historyRows = data.history
  approvals = null; $('approval').hidden = true
  selectOptions($('task'), rowsOf(data.tasks), item => item.taskCode, item => item.taskName || item.accountName || item.username || item.taskCode, '请选择该执行器上的申报账户')
  $('task').value = current.taskCode || ''
  selectOptions($('actionCode'), data.commands, item => item.actionCode, item => (item.actionName || item.actionCode) + ' · ' + item.actionCode, '选择指令')
  $('timeline').replaceChildren()
  for (const message of current.messages) if (['assistant', 'user'].includes(message.role)) appendMessage(message.content, message.role)
  renderWorkspace()
  if(data.tasksPending)refreshWorkspaceTasks().catch(error=>notice(error.message,true))
  if(typeof registerWorkspaceTab==='function')registerWorkspaceTab(data)
}
async function updateDsl(dsl, selectedCode = selectedStep()?.stepCode) {
  const next = await invoke('workspace:update', requireCurrent(), { dsl })
  let location = null
  visitSteps(next.dsl.steps, (step, path) => { if (step.stepCode === selectedCode) location = path })
  current = next; selected = location || (current.dsl.steps.length ? [0] : null)
  renderWorkspace()
}
function inputDirty() {
  const step = selectedStep()
  if (!current) return false
  if ($('dsl').value.trim() !== pretty(current.dsl)) return true
  return !!step && ($('stepName').value !== step.stepName || $('actionCode').value !== step.actionCode ||
    $('actionArgs').value.trim() !== pretty(step.actionArgs || {}) || $('targetArgs').value.trim() !== pretty(step.targetArgs || {}) ||
    $('stepOptions').value.trim() !== pretty(Object.fromEntries(Object.entries(step).filter(([key])=>!['stepCode','stepName','actionCode','actionArgs','targetArgs','body','children'].includes(key)))))
}
async function confirmNavigation() {
  if(typeof hasOtherWorkspaceDrafts==='function'&&hasOtherWorkspaceDrafts())return invoke('app:confirm-navigation')
  if (!current) return true
  if (inputDirty() || pretty(current.dsl) !== pretty(current.savedBaseline)) return invoke('app:confirm-navigation')
  return true
}
async function refreshSnapshot() {
  if (!current) return
  const requestId = ++snapshotRequest, id = current.id
  const next = await invoke('agent:snapshot', id)
  if (requestId !== snapshotRequest || current?.id !== id) return
  const preserve = inputDirty() && next.revision === current.revision && pretty(next.dsl) === pretty(current.dsl)
  current = next
  renderWorkspace(preserve)
}
function showJson(title, value, save, help = '') {
  $('dialogTitle').textContent = title; $('dialogHelp').textContent = help
  $('dialogJson').value = pretty(value); $('dialogJson').hidden = false
  $('dialogList').replaceChildren(); $('dialogSave').hidden = !save
  $('dialogSave').onclick = async () => {
    try { await save(JSON.parse($('dialogJson').value)); if ($('dialogTitle').textContent === title) $('jsonDialog').close() }
    catch (error) { $('dialogHelp').textContent = error.message }
  }
  $('jsonDialog').showModal()
}
function setView(view) {
  document.querySelectorAll('.view').forEach(item => { item.hidden = item.id !== view })
  const section = ['flowManagement','workspace','resources'].includes(view) ? 'applications' : view
  document.querySelectorAll('[data-view]').forEach(item => {item.classList.toggle('selected', item.dataset.view === section);item.setAttribute('aria-current',item.dataset.view===section?'page':'false')})
  document.body.dataset.currentView=view
  $('pageTitle').textContent = ({ home:'工作概览',taskMonitor:'RPA任务监控',executors:'执行器管理',tools:'工具',applications: 'RPA应用管理', flowManagement: 'RPA流程管理', workspace: '步骤设置', resources: '高级业务工具', settings: '系统设置' })[view]
  $('designFlowTab').classList.toggle('active',view==='flowManagement');$('designStepTab').classList.toggle('active',view==='workspace')
  if($('designPageActions'))$('designPageActions').hidden=view!=='workspace'
  if(typeof renderWorkspaceTabs==='function')renderWorkspaceTabs()
  if(typeof showShellView==='function')showShellView(view)
  if (view === 'settings' || view === 'executors') loadSettings().catch(error => notice(error.message, true))
}
document.querySelectorAll('[data-view]').forEach(item => { item.onclick = () => setView(item.dataset.view) })
window.desktop.on('app:settings', () => setView('settings'))
unsubscribe = window.desktop.on('agent:event', event => {
  if (!current || event.sessionId !== current.id || event.sequence <= seenSequence) return
  seenSequence = event.sequence
  if (event.type === 'message/assistant') appendMessage(event.data.content)
  else if (event.type === 'approval/requested') {
    approvals = event.data.id; $('approval').hidden = false
    $('approvalText').textContent = event.data.tool + '\n' + pretty(event.data.args) + (event.data.execution ? '\n执行范围：\n' + pretty(event.data.execution) : '')
  } else if (event.type === 'item/started') appendMessage('调用工具：' + event.data.tool + '，' + String(event.data.purpose || '执行请求的工具操作').replace(/\s+/g,' '), 'event-line')
  else if (event.type === 'item/failed') appendMessage(event.data.tool + '：' + event.data.error, 'error')
  else if (event.type === 'execution/completed') appendMessage('执行状态：' + event.data.status + '，业务核验：' + event.data.verification.status, 'event-line')
  else if (event.type === 'input/queued') appendMessage(event.data.content, 'user')
  else if (event.type.startsWith('turn/')) appendMessage(event.type + (event.data.error ? '\n' + event.data.error : ''))
  if (event.type.startsWith('turn/') && event.type !== 'turn/started') { $('approval').hidden = true; approvals = null }
  refreshSnapshot().catch(error => notice(error.message, true))
})

action('login', async () => {
  if (!$('platform').value) throw new Error('请先添加并选择平台')
  if (!await confirmNavigation()) return
  await invoke('platform:select', $('platform').value)
  await bootstrap()
  notice('执行器平台账号已校验。工作台应用仍按当前登录用户读取。')
})
action('pollStatus', async () => { const value = await invoke('executor:status', $('executor').value); $('executorStatus').textContent = value.text })
action('loadApps', loadApplications)
action('nextApps', async () => { page++; try { await loadApplications() } catch (error) { page--; throw error } })
action('previousApps', async () => { if (page > 1) { page--; await loadApplications() } })
action('loadFlows', loadFlows)
$('application').onchange = () => loadFlows().catch(error => notice(error.message, true))
action('openFlow', () => openFlow())
action('generateFlow', async () => {
  if (!$('application').value) throw new Error('请选择应用')
  showJson('按服务项目创建流程', { appCode: $('application').value, flowName: '', serviceItem: '', declareSystem: '', runSupport: '' }, async input => {
    if(!await confirmNavigation())throw new Error('已取消创建流程')
    const created = await invoke('workspace:generate-flow', input)
    clearWorkspace();await loadFlows(); $('flow').value = created.flowCode; await openFlow()
    $('mode').value = 'generate'; $('request').value = created.request
    $('jsonDialog').close()
    appendMessage(created.request, 'user')
    try { await invoke('agent:start', current.id, { request: created.request, mode: 'generate' }) }
    finally { await refreshSnapshot() }
  }, '请使用业务字典中的实际编码。先检查模型配置，再创建流程。生成失败时保留已创建流程，可打开后继续生成。')
})
$('task').onchange = async () => {
  try { current = await invoke('workspace:update', requireCurrent(), { taskCode: $('task').value }); notice('调试账户已绑定当前会话') }
  catch (error) { notice(error.message, true); $('task').value = current?.taskCode || '' }
}
action('showDsl', async () => { const details = $('dsl').closest('details'); details.open = !details.open; $('dsl').scrollIntoView({ block: 'nearest' }) })
action('commitDsl', () => updateDsl(JSON.parse($('dsl').value)))
action('exportDsl', async () => { requireCurrent(); await invoke('clipboard:write', pretty(current.dsl)); notice('DSL 已复制') })
action('addStep', async () => {
  requireCurrent()
  showStepInsert(null)
})
action('commitStep', async () => {
  if (!selectedStep()) throw new Error('请选择步骤')
  const dsl = structuredClone(current.dsl)
  const step = atPath(dsl, selected)
  const options = JSON.parse($('stepOptions').value)
  const children = { ...(step.body ? { body: step.body } : {}), ...(step.children ? { children: step.children } : {}) }
  const next = { ...options, stepCode: step.stepCode, stepName: $('stepName').value, actionCode: $('actionCode').value,
    actionArgs: JSON.parse($('actionArgs').value), targetArgs: JSON.parse($('targetArgs').value), ...children }
  const list = selected.slice(0, -1).reduce((value, key) => value[key], dsl.steps)
  list[selected[selected.length - 1]] = next
  window.stepStructure.renameReferences(dsl,step.stepCode,step.stepName,next.stepName)
  await updateDsl(dsl)
})
action('loadAction',loadActionSchemas)
for(const name of ['actionArgs','targetArgs'])$(name).addEventListener('input',()=>loadActionSchemas().catch(error=>{$('actionSchema').textContent=error.message}))
action('recording', async () => {
  requireCurrent()
  showJson('查找录制应用', { name: '' }, async input => {
    const data = await invoke('platform:request', { path: 'policy/sys/desktopApplications/getAllPage', body: { page: 1, start: 0, size: 50, query: [{ property: 'name', value: input.name }] } })
    $('jsonDialog').close()
    showJson('选择录制记录', rowsOf(data), null, '点击记录先预览待导入步骤；不会直接保存到服务器。')
    for (const record of rowsOf(data)) {
      const button = document.createElement('button'); button.textContent = record.name || record.id
      button.onclick = async () => {
        try {
          const preview = await invoke('workspace:recording-preview', current.id, { recordingId: record.id })
          $('jsonDialog').close()
          showJson('录制步骤导入预览', preview.dsl, dsl => updateDsl(dsl), preview.warnings.join('\n') || '确认后添加到当前草稿末尾，再由你保存配置。')
        } catch (error) { $('dialogHelp').textContent = error.message }
      }
      $('dialogList').append(button)
    }
  }, '输入已录制的桌面应用名称。')
})
function argumentTarget() {
  if (!selectedStep()) throw new Error('请选择步骤')
  return { kind: 'targetArgs', key: '', sessionId: current.id, revision: current.revision, stepCode: selectedStep().stepCode }
}
async function assignArgument(target, value) {
  if (current.id !== target.sessionId || current.revision !== target.revision || selectedStep()?.stepCode !== target.stepCode) throw new Error('步骤或版本已变化，本次采集已丢弃')
  if (!['actionArgs', 'targetArgs'].includes(target.kind) || !target.key) throw new Error('请选择参数对象和实际参数名')
  const dsl = structuredClone(current.dsl), step = atPath(dsl, selected)
  step[target.kind] = { ...(step[target.kind] || {}), [target.key]: value }
  await updateDsl(dsl)
}
action('captureArgument', async () => {
  if (captureTimer) { clearInterval(captureTimer); captureTimer = null; notice('参数采集已停止'); return }
  const target = argumentTarget()
  showJson('采集参数', { kind: target.kind, key: target.key }, async input => {
    Object.assign(target, input)
    if (!target.key) throw new Error('请填写实际参数名')
    await invoke('clipboard:write', '')
    const expires = Date.now() + 120000
    let reading = false
    captureTimer = setInterval(async () => {
      if (reading) return
      if (Date.now() > expires) { clearInterval(captureTimer); captureTimer = null; notice('采集等待超时'); return }
      reading = true
      try {
        const value = await invoke('clipboard:read')
        if (value) { clearInterval(captureTimer); captureTimer = null; await assignArgument(target, value); notice('已采集参数到当前草稿') }
      } catch (error) { clearInterval(captureTimer); captureTimer = null; notice(error.message, true) }
      finally { reading = false }
    }, 500)
    notice('等待采集工具复制结果到剪贴板，最多两分钟；再次点击采集参数可停止。')
  }, '填写 actionArgs 或 targetArgs 及指令实际字段名。确认后清空剪贴板，并等待采集工具复制的新内容。')
})
action('imageArgument', async () => {
  const target = argumentTarget()
  showJson('图片参数', { kind: 'actionArgs', key: '' }, async input => {
    Object.assign(target, input)
    const value = await invoke('workspace:argument-image', current.id)
    if (value) await assignArgument(target, value)
  }, '使用指令定义中的图片字段；选择最多100KiB的 PNG/JPEG，作为 base64 参数写入草稿。')
})
async function moveStep(offset) {
  if (!selected) throw new Error('请选择步骤')
  if(inputDirty())throw new Error('请先更新当前步骤输入')
  const dsl = structuredClone(current.dsl)
  const list = selected.slice(0, -1).reduce((value, key) => value[key], dsl.steps)
  const position = selected[selected.length - 1]
  if (position + offset < 0 || position + offset >= list.length) return
  const [step] = list.splice(position, 1); list.splice(position + offset, 0, step)
  await updateDsl(dsl)
}
action('moveUp', () => moveStep(-1)); action('moveDown', () => moveStep(1))
action('deleteStep', async () => {
  if (!selected) throw new Error('请选择步骤')
  if(inputDirty())throw new Error('请先更新当前步骤输入')
  const dsl = structuredClone(current.dsl)
  const list = selected.slice(0, -1).reduce((value, key) => value[key], dsl.steps)
  list.splice(selected[selected.length - 1], 1)
  const warnings=window.stepStructure.cleanJumps(dsl)
  await updateDsl(dsl)
  if(warnings.length)notice(warnings.join('\n'))
})
action('copyStep', async () => { if (!selectedStep()) throw new Error('请选择步骤'); copied = structuredClone(selectedStep()); notice('步骤已复制，点击步骤旁的＋可粘贴。') })
action('pasteStep', async () => {
  requireCurrent(); if (!copied) throw new Error('请先复制步骤')
  if(inputDirty())throw new Error('请先更新当前步骤输入')
  const preview=await invoke('workspace:paste-preview',current.id,{step:copied})
  await updateDsl(preview.dsl,preview.dsl.steps.at(-1).stepCode)
  if(preview.warnings.length)notice(preview.warnings.join('\n'))
})
action('saveFlow', async () => {
  if (inputDirty()) throw new Error('属性或 DSL 尚未更新，请先点击“更新步骤”或“更新 DSL”，避免保存旧内容')
  current = await invoke('workspace:save', requireCurrent()); renderWorkspace(); notice('配置已保存。业务核验结果仍独立绑定原执行 DSL。')
})
action('send', async () => {
  const id = requireCurrent()
  if($('mode').value==='run')return runProductionFlow()
  const request = $('request').value.trim()
  if(inputDirty())throw new Error('请先更新当前步骤输入，Agent 才能读取最新配置')
  if (!request) throw new Error('请填写需求')
  appendMessage(request, 'user'); $('request').value = ''
  try { await invoke('agent:start', id, { request, mode: $('mode').value }) }
  finally { await refreshSnapshot() }
})
action('steer', async () => {
  const id = requireCurrent(), request = $('request').value.trim()
  if (!request) throw new Error('请填写补充指令')
  await invoke('agent:steer', id, request, current.turn?.id); $('request').value = ''
  notice('补充指令已排队，旧的待授权执行已撤销；正在执行的动作需要点击停止才能中断。')
})
action('reconcileExecutor', async () => {
  await invoke('agent:reconcile', requireCurrent()); await refreshSnapshot()
  notice('已确认执行器停止，未知执行占用已解除。')
})
async function direct(name, args = {}) {
  const id = requireCurrent()
  if(inputDirty())throw new Error('请先更新当前步骤输入，避免执行旧配置')
  try { await invoke('agent:start', id, { request: name, mode: 'develop', directTool: { name, args } }) }
  finally { await refreshSnapshot() }
}
action('runCurrent', () => direct('run_current_dsl'))
action('runStep', () => {
  const step = selectedStep(); if (!step) throw new Error('请选择步骤')
  return direct('run_selected_step', { stepCode: step.stepCode })
})
action('runCandidate', () => direct('run_proposed_dsl'))
action('continueRun', () => direct('continue_failed_run'))
action('stopAgent', async () => { await invoke('agent:stop', requireCurrent()); notice('已请求停止，等待执行器确认；执行锁会保留到请求结束。') })
for (const [id, allowed] of [['approve', true], ['reject', false]]) action(id, async () => {
  if (!approvals) throw new Error('执行授权已失效')
  await invoke('agent:approve', requireCurrent(), approvals, allowed); approvals = null; $('approval').hidden = true
})
for (const [id, operation] of [['applyCandidate', 'apply'], ['discardCandidate', 'discard']]) action(id, async () => {
  current = await invoke('workspace:candidate', requireCurrent(), operation); $('flow').value = current.scope.flowCode; renderWorkspace()
})
action('assertions', async () => {
  requireCurrent()
  showJson('业务成功断言', current.rules, async rules => { current = await invoke('workspace:assertions', current.id, rules) },
    '支持 textEquals 精确核对单位/所属期、numberEquals 核对人数金额；用 businessField 标明 account、period、personCount、amount。缴费须覆盖这些字段及官方结果。businessState 填 selector、acceptedValues（办结）、pendingValues（待处理）、failedValues（失败）。逐人对账用 recordSet：selector 为人员行，keySelector/valueSelector 为行内唯一标识/状态，records 为 [{"key":"人员标识","value":"预期状态"}]。仅核验新鲜完整的最终页面；表格应展示完整目标批次。')
})
action('history', async () => {
  requireCurrent()
  showJson('会话归档', { id: current.id, events: current.events }, null, '恢复仅加载记录，不恢复浏览器，也不会自动续跑。')
  for (const item of historyRows) {
    const button = document.createElement('button'); button.textContent = item.title + ' · ' + item.state
    button.onclick = async () => { $('jsonDialog').close(); try { await openFlow(item.id) } catch (error) { notice(error.message, true) } }
    $('dialogList').append(button)
  }
})
action('evidence', async () => {
  requireCurrent(); showJson('最近五次执行证据', current.runs, null, 'UNKNOWN 表示待核；技术成功不能替代业务断言。DOM 与 ctx 保存在加密会话中。')
  for (const run of current.runs) {
    const button = document.createElement('button'); button.textContent = run.result.executionCode || run.at
    button.onclick = async () => {
      try {
        const result = await invoke('agent:artifact', current.id, run.artifactId)
        $('dialogJson').value = pretty(result)
      } catch (error) { $('dialogHelp').textContent = error.message }
    }
    $('dialogList').append(button)
  }
})
action('flowGraph', async () => {
  requireCurrent()
  showJson('流程图 · ' + (current.dsl.flowName || current.scope.flowCode), {}, null, '实线表示执行顺序；蓝色、红色与橙色线分别表示成功跳转、失败跳转和条件为假跳转。点击节点返回步骤属性。')
  $('dialogJson').hidden = true
  const nodes = []; visitSteps(current.dsl.steps, (step, location) => nodes.push({ step, location }))
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 780 ${Math.max(200, nodes.length * 95 + 50)}`)
  svg.setAttribute('width', '100%'); svg.setAttribute('aria-label', '流程图')
  const make = (tag, attrs, text) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value)
    if (text) element.textContent = text
    return element
  }
  nodes.forEach((node, index) => {
    const y = index * 95 + 20, x = node.location.length > 1 ? 290 : 200
    if (index) svg.append(make('path', { d: `M 375 ${y - 30} L 375 ${y}`, stroke: '#aab6cc', fill: 'none' }))
    for (const [field, color, offset] of [['skipTo', '#4264ed', 0], ['failedSkipTo', '#cf5369', 28], ['falseSkipTo', '#d39c36', 56]]) {
      const target = nodes.findIndex(item => item.step.stepName === node.step[field])
      if (target >= 0) svg.append(make('path', { d: `M ${x + 300} ${y + 25} H ${650 + offset} V ${target * 95 + 45} H 590`, stroke: color, fill: 'none', 'stroke-width': '2' }))
    }
    const group = make('g', { tabindex: '0', role: 'button', 'aria-label': node.step.stepName })
    group.append(make('rect', { x, y, width: 300, height: 58, rx: 8, fill: Number(node.step.status) === 0 ? '#f0f1f5' : '#edf1ff', stroke: '#ccd5ef' }),
      make('text', { x: x + 15, y: y + 24, fill: '#233044', 'font-size': '13' }, node.step.stepName.slice(0, 26)),
      make('text', { x: x + 15, y: y + 44, fill: '#7b8495', 'font-size': '10' }, node.step.actionCode))
    const navigate = () => { selected = node.location; $('jsonDialog').close(); renderWorkspace() }
    group.onclick = navigate; group.onkeydown = event => { if (event.key === 'Enter') navigate() }
    svg.append(group)
  })
  $('dialogList').append(svg)
})
action('mcp', async () => {
  const value = await invoke('mcp:control', requireCurrent(), true)
  showJson('MCP 连接', { mcpServers: { 'rpa-agent': { url: value.url, http_headers: { Authorization: 'Bearer ' + value.bearerToken } } } }, null,
    '仅监听本机并绑定当前会话。外部执行同样经过授权和执行锁；切换平台或设置后连接失效。关闭当前工作台会话前可点击下面按钮停止 MCP。')
  const button = document.createElement('button'); button.textContent = '停止 MCP'
  button.onclick = async () => { await invoke('mcp:control', current.id, false); $('jsonDialog').close() }
  $('dialogList').append(button)
})
action('importExperience', async () => { const value = await invoke('experience:import'); if (value) notice('已导入 ' + value.flowCount + ' 个只读参考流程') })
action('exportExperience', async () => { const value = await invoke('experience:export'); if (value) notice('已导出 ' + value.flowCount + ' 个参考流程') })
action('collectExperience', async () => { const result = await invoke('experience:collect'); notice('经验读取完成：' + result.status + '，' + result.flowCount + ' 个流程，' + result.errors.length + ' 项错误') })
action('stopExperience', async () => { await invoke('experience:stop'); notice('已请求停止经验读取，旧目录保留') })
window.desktop.on('experience:progress', value => notice('经验读取进度：' + pretty(value)))

function renderConnections() {
  $('connections').replaceChildren()
  connections.forEach((item, index) => {
    const row = document.createElement('div'); row.className = 'connection-row'
    const url = document.createElement('input'); url.placeholder = 'http://192.168.1.10:9090'; url.value = item.baseUrl
    url.oninput = () => { item.baseUrl = url.value }
    const token = document.createElement('input'); token.type = 'password'; token.autocomplete = 'off'; token.placeholder = item.hasDebugToken ? '令牌已保存，留空保留' : '调试令牌'
    token.oninput = () => { item.debugToken = token.value }
    const runtime=document.createElement('input');runtime.placeholder='Runtime 地址（默认同主机 :19090）';runtime.value=item.runtimeUrl||'';runtime.oninput=()=>{item.runtimeUrl=runtime.value}
    const remove = document.createElement('button'); remove.textContent = '移除'; remove.onclick = () => { connections.splice(index, 1); renderConnections() }
    row.append(url,runtime, token, remove); $('connections').append(row)
  })
}
async function loadSettings() {
  const value = await invoke('settings:get')
  for (const field of ['modelBaseUrl', 'modelName']) $(field).value = value[field]
  $('modelApiKey').value = ''; $('localDebugToken').value = ''; $('clearModelApiKey').checked = false
  $('modelApiKey').placeholder = value.hasModelApiKey ? '密钥已保存，留空保留' : 'API Key'
  $('localDebugToken').placeholder = value.hasLocalDebugToken ? '令牌已保存，留空保留' : '执行器调试令牌'
  $('remoteEnabled').checked = value.remoteEnabled; connections = value.connections; renderConnections()
}
action('addConnection', async () => { connections.push({ baseUrl: '', debugToken: '' }); renderConnections() })
action('saveSettings', async () => {
  if (!await confirmNavigation()) return
  const saved = await invoke('settings:get')
  await invoke('settings:save', { ...saved, modelBaseUrl: $('modelBaseUrl').value, modelName: $('modelName').value, modelApiKey: $('modelApiKey').value,
    clearModelApiKey: $('clearModelApiKey').checked })
  clearWorkspace(); await bootstrap(); await loadSettings(); notice('设置已保存，请重新打开流程。')
})
action('saveExecutorSettings', async () => {
  if (!await confirmNavigation()) return
  $('executorSaveMessage').textContent = '正在保存…'
  try {
    const saved = await invoke('settings:get')
    await invoke('settings:save', { ...saved, localDebugToken: $('localDebugToken').value,
      remoteEnabled: $('remoteEnabled').checked, connections })
    clearWorkspace(); await bootstrap(); await loadSettings(); await refreshExecutorCards()
    $('executorSaveMessage').textContent = '执行器配置已保存，请重新打开流程。'
  } catch (error) {
    $('executorSaveMessage').textContent = '保存失败：' + error.message
    throw error
  }
})
for (const [id, operation] of [['startExecutor', 'start'], ['stopExecutor', 'stop'], ['switchExecutor', 'switch']]) action(id, async () => {
  const result = await invoke('executor:control', operation, $('platform').value); notice(result.text)
})
action('logs', () => invoke('executor:logs'))

function replaceScope(value) {
  if (typeof value === 'string') return value.replaceAll('$appCode', $('application').value || '').replaceAll('$flowCode', $('flow').value || '')
  if (Array.isArray(value)) return value.map(replaceScope)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceScope(item)]))
  return value === undefined ? {} : value
}
for (const group of window.resourceGroups) {
  const title = document.createElement('h3'); title.textContent = group.name; $('resourceNav').append(title)
  for (const resource of group.items) {
    const button = document.createElement('button'); button.textContent = resource[0] + (resource[4] ? ' · 写入' : '')
    button.onclick = () => {
      resources = resource
      $('resourceTitle').textContent = resource[0]; $('resourcePath').value = replaceScope(resource[1])
      $('resourceMethod').value = resource[5] || 'POST'; $('resourceEncoding').value = resource[6] || 'json'
      $('resourceBody').value = resource[2] === undefined ? '' : pretty(replaceScope(resource[2]))
      $('resourceParams').value = pretty(replaceScope(resource[3]))
      $('resourceSubmit').textContent = resource[4] ? '预览并提交' : '读取'
      $('resourceResult').textContent = ''
    }
    $('resourceNav').append(button)
  }
}
action('resourceSubmit', async () => {
  if (!resources) throw new Error('请选择业务操作')
  const input = { path: $('resourcePath').value, method: $('resourceMethod').value, encoding: $('resourceEncoding').value, params: JSON.parse($('resourceParams').value),
    ...($('resourceBody').value.trim() ? { body: JSON.parse($('resourceBody').value) } : {}) }
  const submit = async () => { const value = await invoke('platform:request', input); $('resourceResult').textContent = pretty(value); notice(resources[0] + ' 已完成') }
  if (resources[4]) showJson('确认提交：' + resources[0], input, async reviewed => {
    const value = await invoke('platform:request', reviewed); $('resourceResult').textContent = pretty(value); notice(resources[0] + ' 已完成')
  }, '请检查完整参数。点击保存将把此请求提交到当前平台。')
  else await submit()
})
window.addEventListener('beforeunload', () => { if (unsubscribe) unsubscribe(); if (captureTimer) clearInterval(captureTimer) })
bootstrap().catch(error => notice(error.message, true))
