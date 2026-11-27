'use strict'
function patchStep(dsl,code){let found;visitSteps(dsl?.steps||[],step=>{if(step.stepCode===code)found=step});return found}
function patchText(value){return value===undefined?'（未设置）':typeof value==='string'?value:pretty(value)}
function patchChangeList(host,proposal,baseDsl){
  host.replaceChildren()
  for(const [index,op] of (proposal.operations||[]).entries()){
    const before=patchStep(baseDsl,op.stepCode),after=patchStep(proposal.dsl,op.stepCode||op.step?.stepCode)
    const card=document.createElement('details');card.className='patch-change'
    const heading=document.createElement('summary')
    const kind={set:'修改',insert:'新增',remove:'删除',move:'移动'}[op.op]||op.op
    heading.textContent=(index+1)+'. '+kind+' · '+(after?.stepName||before?.stepName||op.step?.stepName||op.stepCode||'步骤')+(op.field?' · '+op.field+(op.key?'.'+op.key:''):'')
    const values=document.createElement('div');values.className='patch-comparison'
    const value=(side,content)=>{const section=document.createElement('section'),title=document.createElement('strong'),pre=document.createElement('pre');title.textContent=side;pre.textContent=patchText(content);section.append(title,pre);values.append(section)}
    if(op.op==='set'){
      value('修改前',op.key?before?.[op.field]?.[op.key]:before?.[op.field])
      value('修改后',op.value)
    }else if(op.op==='move'){
      value('移动前',before);value('移动后位置',{parentStepCode:op.parentStepCode||'顶层',index:op.index??'末尾'})
    }else{value('修改前',before);value('修改后',after)}
    card.append(heading,values);host.append(card)
  }
}
let displayedPatch=null
function renderPatchCard(){
  const proposal=current?.proposal;if(!proposal){displayedPatch=null;return}
  const key=current.id+pretty(proposal)
  if(key!==displayedPatch){
    displayedPatch=key;$('candidate').open=true
    patchChangeList($('patchChanges'),proposal,proposal.targetFlowCode?null:current.dsl)
  }
  const run=proposal.id&&current.runs?.find(item=>item.proposalId===proposal.id)
  $('patchStatus').textContent=(proposal.targetFlowCode?'子流程：'+(proposal.dsl.flowName||proposal.targetFlowCode)+' · ':'')+(proposal.operations?.length||0)+' 项修改 · '+(run?'调试结果：'+debugExecutionResult.statusLabel(run.result.status):'尚未运行验证')+' · '+(proposal.advisoryOnly?'只读建议，不能直接应用':'应用到本地步骤后，仍需检查并保存')
  $('previewCandidate').disabled=workspaceOpening||productionRunningFor(current)||['running','waiting_approval','stopping'].includes(current.state)
}
async function showPatchReview(){
  if(inputDirty())throw new Error('请先更新当前步骤输入，再查看或应用补丁')
  const sourceId=requireCurrent(),review=await invoke('workspace:candidate',sourceId,'review')
  if(current?.id!==sourceId)throw new Error('当前流程已切换，请重新查看补丁')
  const targetDraft=workspaceTabs.get(review.targetSessionId)
  if(review.targetSessionId!==sourceId&&targetDraft?.view?.dirty)throw new Error('子流程有未更新的属性输入，请先到对应 Tab 更新后再应用补丁')
  const dialog=document.createElement('dialog');dialog.id='patchReviewDialog';dialog.className='patch-review-dialog'
  const header=document.createElement('div');header.className='patch-review-heading'
  const title=document.createElement('h2');title.textContent='修复补丁 · '+review.targetFlowName
  const close=document.createElement('button');close.textContent='关闭';close.onclick=()=>dialog.close()
  header.append(title,close)
  const help=document.createElement('p');help.className='muted';help.textContent=review.advisoryOnly?'只读流程建议补丁，仅可审阅与临时调试。':'请核对下方改动。确认后仅更新目标流程的本地草稿，不保存到平台、不执行流程。'
  const changes=document.createElement('div');patchChangeList(changes,review,review.baseDsl)
  const error=document.createElement('p');error.className='form-error';error.setAttribute('role','alert')
  const footer=document.createElement('div');footer.className='patch-review-footer'
  const apply=document.createElement('button');apply.id='confirmApplyPatch';apply.className='primary';apply.textContent='确认应用补丁';apply.disabled=review.advisoryOnly
  let applying=false
  apply.onclick=async()=>{
    if(applying)return
    applying=true;apply.disabled=true;close.disabled=true;error.textContent=''
    try{
      if(current?.id!==sourceId||inputDirty())throw new Error('流程或属性输入已变化，请关闭后重新查看补丁')
      const target=await invoke('workspace:candidate',sourceId,'apply',{reviewId:review.reviewId})
      if(target.id!==sourceId){
        current=await invoke('agent:snapshot',sourceId);rememberWorkspaceTab()
        const data=await invoke('workspace:attach',target.id);installWorkspace(data,sourceId)
      }else{current=target;renderWorkspace()}
      if($('hideDisabledSteps')){$('hideDisabledSteps').checked=false;$('stepTree').classList.remove('hide-disabled')}
      stepViewModes.set(target.id,'steps')
      let changed=null;visitSteps(current.dsl.steps,(step,location)=>{if(!changed&&review.changedStepCodes?.includes(step.stepCode))changed=location})
      if(changed)selected=changed
      renderWorkspace();setView('workspace');dialog.close()
      notice('修复补丁已应用到'+(target.id!==sourceId?'子流程 Tab':'左侧步骤')+'，尚未保存。请检查标记的步骤后点击“保存”。')
    }catch(failure){error.textContent=failure.message}
    finally{applying=false;apply.disabled=review.advisoryOnly;close.disabled=false}
  }
  dialog.addEventListener('cancel',event=>{if(applying)event.preventDefault()})
  dialog.addEventListener('close',()=>dialog.remove(),{once:true})
  footer.append(apply);dialog.append(header,help,changes,error,footer);document.body.append(dialog);dialog.showModal()
}
action('previewCandidate',showPatchReview)
