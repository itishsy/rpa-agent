'use strict'
let takeoverDialog=null
function fillTakeoverSelect(element,rows,value,label,placeholder){element.replaceChildren(new Option(placeholder,''),...rows.map(row=>new Option(label(row),value(row))))}
async function openAgentTakeover(rowId){
  if(takeoverDialog?.open){takeoverDialog.focus();return}
  const options=await window.desktop.invoke('monitor:takeover-options',rowId)
  const dialog=document.createElement('dialog');dialog.className='takeover-dialog';takeoverDialog=dialog
  const form=document.createElement('form'),title=document.createElement('h2');title.textContent='Agent接管 · '+options.appName
  const info=document.createElement('p');info.className='muted';info.textContent='申报账户：'+options.accountNumber+(options.machineCode?' · 设备：'+options.machineCode:' · 请核对所选执行器属于该任务')
  const executor=document.createElement('select'),flow=document.createElement('select');executor.required=flow.required=true;executor.setAttribute('aria-label','接管执行器');flow.setAttribute('aria-label','接管流程')
  fillTakeoverSelect(executor,options.executors,value=>value,value=>value,'选择远程执行器');fillTakeoverSelect(flow,options.flows,value=>value.flowCode,value=>value.flowName,'选择对应主流程')
  if(options.executors.length===1)executor.value=options.executors[0]
  if(options.flows.some(item=>item.flowCode===options.flowCode))flow.value=options.flowCode
  else if(options.flows.length===1)flow.value=options.flows[0].flowCode
  const error=document.createElement('p');error.setAttribute('role','status')
  const submit=document.createElement('button');submit.type='submit';submit.className='primary';submit.textContent='接管并诊断'
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='取消';cancel.onclick=()=>dialog.close()
  const confirmDevice=document.createElement('input');confirmDevice.type='checkbox'
  if(!options.machineCode){confirmDevice.required=true;const label=document.createElement('label');label.className='checkbox';label.append(confirmDevice,document.createTextNode('确认所选执行器对应当前任务'));form.append(label)}
  for(const [labelText,control] of [['远程执行器',executor],['流程',flow]]){const label=document.createElement('label');label.textContent=labelText;label.append(control);form.append(label)}
  form.prepend(title,info);form.append(error,submit,cancel);dialog.append(form);document.body.append(dialog)
  let pending=false
  dialog.addEventListener('cancel',event=>{if(pending)event.preventDefault()});dialog.onclose=()=>{dialog.remove();if(takeoverDialog===dialog)takeoverDialog=null}
  form.onsubmit=async event=>{
    event.preventDefault();if(pending)return;pending=true;for(const control of [submit,cancel,executor,flow])control.disabled=true;error.textContent='正在通过 RPA Runtime 接管，确认调试模式后打开 AI 配置…'
    try{await window.desktop.invoke('monitor:takeover',{id:options.id,executor:executor.value,flowCode:flow.value,confirmExecutor:confirmDevice.checked});dialog.close()}
    catch(failure){error.textContent=String(failure.message).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'')}
    finally{pending=false;for(const control of [submit,cancel,executor,flow])control.disabled=false}
  }
  dialog.showModal();if(options.machineCode&&executor.value&&flow.value)form.requestSubmit()
}
