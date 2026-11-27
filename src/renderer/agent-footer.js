'use strict'
const agentPanel=document.querySelector('#workspace .agent')
const referenceHint=document.createElement('div');referenceHint.id='referenceModeHint';referenceHint.className='reference-mode-hint';referenceHint.hidden=true
referenceHint.textContent='只读流程：可运行调试、生成建议补丁；不能直接修改、应用或保存。'
agentPanel.querySelector('.panel-heading').after(referenceHint)
const taskRow=$('workspaceTaskControls'),debugRow=$('runCurrent').parentElement,sessionRow=$('evidence').parentElement
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
$('showDsl').textContent='查看 DSL'
$('stepRun').classList.remove('primary')
$('stepRun').title='运行服务器上已保存的流程'
actionMenu('agentSessionMenu','会话与工具',[$('showDsl'),viewExecutionDetails,$('stepRun'),$('stopAgent'),$('reconcileExecutor'),$('runCurrent'),$('runWithCapturePoints'),$('runStep'),$('runCandidate'),$('continueRun'),$('steer'),$('retryTasks'),...sessionRow.children])
footer.prepend($('agentState'));agentPanel.querySelector('.panel-heading').append(footer)
taskRow.remove();debugRow.remove();sessionRow.remove()
const tabBar=document.createElement('div');tabBar.className='design-tabbar';$('designTabs').before(tabBar);tabBar.append($('designTabs'))
const pageActions=document.createElement('div');pageActions.id='designPageActions';pageActions.hidden=true
pageActions.append($('taskSelectorHost'),stepRefresh,$('stepSave'));tabBar.append(pageActions)
window.addEventListener('resize',()=>document.querySelectorAll('.agent-action-menu:popover-open').forEach(menu=>menu.hidePopover()))
