'use strict'
// Lazy branches keep large flows responsive; all keys and values remain plain text.
window.createInlineJsonTree=value=>{
  const branches=new Set()
  const token=(text,kind)=>{const span=document.createElement('span');span.textContent=text;span.className='json-token-'+kind;return span}
  const node=(key,item,depth)=>{
    const name=token(key,'key'),container=item!==null&&typeof item==='object'
    if(!container){
      const line=document.createElement('div');line.className='inline-json-value'
      line.append(name,document.createTextNode(': '),token(JSON.stringify(item),item===null?'null':typeof item));return line
    }
    const details=document.createElement('details'),summary=document.createElement('summary'),children=document.createElement('div')
    const array=Array.isArray(item),count=Object.keys(item).length
    summary.append(name,token(array?' ['+count+']':' {'+count+'}','type'))
    if(item.stepName||item.flowName)summary.append(token(' '+(item.stepName||item.flowName),'label'))
    if(item.actionCode)summary.append(token(' · '+item.actionCode,'type'))
    children.className='inline-json-children';details.append(summary,children);branches.add(details)
    let loaded=false
    const populate=()=>{if(loaded||!details.open)return;loaded=true;for(const [key,child] of Object.entries(item))children.append(node(key,child,depth+1))}
    details.reveal=()=>{details.open=true;populate()};details.addEventListener('toggle',populate)
    if(depth<2)details.reveal()
    return details
  }
  return {root:node('$',value,0),expand:()=>{for(const branch of branches)branch.reveal()},collapse:()=>{for(const branch of branches)branch.open=false}}
}
// Read-only, local JSON inspection. Values are always text, never HTML.
window.showJsonViewer=(title,value,options={})=>{
  const source=JSON.stringify(value,null,2)
  const snapshot=JSON.parse(source)
  const dialog=document.createElement('dialog');dialog.className='json-viewer';dialog.id='jsonViewerDialog'
  const heading=document.createElement('div');heading.className='json-viewer-heading'
  const label=document.createElement('h2');label.textContent=title;label.id='jsonViewerTitle';dialog.setAttribute('aria-labelledby',label.id)
  const dismiss=()=>{dialog.close();dialog.remove()}
  const close=document.createElement('button');close.type='button';close.textContent='关闭';close.onclick=dismiss
  heading.append(label,close)
  const help=document.createElement('p');help.className='muted';help.textContent=options.help||'当前流程的本地 DSL，包含尚未保存到平台的步骤配置。只读查看，不修改步骤。'
  const controls=document.createElement('div');controls.className='row'
  const structure=document.createElement('button'),raw=document.createElement('button'),copy=document.createElement('button')
  for(const button of [structure,raw,copy])button.type='button'
  structure.textContent='结构';raw.textContent='源码';copy.textContent='复制 JSON'
  controls.append(structure,raw,copy)
  const tree=document.createElement('div');tree.className='json-viewer-tree';tree.setAttribute('aria-label','JSON结构')
  const code=document.createElement('textarea');code.id='jsonViewerSource';code.className='code';code.readOnly=true;code.spellcheck=false;code.value=source;code.setAttribute('aria-label','DSL JSON源码')
  const branches=new Map()
  const node=(key,item,depth=0,nodePath='$')=>{
    const container=item!==null&&typeof item==='object'
    if(!container){
      const line=document.createElement('div');line.className='json-viewer-value'
      const name=document.createElement('span');name.textContent=JSON.stringify(key)+': '
      const text=document.createElement('span');text.textContent=JSON.stringify(item);text.className='json-value-'+(item===null?'null':typeof item)
      line.append(name,text);return line
    }
    const details=document.createElement('details'),summary=document.createElement('summary'),children=document.createElement('div')
    branches.set(nodePath,details)
    summary.textContent=key+': '+(item.flowName||item.stepName||(Array.isArray(item)?'Array':'Object'))+' ('+Object.keys(item).length+')'
    children.className='json-viewer-children';details.append(summary,children)
    let loaded=false
    const populate=()=>{if(loaded||!details.open)return;loaded=true;for(const [name,child]of Object.entries(item))children.append(node(name,child,depth+1,nodePath+'.'+name))}
    details.reveal=()=>{details.open=true;populate()}
    details.addEventListener('toggle',populate)
    if(depth<3){details.open=true;populate()}
    return details
  }
  tree.append(node('$',snapshot))
  const select=showRaw=>{tree.hidden=showRaw;code.hidden=!showRaw;structure.setAttribute('aria-pressed',String(!showRaw));raw.setAttribute('aria-pressed',String(showRaw))}
  structure.onclick=()=>select(false);raw.onclick=()=>select(true);select(false)
  copy.onclick=()=>window.desktop.invoke('clipboard:write',source).then(()=>{copy.textContent='已复制'},()=>{copy.textContent='复制失败，请在源码中选择复制'})
  dialog.append(heading,help,controls,tree,code)
  if(Array.isArray(snapshot.subflows)&&snapshot.subflows.length){
    const navigation=document.createElement('div');navigation.className='json-viewer-navigation'
    const caption=document.createElement('label');caption.textContent='定位流程：'
    const picker=document.createElement('select');picker.id='jsonViewerFlow';picker.setAttribute('aria-label','定位主流程或子流程')
    const stepCount=steps=>(steps||[]).reduce((sum,step)=>sum+1+stepCount(step.children||step.body),0)
    picker.add(new Option('主流程：'+(snapshot.flowName||snapshot.flowCode)+'（'+stepCount(snapshot.steps)+' 步）','$'))
    snapshot.subflows.forEach((flow,index)=>picker.add(new Option('子流程：'+flow.flowName+'（'+stepCount(flow.steps)+' 步）','$.subflows.'+index)))
    caption.append(picker);navigation.append(caption);controls.before(navigation)
    picker.onchange=()=>{
      select(false)
      const main=picker.value==='$'
      const rootSteps=branches.get('$.steps');if(rootSteps)rootSteps.open=main
      branches.get('$.subflows')?.reveal()
      const target=branches.get(main?'$.steps':picker.value)
      target?.reveal();if(!main)branches.get(picker.value+'.steps')?.reveal()
      target?.scrollIntoView({block:'start'})
    }
  }
  if(options.diagnostics?.length){
    const diagnostics=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('pre')
    summary.textContent='加载提示（'+options.diagnostics.length+'）';text.textContent=JSON.stringify(options.diagnostics,null,2)
    diagnostics.open=true;diagnostics.append(summary,text);help.after(diagnostics)
  }
  dialog.addEventListener('close',()=>dialog.remove(),{once:true})
  dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss()})
  document.body.append(dialog);dialog.showModal()
}
