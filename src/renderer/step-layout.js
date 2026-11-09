'use strict'
let stepDrag=null,stepInsertTarget=null,stepNoticeTimer
function stepEditingBlocked(){return !current||current.readOnly||workspaceOpening||productionRunning||current.productionRunning||['running','waiting_approval','stopping'].includes(current.state)}
function showStepNotice(message,error=false){
  if(message.startsWith('流程已打开')||message.startsWith('已登录：')||$('stepPropertiesDialog').open)return
  $('stepToast').textContent=message;$('stepToast').className=error?'step-toast error':'step-toast';$('stepToast').hidden=false
  clearTimeout(stepNoticeTimer);stepNoticeTimer=setTimeout(()=>{$('stepToast').hidden=true},error?6500:3500)
}
function stepLocation(code){let found;visitSteps(current.dsl.steps,(step,path)=>{if(step.stepCode===code)found=path});if(!found)throw new Error('步骤已变化，请重新选择');return found}
function showStepInsert(location){
  if(stepEditingBlocked())return
  if(inputDirty())throw new Error('请先更新当前步骤输入')
  const step=location?atPath(current.dsl,location):null
  stepInsertTarget={sessionId:current.id,revision:current.revision,stepCode:step?.stepCode,clipboard:copied?structuredClone(copied):null}
  $('stepInsertContext').textContent=step?'当前步骤：'+step.stepName:'在流程中添加第一个步骤'
  $('stepInsertMode').value='new';$('stepInsertLevel').value='sibling'
  $('stepInsertMode').querySelector('[value=copy]').disabled=!step
  $('stepInsertMode').querySelector('[value=paste]').disabled=!copied
  $('stepInsertLevel').querySelector('[value=child]').disabled=!location||location.length!==1
  $('stepInsertLevel').disabled=!step
  $('stepInsertCommand').replaceChildren(...[...$('actionCode').options].map(option=>new Option(option.textContent,option.value)))
  $('stepInsertCommand').value=step?.actionCode||'';$('stepInsertName').value=''
  $('stepInsertError').textContent='';syncStepInsertMode()
  $('stepInsertDialog').showModal();$('stepInsertName').focus()
}
function insertionTarget(){
  if(stepEditingBlocked())throw new Error('当前流程不可编辑')
  if(!stepInsertTarget||current.id!==stepInsertTarget.sessionId||current.revision!==stepInsertTarget.revision)throw new Error('步骤版本已变化，请重新点击新增')
  if(inputDirty())throw new Error('请先更新当前步骤输入')
  return stepInsertTarget.stepCode?stepLocation(stepInsertTarget.stepCode):null
}
function syncStepInsertMode(){
  const mode=$('stepInsertMode').value,source=mode==='copy'?atPath(current.dsl,stepLocation(stepInsertTarget.stepCode)):stepInsertTarget.clipboard
  const copying=mode!=='new'
  $('stepInsertCommand').disabled=copying
  if(copying&&source){
    if(![...$('stepInsertCommand').options].some(option=>option.value===source.actionCode))$('stepInsertCommand').add(new Option(source.actionCode,source.actionCode))
    $('stepInsertCommand').value=source.actionCode;$('stepInsertName').value=source.stepName+'（副本）'
  }else $('stepInsertName').value=''
  $('stepInsertHint').textContent=copying?'复制包含参数、策略和子步骤，并生成新的步骤编码；名称冲突会自动处理。':'新增后点击步骤齿轮配置参数，保存流程后同步到平台。'
  $('confirmStepInsert').textContent=copying?'确认复制':'确认新增'
}
$('stepInsertMode').onchange=()=>{try{insertionTarget();syncStepInsertMode()}catch(error){$('stepInsertError').textContent=error.message}}
$('closeStepInsert').onclick=()=>{if(!$('confirmStepInsert').disabled)$('stepInsertDialog').close()}
$('stepInsertDialog').addEventListener('cancel',event=>{if($('confirmStepInsert').disabled)event.preventDefault()})
$('stepInsertForm').onsubmit=async event=>{
  event.preventDefault();if($('confirmStepInsert').disabled)return
  $('stepInsertError').textContent='';$('confirmStepInsert').disabled=true;$('closeStepInsert').disabled=true
  try{
    const path=insertionTarget(),base={...stepInsertTarget},asChild=$('stepInsertLevel').value==='child',mode=$('stepInsertMode').value
    const name=$('stepInsertName').value.trim(),command=$('stepInsertCommand').value
    if(!name)throw new Error('请输入步骤名称')
    if(!command||![...$('stepInsertCommand').options].some(option=>option.value===command))throw new Error('请选择有效指令')
    if(asChild&&(!path||path.length!==1))throw new Error('仅支持两级步骤')
    const parent=asChild?atPath(current.dsl,path):path?.length>1?current.dsl.steps[path[0]]:null
    const field=parent?.actionCode==='codeBlock'?'body':'children'
    const list=parent?(parent[field]||[]):current.dsl.steps
    const index=asChild?list.length:path?path.at(-1)+1:list.length
    if(mode==='new'){
      if(list.some(step=>step.stepName===name))throw new Error('同级步骤名称已存在，请修改名称')
      const dsl=structuredClone(current.dsl),step={stepCode:crypto.randomUUID(),stepName:name,actionCode:command,actionArgs:{},targetArgs:{}}
      const target=parent?dsl.steps.find(step=>step.stepCode===parent.stepCode):null
      const destination=target?(target[field]||(target[field]=[])):dsl.steps
      destination.splice(index,0,step);await updateDsl(dsl,step.stepCode)
    }else{
      const source=mode==='copy'?(path?atPath(current.dsl,path):null):base.clipboard
      if(!source)throw new Error('没有可复制的步骤')
      const incoming=structuredClone(source)
      window.stepStructure.renameReferences({steps:[incoming]},incoming.stepCode,incoming.stepName,name);incoming.stepName=name
      const preview=await invoke('workspace:paste-preview',current.id,{step:incoming,index,...(parent?{parentStepCode:parent.stepCode}:{})})
      insertionTarget()
      const destination=parent?preview.dsl.steps.find(step=>step.stepCode===parent.stepCode)[field]:preview.dsl.steps
      await updateDsl(preview.dsl,destination[index].stepCode)
      if(preview.warnings.length)notice(preview.warnings.join('\n'))
    }
    $('stepInsertDialog').close();notice(mode==='new'?'步骤已新增，请配置参数后保存流程。':'步骤已复制，保存流程后同步到平台。')
  }catch(error){$('stepInsertError').textContent=error.message}
  finally{$('confirmStepInsert').disabled=false;$('closeStepInsert').disabled=false}
}
function attachStepDragging(row,step){
  row.dataset.stepCode=step.stepCode;row.draggable=!stepEditingBlocked()
  row.addEventListener('dragstart',event=>{
    if(stepEditingBlocked()||inputDirty()||event.target.closest('.step-row-actions')){event.preventDefault();if(inputDirty())notice('请先更新当前步骤输入',true);return}
    stepDrag={sessionId:current.id,revision:current.revision,stepCode:step.stepCode}
    event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-rpa-step',step.stepCode);row.classList.add('dragging')
  })
  row.addEventListener('dragover',event=>{
    if(!stepDrag||stepEditingBlocked())return
    event.preventDefault();event.dataTransfer.dropEffect='move'
    const rect=row.getBoundingClientRect();row.dataset.dropPosition=event.clientY>rect.top+rect.height/2?'after':'before'
  })
  row.addEventListener('dragleave',()=>{delete row.dataset.dropPosition})
  row.addEventListener('dragend',()=>{stepDrag=null;document.querySelectorAll('.step-row').forEach(item=>{item.classList.remove('dragging');delete item.dataset.dropPosition})})
  row.addEventListener('drop',async event=>{
    event.preventDefault();const drag=stepDrag,position=row.dataset.dropPosition||'before';stepDrag=null;delete row.dataset.dropPosition
    if(!drag||stepEditingBlocked())return
    try{
      if(current.id!==drag.sessionId||current.revision!==drag.revision||inputDirty())throw new Error('步骤或输入已变化，请重新拖动')
      if(drag.stepCode===step.stepCode)return
      const dsl=window.stepOrder.reorderSteps(current.dsl,drag.stepCode,step.stepCode,position)
      await updateDsl(dsl,drag.stepCode);notice('步骤顺序已更新，保存后同步到平台。')
    }catch(error){notice(error.message,true)}
  })
}
