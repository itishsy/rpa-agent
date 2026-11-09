'use strict'
let executorRefresh = 0, executorPending = null, executorRefreshQueued = false, settingsTab = 'sources'
$('executorManagementContent').append($('executorSettings'))
$('executorSettings').hidden=false
$('executorSettings').querySelector('h2').textContent='连接配置'
function mountIsolatedPage(hostId, templateId) {
  const host=$(hostId)
  if(host.shadowRoot?.childElementCount)return host.shadowRoot
  const root=host.shadowRoot||host.attachShadow({mode:'open'});root.append($(templateId).content.cloneNode(true))
  const style=document.createElement('link');style.rel='stylesheet';style.href='apple.css';root.append(style)
  return root
}
function showSettingsTab(tab) {
  if(tab==='executors'){setView('executors');return}
  if(!['sources','model','appearance'].includes(tab))tab='sources'
  settingsTab=tab
  document.querySelectorAll('[data-settings-tab]').forEach(button=>{button.classList.toggle('selected',button.dataset.settingsTab===tab);button.setAttribute('aria-selected',String(button.dataset.settingsTab===tab))})
  $('taskSourceSettings').hidden=tab!=='sources';$('connectionSettings').hidden=tab!=='model'
  $('appearanceSettings').hidden=tab!=='appearance'
  if(tab==='appearance')loadAppearanceControls()
  $('modelSettings').hidden=tab!=='model'
  if(tab==='sources')ensureTaskMonitor()
}
function ensureTaskMonitor(){
  if(window.taskMonitor?.elements)return window.taskMonitor
  window.taskMonitor=createTaskMonitor(mountIsolatedPage('monitorHost','monitorTemplate'))
  const host=$('taskSourceSettingsHost'),root=host.shadowRoot||host.attachShadow({mode:'open'})
  root.replaceChildren()
  for(const href of ['monitor.css','apple.css']){const style=document.createElement('link');style.rel='stylesheet';style.href=href;root.append(style)}
  const heading=document.createElement('h2');heading.textContent='任务监控设置';root.append(heading)
  const form=window.taskMonitor.elements.settingsForm;form.classList.add('open','task-source-form');root.append(form)
  return window.taskMonitor
}
document.addEventListener('open-task-data-sources',()=>{settingsTab='sources';setView('settings')})
desktop.on('app:task-sources',()=>{settingsTab='sources';setView('settings')})
function loadAppearanceControls() {
  const value=window.appearanceState
  if(!value)return
  for(const key of ['mode','accent','density'])$('appearance'+key[0].toUpperCase()+key.slice(1)).value=value[key]
}
$('saveAppearance').onclick=async()=>{
  $('saveAppearance').disabled=true;$('appearanceMessage').textContent='正在保存…'
  try{
    const value=await invoke('appearance:save',{mode:$('appearanceMode').value,accent:$('appearanceAccent').value,density:$('appearanceDensity').value})
    applyAppearance(value);$('appearanceMessage').textContent='外观已保存，所有窗口已同步更新。'
  }catch(error){$('appearanceMessage').textContent=error.message}
  finally{$('saveAppearance').disabled=false}
}
document.addEventListener('appearance-applied',()=>{if(settingsTab==='appearance'&&$('appearanceSettings').hidden===false)loadAppearanceControls()})
function showShellView(view) {
  if(view==='applications'&&window.platformConnected&&managed.platformId)loadApplicationTable().catch(error=>notice(error.message,true))
  if(view==='home'&&window.platformConnected&&typeof refreshOverview==='function')refreshOverview().catch(error=>notice(error.message,true))
  if(view==='settings')showSettingsTab(settingsTab)
  if(view==='executors')refreshExecutorCards().catch(error=>notice(error.message,true))
  if(view==='taskMonitor'){const existing=!!window.taskMonitor?.elements;const monitor=ensureTaskMonitor();if(existing)monitor.refreshData()}
}
function executorCard(baseUrl, local, enabled) {
  const card=document.createElement('article');card.className='executor-card'
  const heading=document.createElement('div');heading.className='executor-card-heading'
  const mark=document.createElement('span');mark.className='executor-symbol';mark.textContent=local?'▣':'◇'
  const label=document.createElement('h2');label.textContent=local?'本机执行器':'远程执行器'
  const status=document.createElement('span');status.className='executor-health pending';status.textContent=enabled?'检测中':'未启用'
  heading.append(mark,label,status)
  const address=document.createElement('p');address.className='executor-address';address.textContent=baseUrl
  const detail=document.createElement('p');detail.className='executor-detail';detail.textContent=enabled?'正在读取执行器状态…':'已保留此连接，当前使用本机执行器。'
  const footer=document.createElement('div');footer.className='executor-card-footer'
  const configure=document.createElement('button');configure.textContent='配置';configure.onclick=()=>setView('executors')
  const develop=document.createElement('button');develop.textContent='流程开发 ↗';develop.disabled=!enabled
  develop.onclick=()=>{$('executor').value=baseUrl;setView('applications');if(managed.platformId)loadApplicationTable().catch(error=>notice(error.message,true))}
  footer.append(configure,develop);card.append(heading,address,detail,footer)
  return {card,status,detail}
}
async function refreshExecutorCards() {
  if(executorPending){executorRefreshQueued=true;return executorPending}
  executorPending=(async()=>{
    const generation=++executorRefresh,identity=window.currentUser?.id;$('refreshExecutors').disabled=true
    try{
      const [settings,bootstrapData]=await Promise.all([invoke('settings:get'),invoke('app:bootstrap')])
      if(generation!==executorRefresh||window.currentUser?.id!==identity)return
      const connections=settings.connections||[], entries=settings.remoteEnabled?connections.map(item=>({url:item.baseUrl,local:false,enabled:true})):
        [{url:bootstrapData.executors[0]||'http://localhost:9090',local:true,enabled:true},...connections.map(item=>({url:item.baseUrl,local:false,enabled:false}))]
      $('executorCards').replaceChildren();$('executorEmpty').hidden=entries.length>0
      let ready=0
      await Promise.all(entries.map(async entry=>{
        const ui=executorCard(entry.url,entry.local,entry.enabled);$('executorCards').append(ui.card)
        if(!entry.enabled)return
        try{
          const result=await invoke('executor:status',entry.url)
          if(generation!==executorRefresh)return
          ui.status.textContent=result.text;ui.status.className='executor-health '+([0,1].includes(result.status)?'online':'offline')
          ui.detail.textContent='最近检测 '+new Date().toLocaleTimeString('zh-CN',{hour12:false})
          if([0,1].includes(result.status))ready++
        }catch(error){ui.status.textContent='检测失败';ui.status.className='executor-health offline';ui.detail.textContent=error.message}
      }))
      $('executorSummary').textContent=entries.length+' 个连接 · '+ready+' 个就绪或运行中'
      if(typeof renderOverview==='function')renderOverview()
    }finally{
      $('refreshExecutors').disabled=false;executorPending=null
      if(executorRefreshQueued){executorRefreshQueued=false;setTimeout(()=>{if(['home','executors'].includes(document.body.dataset.currentView))refreshExecutorCards().catch(error=>notice(error.message,true))},0)}
    }
  })()
  return executorPending
}
$('refreshExecutors').onclick=()=>refreshExecutorCards().catch(error=>notice(error.message,true))
document.querySelectorAll('[data-settings-tab]').forEach(button=>{button.onclick=()=>showSettingsTab(button.dataset.settingsTab)})
document.querySelectorAll('[data-open-settings]').forEach(button=>{button.onclick=()=>{
  if(button.dataset.openSettings==='executors')setView('executors')
  else{settingsTab=button.dataset.openSettings;setView('settings')}
}})
document.querySelector('[data-workbench-view="workspace"]').onclick=()=>setView('workspace')
document.querySelectorAll('[data-business-view]').forEach(button=>{button.onclick=()=>setView(button.dataset.businessView)})
desktop.on('app:view',view=>{if(['home','taskMonitor','settings','applications','executors'].includes(view))setView(view)})
// Home is the initial surface; runtime state is read only and never starts/stops a robot.
setView(document.documentElement.dataset.windowMode==='design'?'flowManagement':'home')
