'use strict'
const flowFilterControls=[]
function createFlowFilter(id,inline=false){
  const select=$(id),oldField=select.parentElement
  const field=document.createElement('div');field.className='flow-filter-field'
  const caption=document.createElement('span');caption.className='flow-filter-caption sr-only';caption.id=id+'Label';caption.textContent=oldField.firstChild.textContent.trim()
  oldField.replaceWith(field);field.append(caption,select);select.hidden=true
  const container=document.createElement('div');container.className=inline?'flow-type-options':'flow-filter-options';container.setAttribute('role','group');container.setAttribute('aria-labelledby',caption.id)
  let trigger,popup,search
  if(inline)field.append(container)
  else{
    trigger=document.createElement('button');trigger.type='button';trigger.className='flow-filter-trigger';trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-label','选择'+caption.textContent)
    popup=document.createElement('div');popup.id=id+'Popup';popup.popover='auto';popup.className='flow-filter-popup';popup.setAttribute('role','dialog');popup.setAttribute('aria-labelledby',caption.id);trigger.setAttribute('aria-controls',popup.id)
    search=document.createElement('input');search.type='search';search.placeholder='搜索'+caption.textContent;search.setAttribute('aria-label',search.placeholder)
    const clear=document.createElement('button');clear.type='button';clear.className='flow-filter-clear';clear.textContent='清空选择'
    clear.onclick=()=>{for(const option of select.options)option.selected=false;sync()}
    popup.append(search,container,clear);field.append(trigger,popup)
    trigger.onclick=()=>{
      if(popup.matches(':popover-open')){popup.hidePopover();return}
      const rect=trigger.getBoundingClientRect(),width=Math.min(280,innerWidth-24),height=Math.min(330,innerHeight-36)
      popup.style.width=width+'px';popup.style.left=Math.max(12,Math.min(rect.left,innerWidth-width-12))+'px';popup.style.top=Math.max(12,Math.min(rect.bottom+6,innerHeight-height-12))+'px';popup.style.maxHeight=height+'px'
      popup.showPopover();search.focus()
    }
    popup.addEventListener('toggle',()=>trigger.setAttribute('aria-expanded',String(popup.matches(':popover-open'))))
    search.oninput=()=>{const key=search.value.trim().toLowerCase();container.querySelectorAll('label').forEach(label=>{label.hidden=!label.textContent.toLowerCase().includes(key)})}
  }
  let optionSignature=''
  function sync(){
    const signature=JSON.stringify([...select.options].map(option=>[option.value,option.textContent,option.disabled]))
    if(signature!==optionSignature){
      optionSignature=signature;container.replaceChildren()
      for(const option of select.options){
        const label=document.createElement('label'),checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.value=option.value;checkbox.disabled=option.disabled
        checkbox.onchange=()=>{option.selected=checkbox.checked;sync()}
        label.append(checkbox,option.textContent);container.append(label)
      }
      if(!select.options.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='暂无可选项';container.append(empty)}
    }
    [...container.querySelectorAll('input[type=checkbox]')].forEach((checkbox,index)=>{checkbox.checked=select.options[index].selected})
    if(trigger){const selected=[...select.selectedOptions].map(option=>option.textContent);trigger.textContent=(selected.length?selected.join('、'):'全部'+caption.textContent)+' ▾';trigger.title=selected.length?selected.join('、'):'全部'+caption.textContent;search.oninput()}
  }
  new MutationObserver(sync).observe(select,{childList:true,subtree:true,attributes:true})
  sync.reset=()=>{if(search)search.value='';sync()}
  select.addEventListener('change',sync);sync();flowFilterControls.push(sync)
}
function syncFlowFilters(){flowFilterControls.forEach(sync=>sync())}
function resetFlowFilterSearch(){flowFilterControls.forEach(sync=>sync.reset())}
createFlowFilter('flowTypes',true);createFlowFilter('flowServices');createFlowFilter('flowSystems')
window.addEventListener('resize',()=>document.querySelectorAll('.flow-filter-popup:popover-open').forEach(popup=>popup.hidePopover()))
