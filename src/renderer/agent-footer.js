'use strict'
const agentPanel=document.querySelector('#workspace .agent')
const referenceHint=document.createElement('div');referenceHint.id='referenceModeHint';referenceHint.className='reference-mode-hint';referenceHint.hidden=true
referenceHint.textContent='引用流程：可运行调试、生成建议补丁；不能直接修改、应用或保存。'
agentPanel.querySelector('.panel-heading').after(referenceHint)
const assertionRow=$('assertions').parentElement,debugRow=$('runCurrent').parentElement,sessionRow=$('history').parentElement
const footer=document.createElement('div');footer.id='agentFooter';footer.className='agent-heading-actions'
function actionMenu(id,title,buttons){
  const trigger=document.createElement('button');trigger.id=id+'Trigger';trigger.type='button';trigger.textContent=title+' ▾';trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls',id)
  const menu=document.createElement('div');menu.id=id;menu.className='agent-action-menu';menu.popover='auto';menu.setAttribute('role','dialog');menu.setAttribute('aria-label',title)
  for(const button of buttons){menu.append(button);button.addEventListener('click',()=>menu.hidePopover())}
  trigger.onclick=()=>{
    if(menu.matches(':popover-open')){menu.hidePopover();return}
    menu.style.maxHeight=Math.max(120,Math.min(420,innerHeight-32))+'px';menu.showPopover()
    const rect=trigger.getBoundingClientRect(),size=menu.getBoundingClientRect()
    menu.style.left=Math.max(12,Math.min(rect.right-size.width,innerWidth-size.width-12))+'px';menu.style.top=Math.max(12,Math.min(rect.bottom+7,innerHeight-size.height-12))+'px'
  }
  menu.addEventListener('toggle',()=>trigger.setAttribute('aria-expanded',String(menu.matches(':popover-open'))))
  footer.append(trigger,menu)
}
const businessActions = [['businessContext', '业务上下文'], ['businessDiagnosis', '诊断与对账'], ['importBusinessRules', '导入地区规则'], ['archiveBusinessCase', '归档已验证经验']].map(([id, title]) => {
  const button = document.createElement('button'); button.id = id; button.type = 'button'; button.textContent = title; return button
})
actionMenu('agentSessionMenu','会话与工具',[viewExecutionDetails,$('stopAgent'),$('reconcileExecutor'),...businessActions,$('assertions'),$('runCurrent'),$('runStep'),$('runCandidate'),$('continueRun'),$('steer'),$('retryTasks'),...sessionRow.children])
footer.prepend($('agentState'));agentPanel.querySelector('.panel-heading').append(footer)
action('businessContext', async () => {
  const id = requireCurrent(), context = await invoke('workspace:business-context', id), inputs = {}
  const fields = nativeForm('业务上下文', '填写本次业务的预期信息供 Agent 核对。这里不会修改流程参数、切换账户或代替网厅核验；已有来源冲突会继续保留。', async () => {
    if (requireCurrent() !== id) throw new Error('当前流程已变化，请重新打开')
    await invoke('workspace:business-context', id, Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value])))
    await refreshSnapshot(); notice('业务预期已保存，原结果需重新核验')
  })
  for (const [key, label] of [['region', '地区'], ['system', '申报系统'], ['businessType', '业务类型'], ['subject', '企业主体'], ['account', '申报账户'], ['period', '业务所属期'], ['personCount', '人数'], ['amount', '金额']]) {
    const field = context.fields[key]
    inputs[key] = formField(fields, key, label, { value: field.confirmed?.value ?? '' })
    const hint = document.createElement('small'); hint.className = 'muted'
    hint.textContent = field.candidates.length ? field.candidates.map(item => item.source + '：' + String(item.value)).join('；') + (field.conflict ? '（来源存在差异，请核对）' : '') : '尚无来源信息'
    inputs[key].parentElement.append(hint)
  }
})
action('businessDiagnosis', async () => {
  await refreshSnapshot(); requireCurrent()
  const fields = nativeForm('诊断与对账', '下列诊断为排查线索；待处理、未知和失败均不代表办结。', async () => {}, { readonly: true })
  const add = text => { const p = document.createElement('p'); p.className = 'wide'; p.textContent = text; fields.append(p) }
  const run = current.runs[0]
  if (!run) { add('尚无执行现场。请先确认业务上下文。'); return }
  add('执行状态：' + run.result.status + '；业务核验：' + (run.verification?.status || 'UNKNOWN'))
  if (run.verification?.reason) add('核验说明：' + run.verification.reason)
  const labels = { account: '申报账户', period: '所属期', personCount: '人数', amount: '金额', officialState: '官方办结状态' }
  if (run.verification?.coverage?.missing.length) add('尚缺核验项：' + run.verification.coverage.missing.map(key => labels[key] || key).join('、'))
  if (run.result.error) add('现场提示：' + run.result.error)
  const card = current.diagnosisCard
  if (card) { add('下一项核验：' + card.next); add('处理建议：' + card.suggestion) }
  const saved = card?.recorded
  if (saved) { add('已保留的诊断假设：' + saved.summary + '（需核对账户和版本）'); add('下一项验证：' + saved.nextVerification) }
  for (const detail of run.verification?.details || []) {
    add(detail.id + '：' + detail.state)
    if (detail.reason) add(detail.reason)
    for (const item of detail.items || []) add(item.key + '：' + item.state + '；预期：' + item.expected + '；实际：' + (item.actual ?? '缺少证据'))
    if (detail.unexpected?.length) add('非预期人员：' + detail.unexpected.join('、'))
    if (detail.duplicateKeys?.length) add('重复人员标识：' + detail.duplicateKeys.join('、'))
  }
})
action('importBusinessRules', async () => {
  const result = await invoke('business-knowledge:import-rules', requireCurrent())
  if (result) notice('已导入 ' + result.count + ' 条地区规则；仅匹配适用范围且在有效期内的规则')
})
action('archiveBusinessCase', async () => {
  await invoke('business-knowledge:archive', requireCurrent()); notice('已归档当前已验证业务结果，供相同地区和业务参考')
})
assertionRow.remove();debugRow.remove();sessionRow.remove()
const composerRow=$('mode').parentElement;composerRow.classList.add('agent-composer-controls');composerRow.prepend($('taskSelectorHost'))
const tabBar=document.createElement('div');tabBar.className='design-tabbar';$('designTabs').before(tabBar);tabBar.append($('designTabs'))
const pageActions=document.createElement('div');pageActions.id='designPageActions';pageActions.hidden=true
pageActions.append(voidedStepsToggle,$('stepSave'));tabBar.append(pageActions)
window.addEventListener('resize',()=>document.querySelectorAll('.agent-action-menu:popover-open').forEach(menu=>menu.hidePopover()))
