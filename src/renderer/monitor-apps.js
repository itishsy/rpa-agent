'use strict'
function monitorApplicationNames(value) {
  return [...new Set((Array.isArray(value)?value:[value]).flatMap(item=>String(item||'').split(/[,，;；\n\r]+/)).map(name=>name.trim()).filter(Boolean))]
}
function createMonitorApplications(host,field) {
  if(!host)return {render(){},saved(){},setBusy(){},commit(){return true}}
  let editing=null
  const make=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node}
  const help=make('p','按完整应用名称监控。支持逐项编辑，也可粘贴以逗号、分号或换行分隔的应用名称。','monitor-apps-help')
  const controls=make('div',null,'monitor-apps-controls'),input=make('input'),add=make('button','添加应用'),cancel=make('button','取消编辑')
  input.placeholder='例如：武汉-社保';input.setAttribute('aria-label','添加或编辑监控应用');add.type=cancel.type='button';cancel.hidden=true
  controls.append(input,add,cancel)
  const tools=make('div',null,'monitor-apps-controls'),count=make('span'),search=make('input')
  search.type='search';search.placeholder='查找已添加的应用';search.setAttribute('aria-label','查找监控应用');tools.append(count,search)
  const list=make('div',null,'monitor-apps-list'),message=make('div',null,'monitor-apps-message');message.setAttribute('role','status')
  const batch=make('details'),summary=make('summary','批量编辑'),textarea=make('textarea'),apply=make('button','应用批量修改')
  textarea.rows=6;textarea.setAttribute('aria-label','批量编辑监控应用，每行一个');apply.type='button';batch.append(summary,textarea,apply)
  host.append(help,controls,tools,list,message,batch)
  function reset(){editing=null;input.value='';add.textContent='添加应用';cancel.hidden=true}
  function write(names){field.value=monitorApplicationNames(names).join(', ');render(true)}
  function render(syncBatch=false){
    const names=monitorApplicationNames(field.value),visible=names.filter(name=>name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()))
    count.textContent=search.value?'显示 '+visible.length+' / 共 '+names.length+' 个应用':'共 '+names.length+' 个应用'
    if(syncBatch||!batch.open)textarea.value=names.join('\n');list.replaceChildren()
    if(!visible.length)list.append(make('p',names.length?'没有匹配的应用':'尚未添加监控应用','monitor-apps-help'))
    for(const name of visible){
      const chip=make('span',null,'monitor-app-chip'),edit=make('button',name),remove=make('button','×')
      edit.type=remove.type='button';edit.title='编辑 '+name;remove.setAttribute('aria-label','移除 '+name)
      edit.onclick=()=>{editing=name;input.value=name;add.textContent='更新应用';cancel.hidden=false;input.focus()}
      remove.onclick=()=>{if(editing===name)reset();write(names.filter(item=>item!==name));message.textContent='已移除，保存后生效。'}
      chip.append(edit,remove);list.append(chip)
    }
  }
  function commit(){
    const names=monitorApplicationNames(field.value),incoming=monitorApplicationNames(input.value)
    if(!incoming.length){if(editing){message.textContent='请填写应用名称，或取消编辑。';input.focus();return false}return true}
    if(editing&&incoming.length!==1){message.textContent='编辑时请只填写一个应用名称。';return false}
    if(editing&&incoming[0]!==editing&&names.includes(incoming[0])){message.textContent='该应用已存在。';return false}
    const next=editing?names.map(name=>name===editing?incoming[0]:name):[...names,...incoming]
    reset();write(next);message.textContent='已更新，保存后生效。';return true
  }
  add.onclick=commit;cancel.onclick=()=>{reset();message.textContent='已取消编辑。'}
  input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();commit()}else if(event.key==='Escape'){event.preventDefault();reset()}}
  search.oninput=()=>render();search.onkeydown=event=>{if(event.key==='Enter')event.preventDefault()}
  batch.addEventListener('toggle',()=>{if(batch.open)textarea.value=monitorApplicationNames(field.value).join('\n')})
  apply.onclick=()=>{reset();write(textarea.value);message.textContent='批量修改已应用，重复名称已自动合并。保存后生效。'}
  render();return {render,commit,saved(){reset();message.textContent='';render(true)},setBusy(value){host.querySelectorAll('input,button,textarea').forEach(control=>control.disabled=value)}}
}
