'use strict'
const $ = id => document.getElementById(id)
const invoke = (name, ...args) => window.desktop.invoke(name, ...args)
const pretty = value => JSON.stringify(value, null, 2)
let current = null, selected = null, copied = null, flowRows = [], approvals = null
const attachmentDrafts = new Map(), attachmentUploads = new Map()
function renderRequestAttachments() {
  const host=$('requestAttachments'), id=current?.id
  host.replaceChildren()
  for(const file of attachmentDrafts.get(id)||[]){
    const chip=document.createElement('span');chip.className='html-attachment';chip.setAttribute('role','listitem')
    const label=document.createElement('span');label.textContent=file.name+' · '+Math.max(1,Math.ceil(file.bytes/1024))+' KB';label.title=file.name
    const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','移除附件 '+file.name)
    remove.onclick=()=>{attachmentDrafts.set(id,(attachmentDrafts.get(id)||[]).filter(item=>item.artifactId!==file.artifactId));renderRequestAttachments();updateComposerMode()}
    chip.append(label,remove);host.append(chip)
  }
  if(attachmentUploads.get(id)?.size){const pending=document.createElement('span');pending.setAttribute('role','status');pending.textContent='正在添加附件…';host.append(pending)}
  host.hidden=!host.childElementCount
}
function queueAttachment(id,load) {
  const jobs=attachmentUploads.get(id)||new Set();attachmentUploads.set(id,jobs)
  const user=window.currentUser?.id
  const job=load().then(file=>{
    if(window.currentUser?.id!==user)return file
    const files=attachmentDrafts.get(id)||[]
    if(!files.some(item=>item.artifactId===file.artifactId))attachmentDrafts.set(id,[...files,file])
    return file
  })
  jobs.add(job);renderRequestAttachments();updateComposerMode()
  const finish=()=>{
    jobs.delete(job)
    if(!jobs.size)attachmentUploads.delete(id)
    if(current?.id===id){renderRequestAttachments();updateComposerMode()}
  }
  job.then(finish,finish)
  return job
}
function renderComposerModels(names) {
  const select=$('composerModel'), selectedModel=select.value
  select.replaceChildren(...(names.length?names.map(name=>new Option(name,name)):[new Option('未配置模型','')]))
  if(names.includes(selectedModel))select.value=selectedModel
  select.title=select.value||'请先在系统设置中配置 AI 模型'
  if(typeof updateComposerMode==='function')updateComposerMode()
}
let composerModelRevision=0
desktop.on('models:changed',names=>{composerModelRevision++;renderComposerModels(names)})
document.addEventListener('user-authenticated',async()=>{
  const revision=++composerModelRevision
  const settings=await invoke('settings:get').catch(()=>null)
  if(!settings||revision!==composerModelRevision)return
  renderComposerModels([...new Set([settings.modelName,...(settings.additionalModelNames||[])].filter(Boolean))])
})
$('composerModel').onchange=event=>{event.target.title=event.target.value;updateComposerMode()}
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
      if (['attachFile','send'].includes(id)) updateComposerMode()
      if (id === 'managementNext') $(id).disabled = !managed.hasNext
      if (id === 'managementPrevious') $(id).disabled = managed.page <= 1
      if (current && ['addStep','pasteStep','commitDsl','deleteStep','moveUp','moveDown','stepSave','confirmStepProperties','recording','captureArgument','imageArgument','applyCandidate','discardCandidate','previewCandidate'].includes(id)) renderWorkspace(true)
    }
  })
}
function requireCurrent() { if (!current) throw new Error('请先打开流程'); return current.id }
function clearWorkspace() {
  if(typeof clearWorkspaceTabs==='function')clearWorkspaceTabs()
  taskLoadSequence++;taskLoading=false;taskLoadError='';updateTaskLoadFeedback('')
  current = null; selected = null; approvals = null; snapshotRequest++
  renderAgentActivity()
  $('revision').textContent = '未打开'; $('agentState').textContent = 'idle'; $('stepTree').replaceChildren(); $('stepTree').textContent = '请选择流程并打开步骤设置'
  $('dsl').value = '{}'; $('stepName').value = ''; $('actionCode').value = ''
  for (const id of ['actionArgs','targetArgs','stepOptions']) $(id).value = '{}'
  $('actionFields').replaceChildren(); $('targetFields').replaceChildren(); $('approval').hidden = true; $('candidate').hidden = true
  renderExecutionFields()
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
  selectOptions($('executor'), value.executors, item => item, item => value.executorNames?.[item]?value.executorNames[item]+' · '+item:item)
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
  selectOptions($('flow'), flowRows, item => item.flowCode, item => item.flowName, '选择流程')
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
  return item
}
function appendDebugConclusion(data) {
  const content = data.content || debugExecutionResult.conclusion(data).content
  const item = appendMessage(content, data.status === 'FAILED' ? 'error' : '')
  if (!data.artifactId) return item
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = '查看本次执行明细'
  button.dataset.debugArtifact = data.artifactId
  item.append(document.createElement('br'), button)
  return item
}
$('timeline').addEventListener('click', event => {
  const button = event.target.closest('button[data-debug-artifact]')
  if (button && current) showDebugExecutionDetails(current.id, button.dataset.debugArtifact).catch(error => notice(error.message, true))
})
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
  renderExecutionFields()
  $('actionFields').replaceChildren(); $('targetFields').replaceChildren()
  if (step) loadActionSchemas().catch(error => { $('actionSchema').textContent = error.message })
  if(typeof updatePropertyNavigation==='function')updatePropertyNavigation()
}
function readStepOptions() {
  try {
    const options = JSON.parse($('stepOptions').value)
    return options && typeof options === 'object' && !Array.isArray(options) ? options : null
  } catch (_) { return null }
}
function syncStepDisabled(values = readStepOptions()) {
  const step = selectedStep(), toggle = $('stepDisabled')
  const status = values ? values.status : step?.status
  toggle.checked = status === 0 || status === '0'
  toggle.disabled = !step || !values || stepEditingBlocked()
}
$('stepDisabled').addEventListener('change', () => {
  const values = readStepOptions()
  if (!values || !selectedStep() || stepEditingBlocked()) { syncStepDisabled(values); return }
  values.status = $('stepDisabled').checked ? 0 : 1
  $('stepOptions').value = pretty(values)
})
function stepJumpScope(stepCode) {
  return window.stepStructure.scopes(current.dsl.steps).find(list=>list.some(item=>item.stepCode===stepCode)) || []
}
function stepJumpLinks(step, scope, tree) {
  const links = document.createElement('span')
  links.className = 'step-jump-links'
  for (const [value, label, kind, symbol] of [
    [step.skipTo, '成功', 'success', '✓'],
    [step.failedSkipTo || step.falseSkipTo, '失败/条件不成立', 'failure', '↪']
  ]) {
    if (!value) continue
    const next = value === 'NEXT'
    const target = next ? scope[scope.findIndex(item => item.stepCode === step.stepCode) + 1] :
      scope.find(item => item.stepName === value)
    const link = document.createElement('button')
    link.type = 'button'
    link.className = 'step-jump-link'
    link.dataset.jumpKind = kind
    link.classList.toggle('missing', !next && !target)
    const targetText = (next ? '下一步' : value) + (!next && !target ? '（目标不存在）' : '')
    const icon = document.createElement('span')
    icon.className = 'step-jump-icon'
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = symbol
    link.append(icon, targetText)
    link.title = label + ' → ' + targetText
    link.setAttribute('aria-label', link.title)
    link.onclick = () => {
      if (!target) return notice(next ? '当前范围内没有可定位的下一步。' : '跳转目标不存在：' + value, true)
      const row = tree.querySelector('[data-step-code="' + CSS.escape(target.stepCode) + '"]')
      if (!row?.getClientRects().length) return notice('跳转目标已隐藏：' + target.stepName, true)
      row.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      row.getAnimations().filter(animation => animation.id === 'step-jump-highlight').forEach(animation => animation.cancel())
      const color = getComputedStyle(row).getPropertyValue('--accent').trim()
      row.animate([{ boxShadow: 'inset 0 0 0 2px ' + color }, { boxShadow: 'inset 0 0 0 2px transparent' }],
        { id: 'step-jump-highlight', duration: 1600 })
    }
    links.append(link)
  }
  return links
}
function syncFailureJumpRequired(active) {
  const target = $('flowControlFields').querySelector('[data-step-option=failedSkipTo]')
  if (!target) return
  target.required = active
}
function renderExecutionFields() {
  const flow = $('flowControlFields'), execution = $('executionFields')
  flow.replaceChildren(); execution.replaceChildren()
  const step = selectedStep(), values = readStepOptions()
  syncStepDisabled(values)
  if (!step || !values || $('stepParametersPanel').hidden) return
  const jumps = [['NEXT','下一步'], ...stepJumpScope(step.stepCode).map(item=>[item.stepName,item.stepName])]
  renderStepOptions(flow, values, [
    ['skipTo','成功后跳转',jumps], ['failedSkipTo','失败/条件不成立跳转',jumps], ['skipCondition','跳过此步骤条件']
  ])
  renderStepOptions(execution, values, [
    ['failedStrategy','执行失败策略',[[0,'终止'],[1,'忽略'],[2,'跳转']]],
    ['failedRetry','失败重试次数',null], ['timeout','执行超时（秒）',null],
    ['waitBefore','执行前等待（秒）',null], ['waitAfter','执行后等待（秒）',null], ['maxExecuteNum','最多执行次数',null]
  ])
  syncFailureJumpRequired(Number(values.failedStrategy)===2)
}
function renderStepOptions(container, values, fields) {
  for(const [key,title,options] of fields){
    const label=document.createElement('label');label.textContent=title
    const control=document.createElement(options?'select':'input');control.dataset.stepOption=key
    if(options){
      const placeholder = key==='failedStrategy'?'默认（终止）':key==='failedSkipTo'?'请选择跳转目标':'默认 / 不指定'
      control.replaceChildren(new Option(placeholder,''),...options.map(option=>new Option(option[1],String(option[0]))))
      const currentValue = String(values[key]??'')
      if (key==='failedSkipTo' && currentValue && !options.some(([value])=>value===currentValue)) {
        control.add(new Option(currentValue+'（目标不存在）',currentValue))
      }
    }
    else if(options===null){control.type='number';control.min='0';control.step='1'}
    control.value=values[key]??'';control.disabled=stepEditingBlocked()
    control.addEventListener(options?'change':'input',()=>{
      try {
        const next=JSON.parse($('stepOptions').value)
        if(control.value==='')delete next[key]
        else next[key]=options===null||key==='failedStrategy'?Number(control.value):control.value
        $('stepOptions').value=pretty(next)
        if(key==='failedStrategy')syncFailureJumpRequired(next.failedStrategy===2)
      }
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
  const tree = $('stepTree')
  const treeScroll = tree.dataset.sessionId === current.id ? tree.scrollTop : 0
  renderRequestAttachments()
  $('revision').textContent = 'revision ' + current.revision + (current.readOnly ? ' · 只读' : '')
  $('agentState').textContent = current.state
  renderAgentActivity(current)
  const approval = current.pendingApproval
  approvals = approval?.id || null; $('approval').hidden = !approval
  if (approval) $('approvalText').textContent = approval.tool + '\n' + pretty(approval.args) + (approval.execution ? '\n执行范围：\n' + pretty(approval.execution) : '')
  $('reconcileExecutor').hidden = productionRunningFor(current) || !(current.executionUncertain || current.executorBlocked)
  if (!preserveInputs) $('dsl').value = pretty(current.dsl)
  tree.replaceChildren()
  $('stepTree').classList.toggle('empty', !current.dsl.steps.length)
  if (!current.dsl.steps.length) {
    const add=document.createElement('button');add.textContent='＋ 添加第一个步骤';add.disabled=stepEditingBlocked();add.onclick=()=>$('addStep').click();$('stepTree').append(add)
  }
  const stepStates=window.stepState.classifySteps(current.dsl,current.savedBaseline),voidedBranches=[]
  const scopesByCode = new Map(window.stepStructure.scopes(current.dsl.steps)
    .flatMap(scope => scope.map(step => [step.stepCode, scope])))
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
    if(state.voided)labels.push('禁用')
    const code = document.createElement('small'); code.textContent = step.actionCode
    button.append(name)
    const metadata = document.createElement('span')
    metadata.className = 'step-row-metadata'
    metadata.append(code)
    if(labels.length){
      const badges=document.createElement('span');badges.className='step-state-tags'
      for(const text of labels){const badge=document.createElement('em');badge.textContent=text;badges.append(badge)}
      metadata.append(badges);button.title+=' · '+labels.join(' · ');button.setAttribute('aria-label',button.title)
    }
    button.onclick=()=>navigateStepRow(location).catch(error=>notice(error.message,true))
    button.ondblclick=()=>navigateStepRow(location,true).catch(error=>notice(error.message,true))
    const row=document.createElement('div');row.className='step-row'+(location.length>1?' child':'')
    row.classList.toggle('step-filtered-voided',filtered)
    row.classList.toggle('step-modified',state.modified);row.classList.toggle('step-voided',state.voided)
    const handle=document.createElement('span');handle.className='step-drag-handle';handle.textContent='⠿';handle.title='拖到行上方或下方可排序，拖到外层步骤中央可设为子步骤';handle.setAttribute('aria-hidden','true')
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
    }
    const jumps = stepJumpLinks(step, scopesByCode.get(step.stepCode) || [], tree)
    actions.append(settings,copy,remove);row.append(handle,button)
    if (jumps.childElementCount) row.append(jumps)
    row.append(metadata,actions);tree.append(row)
    if(typeof attachStepDragging==='function')attachStepDragging(row,step,location)
  })
  if(stepStates.size&&!visibleSteps){const hint=document.createElement('p');hint.className='voided-steps-empty muted';hint.textContent='暂无启用步骤，取消勾选“隐藏禁用步骤”可查看。';$('stepTree').append(hint)}
  $('candidate').hidden = !current.proposal
  $('candidateDsl').textContent = current.proposal ? pretty(current.proposal.operations) : ''
  if(typeof renderPatchCard==='function')renderPatchCard()
  $('plan').replaceChildren()
  const showPlan=['running','waiting_approval','stopping'].includes(current.state)&&!hasAgentResult(current.turn?.id)
  for (const item of showPlan ? current.plan || [] : []) {
    const line = document.createElement('div'); line.textContent = ({ pending: '○ ', in_progress: '◉ ', completed: '✓ ' })[item.status] + item.text
    $('plan').append(line)
  }
  const blocked = stepEditingBlocked()
  $('applyCandidate').disabled=blocked||!!current.proposal?.advisoryOnly
  $('referenceModeHint').hidden=!current.readOnly
  $('applyCandidate').title=current.readOnly||current.proposal?.advisoryOnly?'只读流程建议仅供审阅或临时调试，不能直接应用':''
  $('candidate').querySelector('summary').textContent=current.proposal?.advisoryOnly?'建议补丁（只读流程，仅供审阅，可临时运行调试）':'待审核候选补丁'
  for(const id of ['addStep','pasteStep','commitDsl','deleteStep','moveUp','moveDown','confirmStepProperties','recording','captureArgument','imageArgument'])$(id).disabled=blocked
  for(const id of ['stepName','actionCode','actionArgs','targetArgs','stepOptions','dsl'])$(id).disabled=blocked
  for(const control of document.querySelectorAll('[data-step-option],[data-argument]'))control.disabled=blocked
  $('task').disabled=taskLoading||!!taskLoadError||['running','waiting_approval','stopping'].includes(current.state)
  if (!preserveInputs) renderProperties()
  else syncStepDisabled()
  if(typeof updateDesignHeader==='function')updateDesignHeader()
  // Rebuilding the rows can reset the scroll position when the list is briefly empty.
  tree.dataset.sessionId = current.id
  tree.scrollTop = treeScroll
}
function stepIdentityRepairNotice(session) {
  if (!session || session.serverChanged) return ''
  const repaired = (session.editorRows || []).flatMap(row => [row, ...(row.list || [])]).filter(row => Object.hasOwn(row, 'sourceStepCode'))
  return repaired.length ? '流程已打开：已为 ' + repaired.length + ' 个重复或缺失编码的步骤分配唯一标识，全部步骤已保留。服务器配置尚未修改。' : ''
}
async function openFlow() {
  if(workspaceOpening)return false
  if(typeof findWorkspaceTab==='function'){
    const tab=findWorkspaceTab($('application').value,$('flow').value,$('executor').value)
    if(tab){await switchWorkspaceTab(tab);await refreshWorkspaceTasks();return true}
  }
  workspaceOpening=true
  $('flowManagementTable').setAttribute('aria-busy','true')
  try{
  if (!$('application').value || !$('flow').value) throw new Error('请选择应用和流程')
  if (typeof rememberWorkspaceTab!=='function' && !await confirmNavigation()) {
    for(const [id,code,name] of [['application',current.scope.appCode,current.dsl.appName],['flow',current.scope.flowCode,current.dsl.flowName]]){
      if(![...$(id).options].some(option=>option.value===code))$(id).add(new Option(name||code,code))
      $(id).value=code
    }
    return false
  }
  const data = await invoke('workspace:open', { appCode: $('application').value, flowCode: $('flow').value, executor: $('executor').value, deferTasks:true })
  installWorkspace(data)
  $('workspace').classList.remove('agent-hidden');$('toggleAgent').setAttribute('aria-expanded','true')
  setView('workspace')
  notice(current.serverChanged ? '服务器基线已变化，当前恢复会话只能审阅；请新建会话合并变更。' : data.tasks?.error || '流程已打开；候选补丁应用后可保存，业务核验独立记录。', !!current.serverChanged)
  if (stepIdentityRepairNotice(current)) notice(stepIdentityRepairNotice(current))
  return true
  }finally{workspaceOpening=false;$('flowManagementTable').removeAttribute('aria-busy');if(current)updateDesignHeader()}
}
function installWorkspace(data, parentSessionId) {
  if(typeof rememberWorkspaceTab==='function')rememberWorkspaceTab()
  taskLoadSequence++;taskLoading=false
  snapshotRequest++
  current = data.session; selected = current.dsl.steps.length ? [0] : null; seenSequence = current.sequence
  approvals = null; $('approval').hidden = true
  selectOptions($('task'), rowsOf(data.tasks), item => item.taskCode, item => item.taskName || item.accountName || item.username || item.taskCode, '请选择该执行器上的申报账户')
  taskLoadError=data.taskLoadError||data.tasks?.error||'';updateTaskLoadFeedback(taskLoadError,!!taskLoadError)
  $('task').value = current.taskCode || ''
  selectOptions($('actionCode'), data.commands, item => item.actionCode, item => (item.actionName || item.actionCode) + ' · ' + item.actionCode, '选择指令')
  $('timeline').replaceChildren()
  restoreAgentTimeline(current)
  if(typeof registerWorkspaceTab==='function')registerWorkspaceTab(data,parentSessionId)
  renderWorkspace()
  if(data.tasksPending)refreshWorkspaceTasks().catch(error=>notice(error.message,true))
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
  if (current?.id !== id) return
  if (requestId !== snapshotRequest) return next
  const preserve = inputDirty() && next.revision === current.revision && pretty(next.dsl) === pretty(current.dsl)
  current = next
  renderWorkspace(preserve)
  return next
}
function showJson(title, value, save, help = '', { scrollList = false } = {}) {
  const dialog = $('jsonDialog')
  dialog.classList.toggle('execution-details', scrollList)
  $('dialogTitle').textContent = title; $('dialogHelp').textContent = help
  $('dialogJson').value = pretty(value); $('dialogJson').hidden = false
  $('dialogList').replaceChildren(); $('dialogSave').hidden = !save
  $('dialogSave').onclick = async () => {
    try { await save(JSON.parse($('dialogJson').value)); if ($('dialogTitle').textContent === title) $('jsonDialog').close() }
    catch (error) { $('dialogHelp').textContent = error.message }
  }
  dialog.showModal()
}
function setView(view) {
  if(view!=='executors'&&$('executorSettingsDialog')?.open)$('executorSettingsDialog').close()
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
  renderAgentTimelineEvent(event)
  refreshSnapshot().catch(error => notice(error.message, true))
})
const terminalAgentTurns=new Set(['turn/completed','turn/failed','turn/cancelled','turn/budget_exhausted','session/interrupted'])
const visibleAgentProgressLimit = 3
let agentActivityTimer
function renderAgentActivity(session) {
  const activity = $('agentActivity')
  clearInterval(agentActivityTimer)
  activity.hidden = !['running', 'waiting_approval', 'stopping'].includes(session?.state)
  if (activity.hidden) return

  const events = session.events.filter(event => event.turnId === session.turn?.id)
  const lastExecution = events.findLast(event => event.type === 'execution/completed')
  const phase = events.findLast(event => [
    'turn/started', 'turn/interrupt_requested', 'approval/requested', 'approval/resolved',
    'model/started', 'model/finished', 'model/superseded', 'item/started', 'item/completed',
    'item/failed', 'execution/started', 'execution/result_received', 'execution/observed',
    'execution/completed', 'message/assistant', 'engine/activity'
  ].includes(event.type))
  const afterExecution = lastExecution && phase?.sequence > lastExecution.sequence
  const purpose = phase?.data.purpose
  const tool = phase?.data.tool
  const labels = {
    'engine/activity': phase?.data.text,
    'approval/resolved': '正在处理授权结果',
    'model/started': phase?.data.finalization ? '正在生成本轮结论' : afterExecution ? '执行已结束，正在等待模型分析执行结果' : '正在等待模型响应',
    'model/finished': '已收到模型回复，正在处理',
    'model/superseded': '已收到补充指令，正在更新分析',
    'item/started': tool === 'propose_dsl_patch' ? '正在校验并准备候选补丁' : purpose || '正在调用工具 ' + (tool || ''),
    'item/completed': '正在处理工具结果',
    'item/failed': '正在处理工具错误',
    'execution/started': '正在等待执行器返回执行结果',
    'execution/result_received': '已收到执行结果，正在保存执行证据',
    'execution/observed': '已采集执行证据，正在整理执行明细',
    'execution/completed': session.turn?.mode === 'develop' ? '正在整理执行结果，准备后续分析' : '正在整理执行明细',
    'message/assistant': '正在处理模型回复'
  }
  let label = labels[phase?.type] || '正在准备本轮请求'
  if (afterExecution && ['item/started', 'item/completed', 'item/failed'].includes(phase.type)) label = '执行后分析 · ' + label
  if (session.state === 'waiting_approval') label = '等待你确认执行授权'
  if (session.state === 'stopping') {
    const stop = events.findLast(event => event.type === 'turn/interrupt_requested')
    label = stop?.data.executionPending ? '正在等待执行器停止' : '正在停止本轮 Agent'
  }
  if ($('agentPhase').textContent !== label) $('agentPhase').textContent = label
  $('stopAgentActivity').disabled = session.state === 'stopping'
  const started = Date.parse(phase?.at || session.turn?.startedAt) || Date.now()
  const updateElapsed = () => {
    const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000))
    $('agentElapsed').textContent = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  }
  updateElapsed()
  agentActivityTimer = setInterval(updateElapsed, 1000)
}
function hasAgentResult(turnId) {
  return turnId && [...$('timeline').querySelectorAll('[data-agent-result]')].some(item=>item.dataset.agentResult===turnId)
}
function clearAgentProgress(turnId) {
  for(const item of $('timeline').querySelectorAll('[data-agent-progress]')){
    if(item.dataset.agentProgress===turnId)item.remove()
  }
  $('plan').replaceChildren()
}
function restoreAgentTimeline(session) {
  const turns=new Map()
  for(const event of session.events){
    if(!event.turnId)continue
    if(!turns.has(event.turnId))turns.set(event.turnId,[])
    turns.get(event.turnId).push(event)
  }
  const requests=session.messages.filter(message=>message.role==='user'&&!message.inputId).slice(-turns.size)
  if(!turns.size){
    for(const message of session.messages)if(message.role==='user')appendMessage(message.content,'user')
  }
  for(const events of turns.values()){
    appendMessage(requests.shift()?.content,'user')
    const terminal=events.find(event=>terminalAgentTurns.has(event.type))
    const lastAssistant=events.findLast(event=>event.type==='message/assistant')
    const legacyConclusion=terminal?.type==='turn/completed'&&lastAssistant&&
      !events.some(event=>event.sequence>lastAssistant.sequence&&event.type==='item/started')?lastAssistant:null
    for(const event of events){
      if(!terminal||event===terminal||['execution/completed','input/queued','workspace/generated'].includes(event.type)||
        event.type==='message/assistant'&&(event.data.finalization||event===legacyConclusion)){
        renderAgentTimelineEvent(event===legacyConclusion?{...event,data:{...event.data,finalization:true}}:event,true)
      }
    }
  }
}
function renderAgentTimelineEvent(event,restoring=false) {
  const progress=(content,kind)=>{
    if(!content||hasAgentResult(event.turnId))return
    const visible=$('timeline').querySelectorAll('[data-agent-progress]')
    for(let index=0;index<=visible.length-visibleAgentProgressLimit;index++)visible[index].remove()
    const item=appendMessage(content,kind)
    item.dataset.agentProgress=event.turnId||''
  }
  if (event.type === 'message/assistant') {
    if(event.data.finalization){
      const result = event.data.debugConclusion && [...$('timeline').querySelectorAll('[data-agent-result]')]
        .findLast(item => item.dataset.agentResult === event.turnId)
      if(result)result.firstChild.textContent=event.data.content
      else appendMessage(event.data.content)
      if(event.data.warning)appendMessage(event.data.warning,'error')
    }
    else progress(event.data.content,'assistant')
  }
  else if (event.type === 'approval/requested') {
    approvals = event.data.id; $('approval').hidden = false
    $('approvalText').textContent = event.data.tool + '\n' + pretty(event.data.args) + (event.data.execution ? '\n执行范围：\n' + pretty(event.data.execution) : '')
  } else if (event.type === 'item/started') progress('调用工具：' + event.data.tool + '，' + String(event.data.purpose || '执行请求的工具操作').replace(/\s+/g,' '), 'event-line')
  else if (event.type === 'item/failed') progress(event.data.tool + '：' + event.data.error, 'error')
  else if (event.type === 'execution/completed') {
    clearAgentProgress(event.turnId)
    const result=appendDebugConclusion(event.data)
    if(result&&event.turnId)result.dataset.agentResult=event.turnId
  }
  else if (event.type === 'input/queued') appendMessage(event.data.content, 'user')
  else if (event.type === 'workspace/generated') {
    if(!restoring&&$('hideDisabledSteps')){$('hideDisabledSteps').checked=false;$('stepTree').classList.remove('hide-disabled')}
    appendMessage('步骤已生成到左侧，请检查后保存。','event-line')
  }
  else if (terminalAgentTurns.has(event.type)) {
    clearAgentProgress(event.turnId)
    if(event.type==='turn/failed')appendMessage(event.data.error||'本轮执行失败。','error')
    if(event.type==='turn/budget_exhausted')appendMessage(event.data.error||event.data.message||'本轮任务预算已用完，已保存进度。','error')
    if(event.type==='turn/cancelled'||event.type==='session/interrupted')appendMessage('本轮已停止。')
    $('timeline').scrollTop=$('timeline').scrollHeight
  }
  if (event.type.startsWith('turn/') && event.type !== 'turn/started') { $('approval').hidden = true; approvals = null }
}

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
  const id = requireCurrent()
  pendingAccountSelections.add(id)
  updateDesignHeader()
  try {
    const next = await invoke('workspace:update', id, { taskCode: $('task').value })
    if (current?.id === id) { current = next; notice('调试账户已绑定当前会话') }
  } catch (error) {
    if (current?.id === id) { notice(error.message, true); $('task').value = current.taskCode || '' }
  } finally {
    pendingAccountSelections.delete(id)
    if (current?.id === id) updateDesignHeader()
  }
}
action('showDsl', async () => {
  const id=requireCurrent(),button=$('showDsl');button.disabled=true;button.textContent='加载 DSL…'
  try{
    const {dsl,diagnostics}=await invoke('workspace:dsl',id)
    if(current?.id!==id)throw new Error('当前流程已切换，请在对应流程查看 DSL')
    const warnings=diagnostics.length
    window.showJsonViewer('查看 DSL · '+(dsl.flowName||dsl.flowCode),dsl,{diagnostics,help:
      '当前流程及递归调用的子流程（'+dsl.subflows.length+' 个），仅包含启用步骤。'+
      (warnings?' 有 '+warnings+' 项加载异常，详情见“加载提示”；此内容不是完整可执行包。':'')})
  }finally{button.disabled=false;button.textContent='查看 DSL'}
})
action('commitDsl', () => updateDsl(JSON.parse($('dsl').value)))
action('exportDsl', async () => {
  const { dsl } = await invoke('workspace:dsl', requireCurrent())
  await invoke('clipboard:write', pretty(dsl))
  notice('DSL 已复制')
})
action('addStep', async () => {
  requireCurrent()
  showStepInsert(null)
})
async function commitSelectedStep() {
  if (!selectedStep()) throw new Error('请选择步骤')
  const dsl = structuredClone(current.dsl)
  const step = atPath(dsl, selected)
  const options = readStepOptions()
  if (!options) throw new Error('步骤选项 JSON 必须为有效对象')
  if (!options.failedSkipTo && options.falseSkipTo) options.failedSkipTo = options.falseSkipTo
  delete options.falseSkipTo
  if (Number(options.failedStrategy) === 2) {
    if (!options.failedSkipTo) throw new Error('执行失败策略为「跳转」时，请选择失败后跳转目标')
    if (options.failedSkipTo !== 'NEXT' && !stepJumpScope(step.stepCode).some(item=>item.stepName===options.failedSkipTo)) {
      throw new Error('失败后跳转目标不存在，请重新选择')
    }
  }
  const children = { ...(step.body ? { body: step.body } : {}), ...(step.children ? { children: step.children } : {}) }
  const next = { ...options, stepCode: step.stepCode, stepName: $('stepName').value, actionCode: $('actionCode').value,
    actionArgs: JSON.parse($('actionArgs').value), targetArgs: JSON.parse($('targetArgs').value), ...children }
  const list = selected.slice(0, -1).reduce((value, key) => value[key], dsl.steps)
  list[selected[selected.length - 1]] = next
  window.stepStructure.renameReferences(dsl,step.stepCode,step.stepName,next.stepName)
  await updateDsl(dsl)
}
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
let savingFlow = false
action('confirmStepProperties', async () => {
  const dialog = $('stepPropertiesDialog')
  if (!dialog.open || dialog.inert) return
  if (stepEditingBlocked()) throw new Error('当前流程不可编辑')
  if ($('dsl').value.trim() !== pretty(current.dsl)) throw new Error('请先更新 DSL，再确认步骤修改')
  dialog.inert = true
  try {
    const changed = inputDirty()
    if (changed) await commitSelectedStep()
    dialog.close()
    if (changed) notice('步骤和 DSL 草稿已更新。点击右上角「保存」提交到平台。')
  } finally {
    dialog.inert = false
  }
})
action('stepSave', async () => {
  if (savingFlow) return
  const sessionId = requireCurrent()
  if (stepEditingBlocked()) throw new Error('当前流程不可编辑')
  if ($('dsl').value.trim() !== pretty(current.dsl)) throw new Error('请先更新 DSL，再保存配置')
  if (inputDirty()) throw new Error('请先在步骤设置中确认属性修改，再保存到平台')
  savingFlow = true
  try {
    const saved = await invoke('workspace:save', sessionId)
    if (current?.id !== sessionId) return
    current = saved
    renderWorkspace()
    notice('配置已保存。')
  } finally {
    savingFlow = false
  }
})
async function addRequestFiles(id,files){
  const results=await Promise.allSettled(files.map(file=>queueAttachment(id,async()=>{
    if(file.size>5*1024*1024)throw new Error(file.name+' 超过5MiB')
    const data=/\.(png|jpe?g)$/i.test(file.name)?{bytes:new Uint8Array(await file.arrayBuffer())}:{content:await file.text()}
    return invoke('workspace:attach-file',id,{name:file.name,...data})
  })))
  const errors=results.filter(item=>item.status==='rejected')
  if(current?.id===id&&errors.length)notice(errors.map(item=>item.reason.message).join('\n'),true)
}
let attachmentPickerSession
action('attachFile',()=>{attachmentPickerSession=requireCurrent();$('agentFileInput').click()})
$('agentFileInput').addEventListener('change',event=>{
  const files=[...event.target.files],id=attachmentPickerSession
  attachmentPickerSession=null
  event.target.value=''
  if(id&&files.length&&current?.id===id)addRequestFiles(id,files)
})
$('request').addEventListener('keydown',event=>{
  if(!event.isComposing&&event.key==='Enter'&&(event.ctrlKey||event.metaKey)){
    event.preventDefault()
    $('send').click()
  }
})
$('request').addEventListener('paste',event=>{
  if(!current||$('request').disabled)return
  if($('mode').value==='dslRun')return
  const id=current.id,files=[...(event.clipboardData?.files||[])]
  if(files.length){
    event.preventDefault()
    addRequestFiles(id,files.map((file,index)=>{
      if(!/^image\/(png|jpeg)$/.test(file.type)||/\.(png|jpe?g)$/i.test(file.name))return file
      return new File([file],'剪贴板图片-'+(index+1)+'.'+file.type.split('/')[1],{type:file.type})
    }))
    return
  }
  const plain=event.clipboardData?.getData('text/plain')||'', rich=event.clipboardData?.getData('text/html')||''
  const text=plain||rich, split=window.htmlInput.extractHtml(text)
  if(!split.parts.length)return
  event.preventDefault()
  const input=$('request'), original=input.value, start=input.selectionStart, end=input.selectionEnd
  Promise.all(split.parts.map(content=>queueAttachment(id,()=>invoke('workspace:attach-html',id,{content})))).then(()=>{
    if(current?.id!==id)return
    if(input.value===original)input.setRangeText(split.text,start,end,'end')
    else if(split.text)input.value+='\n'+split.text
    updateComposerMode()
    notice('HTML已添加为附件，请填写具体操作要求后发送。')
  }).catch(error=>{if(current?.id===id&&input.value===original){input.setRangeText(text,start,end,'end');updateComposerMode();notice(error.message,true)}})
})
const defaultAgentPrompts = {
  develop: '请运行一次当前完整 DSL，简述执行结果。若流程失败或中断，请说明发生在哪一步以及原因。若证据支持修改步骤，请生成候选修复补丁供我审核。',
  dslRun: '请运行当前流程的完整 DSL（包括引用的子流程），采集并保留执行日志、现场上下文、页面 DOM 和截图。仅返回执行结果和证据，不做诊断、不生成补丁。'
}
function confirmDefaultAgentPrompt(mode, request) {
  const dialog = $('defaultAgentPrompt')
  $('defaultAgentPromptTitle').textContent = mode === 'dslRun' ? '确认运行当前 DSL' : '确认调试与修复'
  $('defaultAgentPromptText').textContent = request
  dialog.returnValue = ''
  dialog.showModal()
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'send'), { once: true })
  })
}
action('send', async () => {
  const id = requireCurrent()
  if (pendingComposerSends.has(id)) return
  pendingComposerSends.add(id)
  try { await sendComposerRequest(id) }
  finally { pendingComposerSends.delete(id) }
})
async function sendComposerRequest(id) {
  await Promise.all([...(attachmentUploads.get(id)||[])])
  if(current?.id!==id)throw new Error('当前流程已切换，请在对应流程发送需求')
  const mode = $('mode').value
  const rawRequest = $('request').value.trim()
  const preview = window.htmlInput.extractHtml(rawRequest)
  const files=attachmentDrafts.get(id)||[]
  if(inputDirty())throw new Error('请先更新当前步骤输入，Agent 才能读取最新配置')
  if (mode === 'generate' && !preview.text.trim()) {
    $('request').focus()
    throw new Error('请描述需要配置的步骤，再发送需求')
  }
  const runOnly = mode === 'dslRun'
  const taskCode = current.taskCode
  const problem = mode === 'generate' ? '' : accountSelectionProblem()
  if (problem) throw new Error(problem)
  if (!runOnly && !usingCodexEngine() && !$('composerModel').value) throw new Error('请先在系统设置中配置 AI 模型')
  let request = rawRequest
  if (!preview.text.trim()) {
    const defaultRequest = defaultAgentPrompts[mode]
    const revision = current.revision
    const target = mode !== 'generate' ? '\n\n流程：'+$('workspaceFlowName').textContent+'\n申报账户：'+$('task').selectedOptions[0]?.textContent : ''
    if (!await confirmDefaultAgentPrompt(mode, defaultRequest + target)) return
    if (current?.id !== id || current.taskCode !== taskCode || current.revision !== revision ||
        (mode !== 'generate' && accountSelectionProblem())) throw new Error('流程或申报账户已变化，请重新发送')
    request = runOnly ? defaultRequest : [defaultRequest, rawRequest].filter(Boolean).join('\n\n')
  }
  if (runOnly) {
    appendMessage(request, 'user')
    await executeAndShowEvidence(id, { mode, request, taskCode })
    if (current?.id === id && $('request').value.trim() === rawRequest) $('request').value = ''
    return
  }
  appendMessage((preview.text||defaultAgentPrompts[mode])+(files.length?'\n附件：'+files.map(file=>file.name).join('、'):'')+(preview.parts.length?'\nHTML源码将自动转换为附件。':''), 'user'); $('request').value = ''
  attachmentDrafts.delete(id);renderRequestAttachments()
  try { await invoke('agent:start', id, { request, taskCode, attachmentIds:files.map(file=>file.artifactId), mode,
    engine:$('composerEngine').value,modelName:$('composerModel').value,writeToEditor:false }) }
  catch(error){
    const merged=new Map([...files,...(attachmentDrafts.get(id)||[])].map(file=>[file.artifactId,file]))
    if(current?.id===id){
      if(!$('request').value)$('request').value=rawRequest
      attachmentDrafts.set(id,[...merged.values()]);renderRequestAttachments()
      throw error
    }
    const tab = workspaceTabs.get(id)
    if(tab?.view){
      if(!tab.view.values.request)tab.view.values.request=rawRequest
      attachmentDrafts.set(id,[...merged.values()])
    }
  }
  finally { if(current?.id===id) await refreshSnapshot() }
}
action('steer', async () => {
  const id = requireCurrent()
  await Promise.all([...(attachmentUploads.get(id)||[])])
  if(current?.id!==id)throw new Error('当前流程已切换')
  const request = $('request').value.trim(), files=attachmentDrafts.get(id)||[]
  if (!request&&!files.length) throw new Error('请填写补充指令或添加附件')
  await invoke('agent:steer', id, request, current.turn?.id,files.map(file=>file.artifactId)); $('request').value = ''
  attachmentDrafts.delete(id);renderRequestAttachments()
  notice('补充指令已排队，旧的待授权执行已撤销；正在执行的动作需要点击停止才能中断。')
})
action('reconcileExecutor', async () => {
  await invoke('agent:reconcile', requireCurrent()); await refreshSnapshot()
  notice('已确认执行器停止，未知执行占用已解除。')
})
async function direct(name, args = {}) {
  const id = requireCurrent()
  if(inputDirty())throw new Error('请先更新当前步骤输入，避免执行旧配置')
  return executeAndShowEvidence(id, { request: name, mode: 'develop', directTool: { name, args } })
}
async function executeAndShowEvidence(id, input) {
  const previousTurnId = current.turn?.id
  try { await invoke('agent:start', id, input) }
  finally {
    if (current?.id === id) {
      try {
        const next = await refreshSnapshot()
        if (next?.turn && next.turn.id !== previousTurnId && !$('jsonDialog').open && !$('executionEvidenceDialog')?.open) {
          const run = next.runs.find(item => item.turnId === next.turn.id)
          if (run) await showDebugExecutionDetails(id, run.artifactId)
        }
      } catch (error) { notice(error.message, true) }
    }
  }
}
action('runCurrent', () => direct('run_current_dsl'))
action('runWithCapturePoints', async () => {
  const id = requireCurrent()
  if (inputDirty()) throw new Error('请先更新当前步骤输入，避免执行旧配置')
  const revision = current.revision, taskCode = current.taskCode
  const { dsl } = await invoke('workspace:dsl', id)
  if (current?.id !== id || current.revision !== revision || current.taskCode !== taskCode) throw new Error('调试账户或流程已变化，请重新选择采证点')
  const choices = []
  for (const flow of [dsl, ...(dsl.subflows || [])]) {
    const addSteps = (steps, prefix) => {
      for (const step of steps) {
        if (step.status === 0) continue
        const name = prefix + ' / ' + (step.stepName || step.stepCode)
        choices.push({ flowCode: flow.flowCode, stepCode: step.stepCode, name })
        addSteps(step.body || step.children || [], name)
      }
    }
    addSteps(flow.steps, flow.flowName || flow.flowCode)
  }
  if (!choices.length) throw new Error('没有启用的采证步骤')
  const dialog = document.createElement('dialog')
  dialog.className = 'capture-points-dialog'
  const form = document.createElement('form')
  const title = document.createElement('h2')
  title.textContent = '指定采证点运行'
  dialog.setAttribute('aria-label', title.textContent)
  const rows = document.createElement('div')
  const toolbar = document.createElement('div')
  toolbar.className = 'row'
  const error = document.createElement('p')
  error.setAttribute('role', 'alert')
  const button = (label, callback, parent = toolbar) => {
    const control = document.createElement('button')
    control.type = 'button'; control.textContent = label; control.onclick = callback
    parent.append(control)
    return control
  }
  const entries = []
  const add = button('添加采证点', () => addRow())
  button('取消', () => dialog.close())
  const submit = button('运行当前 DSL')
  submit.type = 'submit'
  function addRow() {
    const row = document.createElement('div')
    row.className = 'row capture-point-row'
    const step = document.createElement('select'), timing = document.createElement('select')
    step.setAttribute('aria-label', '采证步骤')
    step.append(...choices.map(({ name }, index) => new Option(name, index)))
    timing.setAttribute('aria-label', '采证时机')
    timing.append(new Option('执行后', 'AFTER'), new Option('执行前', 'BEFORE'))
    const evidence = {}
    const entry = { step, timing, evidence }
    row.append(step, timing)
    for (const [key, label] of [['dom', 'DOM'], ['ctx', 'CTX'], ['screenshot', '截图']]) {
      const field = document.createElement('label'), check = document.createElement('input')
      check.type = 'checkbox'; check.checked = true
      evidence[key] = check
      field.append(check, label); row.append(field)
    }
    button('移除', () => {
      entries.splice(entries.indexOf(entry), 1); row.remove()
      add.disabled = false; submit.disabled = !entries.length
    }, row)
    entries.push(entry); rows.append(row)
    add.disabled = entries.length >= 8; submit.disabled = false
  }
  form.onsubmit = event => {
    event.preventDefault()
    if (current?.id !== id || current.revision !== revision || current.taskCode !== taskCode) {
      error.textContent = '调试账户或流程已变化，请重新选择采证点。'; return
    }
    const capturePoints = entries.map(({ step, timing, evidence }) => {
      const { flowCode, stepCode } = choices[Number(step.value)]
      return { flowCode, stepCode, timing: timing.value, dom: evidence.dom.checked, ctx: evidence.ctx.checked, screenshot: evidence.screenshot.checked }
    })
    if (capturePoints.some(point => !point.dom && !point.ctx && !point.screenshot)) {
      error.textContent = '每个采证点至少选择一种证据。'; return
    }
    if (new Set(capturePoints.map(point => JSON.stringify([point.flowCode, point.stepCode, point.timing]))).size !== capturePoints.length) {
      error.textContent = '同一步骤和时机只需添加一次。'; return
    }
    dialog.close()
    direct('run_current_dsl', { capturePoints }).catch(failure => notice(failure.message, true))
  }
  dialog.onclose = () => dialog.remove()
  form.append(title, rows, error, toolbar); dialog.append(form); document.body.append(dialog)
  addRow()
  dialog.showModal()
})
action('runStep', () => {
  const step = selectedStep(); if (!step) throw new Error('请选择步骤')
  return direct('run_selected_step', { stepCode: step.stepCode })
})
action('runCandidate', () => direct('run_proposed_dsl'))
action('continueRun', () => direct('continue_failed_run'))
action('stopAgent', () => invoke('agent:stop', requireCurrent()))
$('stopAgentActivity').onclick = () => $('stopAgent').click()
for (const [id, allowed] of [['approve', true], ['reject', false]]) action(id, async () => {
  if (!approvals) throw new Error('执行授权已失效')
  await invoke('agent:approve', requireCurrent(), approvals, allowed); approvals = null; $('approval').hidden = true
})
action('applyCandidate',()=>showPatchReview())
action('discardCandidate',async()=>{
  if(inputDirty())throw new Error('请先更新当前步骤输入，再放弃补丁')
  current=await invoke('workspace:candidate',requireCurrent(),'discard');renderWorkspace();notice('已放弃本次补丁，步骤未修改。')
})
action('evidence', () => showDebugExecutionDetails(requireCurrent(), null, 'dsl'))
action('mcp', async () => {
  const value = await invoke('mcp:control', requireCurrent(), true)
  showJson('MCP 连接', { mcpServers: { 'rpa-agent': { url: value.url, http_headers: { Authorization: 'Bearer ' + value.bearerToken } } } }, null,
    '仅监听本机并绑定当前会话。外部执行同样经过授权和执行锁；切换平台或设置后连接失效。关闭当前工作台会话前可点击下面按钮停止 MCP。')
  const button = document.createElement('button'); button.textContent = '停止 MCP'
  button.onclick = async () => { await invoke('mcp:control', current.id, false); $('jsonDialog').close() }
  $('dialogList').append(button)
})
function renderConnections() {
  $('connections').replaceChildren()
  connections.forEach((item, index) => {
    const row = document.createElement('div'); row.className = 'connection-row'
    const url = document.createElement('input'); url.placeholder = '执行器地址（可含代理路径）'; url.value = item.baseUrl
    url.oninput = () => { item.baseUrl = url.value }
    const token = document.createElement('input'); token.type = 'password'; token.autocomplete = 'off'; token.placeholder = item.hasDebugToken ? '令牌已保存，留空保留' : '调试令牌'
    token.oninput = () => { item.debugToken = token.value }
    const runtime=document.createElement('input');runtime.placeholder='Runtime 地址（默认同主机 :19090）';runtime.value=item.runtimeUrl||'';runtime.oninput=()=>{item.runtimeUrl=runtime.value}
    const remove = document.createElement('button'); remove.textContent = '移除'; remove.onclick = () => { connections.splice(index, 1); renderConnections() }
    const name=document.createElement('input');name.placeholder='服务名称（如万科）';name.setAttribute('aria-label','后台服务名称');name.maxLength=80;name.value=item.serviceName||''
    name.oninput=()=>{item.serviceName=name.value}
    row.append(name,url,runtime,token,remove); $('connections').append(row)
  })
}
async function loadSettings() {
  const value = await invoke('settings:get')
  for (const field of ['modelBaseUrl', 'modelName']) $(field).value = value[field]
  $('additionalModelNames').value=(value.additionalModelNames||[]).join('\n')
  $('modelApiKey').value = ''; $('localDebugToken').value = ''; $('clearModelApiKey').checked = false
  $('modelApiKey').placeholder = value.hasModelApiKey ? '密钥已保存，留空保留' : 'API Key'
  $('localDebugToken').placeholder = value.hasLocalDebugToken ? '令牌已保存，留空保留' : '执行器调试令牌'
  $('remoteEnabled').checked = value.remoteEnabled; connections = value.connections; renderConnections()
  for(const id of ['startExecutor','stopExecutor','logs'])$(id).hidden=value.remoteEnabled
}
action('addConnection', async () => { connections.push({ baseUrl: '', debugToken: '' }); renderConnections() })
action('saveSettings', async () => {
  if (!await confirmNavigation()) return
  const saved = await invoke('settings:get')
  await invoke('settings:save', { ...saved, modelBaseUrl: $('modelBaseUrl').value, modelName: $('modelName').value, modelApiKey: $('modelApiKey').value,
    additionalModelNames:$('additionalModelNames').value.split(/\r?\n/).map(name=>name.trim()).filter(Boolean), clearModelApiKey: $('clearModelApiKey').checked })
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
    $('executorSettingsDialog').close()
    notice('执行器配置已保存，请重新打开流程。')
  } catch (error) {
    $('executorSaveMessage').textContent = '保存失败：' + error.message
    throw error
  }
})
for (const [id, operation] of [['startExecutor', 'start'], ['stopExecutor', 'stop'], ['switchExecutor', 'switch']]) action(id, async () => {
  const result = await invoke('executor:control', operation, $('platform').value); notice(result.text)
  await refreshExecutorCards()
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
