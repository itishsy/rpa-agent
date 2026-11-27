'use strict'
let executorRefresh = 0, executorPending = null, executorRefreshQueued = false, settingsTab = 'sources'
const executorManagementOperations = new Map()
$('executorManagementContent').append($('executorSettings'))
$('executorSettings').hidden=false
$('executorSettings').querySelector('h2').textContent='连接配置'
async function openExecutorSettings() {
  try {
    if(document.body.dataset.currentView!=='executors')setView('executors')
    await loadSettings()
    $('executorSaveMessage').textContent=''
    if(!$('executorSettingsDialog').open)$('executorSettingsDialog').showModal()
  } catch(error) { notice(error.message,true) }
}
$('closeExecutorSettings').onclick=()=>$('executorSettingsDialog').close()
function mountIsolatedPage(hostId, templateId) {
  const host=$(hostId)
  if(host.shadowRoot?.childElementCount)return host.shadowRoot
  const root=host.shadowRoot||host.attachShadow({mode:'open'});root.append($(templateId).content.cloneNode(true))
  const style=document.createElement('link');style.rel='stylesheet';style.href='apple.css';root.append(style)
  return root
}
function showSettingsTab(tab) {
  if(tab==='executors'){setView('executors');return}
  if(!['sources','model','appearance','cache','engine'].includes(tab))tab='sources'
  settingsTab=tab
  document.querySelectorAll('[data-settings-tab]').forEach(button=>{button.classList.toggle('selected',button.dataset.settingsTab===tab);button.setAttribute('aria-selected',String(button.dataset.settingsTab===tab))})
  $('taskSourceSettings').hidden=tab!=='sources';$('connectionSettings').hidden=tab!=='model'
  $('appearanceSettings').hidden=tab!=='appearance'
  $('cacheSettings').hidden=tab!=='cache'
  $('agentEngineSettings').hidden=tab!=='engine'
  if(tab==='appearance')loadAppearanceControls()
  $('modelSettings').hidden=tab!=='model'
  if(tab==='sources')ensureTaskMonitor()
  if(tab==='cache')loadCacheSettings().catch(error=>{$('cacheMessage').textContent=error.message})
  if(tab==='engine')loadEngineSettings().catch(error=>{$('agentEngineMessage').textContent=error.message})
}
async function loadCacheSettings() {
  const value=await invoke('cache:get')
  $('cacheDirectory').value=value.configuredDirectory
  $('cacheDirectory').placeholder=value.defaultDirectory
  $('currentCacheDirectory').textContent=value.directory
  $('cacheMessage').textContent=value.warning || (value.configuredDirectory!==value.directory?'已保存目录将在下次启动时生效。':'')
}
$('chooseCacheDirectory').onclick=async()=>{
  try { const directory=await invoke('cache:choose');if(directory)$('cacheDirectory').value=directory }
  catch(error) { $('cacheMessage').textContent=error.message }
}
$('defaultCacheDirectory').onclick=()=>{$('cacheDirectory').value=''}
$('saveCacheDirectory').onclick=async()=>{
  $('saveCacheDirectory').disabled=true;$('cacheMessage').textContent='正在检查目录并保存…'
  try {
    const result=await invoke('cache:save',$('cacheDirectory').value)
    $('cacheDirectory').value=result.directory
    $('cacheMessage').textContent=result.restartRequired?'目录已保存，下次启动时迁移现有缓存并生效，原目录保留副本。':'缓存目录已保存。'
  } catch(error) { $('cacheMessage').textContent='保存失败 · '+String(error.message).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'') }
  finally { $('saveCacheDirectory').disabled=false }
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
  const label=document.createElement('h2');label.textContent=local?'本地执行器':'远程执行器'
  const status=document.createElement('span');status.className='executor-health pending';status.textContent=enabled?'检测中':'未启用'
  heading.append(mark,label,status)
  const address=document.createElement('p');address.className='executor-address';address.textContent=baseUrl
  const detail=document.createElement('p');detail.className='executor-detail';detail.textContent=enabled?'正在读取执行器状态…':local?'当前使用远程执行器。':'已保留此连接，当前使用本机执行器。'
  const footer=document.createElement('div');footer.className='executor-card-footer'
  const configure=document.createElement('button');configure.textContent='配置';configure.onclick=openExecutorSettings
  const develop=document.createElement('button');develop.textContent='流程开发 ↗';develop.disabled=!enabled
  develop.onclick=()=>{$('executor').value=baseUrl;setView('applications');if(managed.platformId)loadApplicationTable().catch(error=>notice(error.message,true))}
  footer.append(configure,develop);card.append(heading,address,detail,footer)
  return {card,status,detail,label,footer}
}
async function loadExecutorManagement(entry,ui,isCurrent) {
  const panel=document.createElement('div');panel.className='executor-management'
  const message=document.createElement('p');message.className='muted executor-management-message';message.setAttribute('role','status')
  message.textContent='正在读取远程后台服务…';panel.append(message);ui.card.append(panel)
  try{
    const state=await invoke('executor:management',entry.url)
    if(!isCurrent())return
    const field=document.createElement('label');field.textContent='后台服务'
    const select=document.createElement('select');select.className='executor-platform';select.setAttribute('aria-label','执行器后台服务')
    select.append(new Option('请选择后台服务',''))
    for(const platform of state.platforms||[])select.append(new Option(platform.name+' · '+platform.url,platform.id))
    select.value=state.platformId||'';field.append(select)
    const actions=document.createElement('div');actions.className='executor-management-actions'
    const buttons=[]
    const sync=()=>{
      const pending=executorManagementOperations.get(entry.url)
      select.disabled=!!pending||!!state.busy
      for(const button of buttons){
        const action=button.dataset.executorAction
        const transitioning=['New','Upgrading'].includes(state.status)
        button.disabled=!!pending||!!state.busy||(
          action==='switch'? !select.value||select.value===state.platformId||transitioning||state.status==='Running':
          action==='start'? transitioning||['Runnable','Running'].includes(state.status):state.status==='Closed'
        )
      }
      message.textContent=pending?pending+'，请稍候…':state.busy?'Runtime 正在'+state.busy:''
      message.hidden=!message.textContent
    }
    for(const [action,label] of [['switch','切换服务'],['start','启动'],['stop','停止']]){
      const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.executorAction=action
      button.onclick=async()=>{
        if(executorManagementOperations.has(entry.url))return
        executorManagementOperations.set(entry.url,label==='切换服务'?'正在切换后台服务':'正在'+label+'执行器');sync()
        try{
          const result=await invoke('executor:manage',entry.url,{action,machineCode:state.machineCode,...(action==='switch'?{platformId:select.value}:{})})
          notice(action==='switch'?'后台服务已切换为 '+result.platformName:action==='start'?'执行器已启动':'执行器已停止')
        }catch(error){notice(error.message,true)}
        finally{
          executorManagementOperations.delete(entry.url)
          await refreshExecutorCards().catch(error=>notice(error.message,true))
        }
      }
      buttons.push(button);actions.append(button)
    }
    select.onchange=sync;panel.prepend(field,actions);sync()
  }catch(error){
    if(!isCurrent())return
    message.textContent=String(error.message).includes('HTTP 404')?'当前 Runtime 尚未提供远程管理接口，请升级远程 Runtime。':'远程管理不可用 · '+String(error.message).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'')
  }
}
async function refreshExecutorCards() {
  if(executorPending){executorRefreshQueued=true;return executorPending}
  executorPending=(async()=>{
    const generation=++executorRefresh,identity=window.currentUser?.id;$('refreshExecutors').disabled=true
    try{
      const settings=await invoke('settings:get')
      if(generation!==executorRefresh||window.currentUser?.id!==identity)return
      const connections=settings.connections||[], entries=[{url:'http://localhost:9090',local:true,enabled:!settings.remoteEnabled},
        ...connections.map(item=>({url:item.baseUrl,local:false,enabled:settings.remoteEnabled,serviceName:item.serviceName}))]
      $('executorCards').replaceChildren();$('executorEmpty').hidden=entries.length>0
      let ready=0
      await Promise.all(entries.map(async entry=>{
        const ui=executorCard(entry.url,entry.local,entry.enabled);$('executorCards').append(ui.card)
        const service=document.createElement('p');service.className='executor-service';service.hidden=entry.local
        service.textContent=entry.serviceName?'后台服务（配置名称） · '+entry.serviceName:entry.enabled?'正在读取后台服务名称…':'后台服务名称未读取'
        ui.card.insertBefore(service,ui.detail)
        if(!entry.enabled)return
        const isCurrent=()=>generation===executorRefresh&&window.currentUser?.id===identity
        const readStatus=async()=>{try{
          const result=await invoke('executor:status',entry.url)
          if(!isCurrent())return
          ui.status.textContent=result.text;ui.status.className='executor-health '+([0,1].includes(result.status)?'online':'offline')
          ui.detail.textContent='最近检测 '+new Date().toLocaleTimeString('zh-CN',{hour12:false})
          if([0,1].includes(result.status))ready++
        }catch(error){if(isCurrent()){ui.status.textContent='检测失败';ui.status.className='executor-health offline';ui.detail.textContent=error.message}}
        finally{if(isCurrent()&&typeof renderOverview==='function')renderOverview()}}
        const readService=async()=>{
          if(entry.local)return
          try{
            const result=await invoke('executor:service-name',entry.url)
            if(!isCurrent())return
            ui.label.textContent=result.name&&!result.reason?'远程执行器 · '+result.name:'远程执行器'
            service.hidden=!!result.name&&!result.reason
            service.textContent=result.reason?(result.name?'后台服务（配置名称） · '+result.name+' · ':'后台服务名称未读取 · ')+result.reason:'后台服务 · '+result.name
          }catch(error){if(isCurrent())service.textContent='后台服务名称读取失败 · '+error.message}
          finally{if(isCurrent()&&typeof renderOverview==='function')renderOverview()}
        }
        await Promise.all([readStatus(),readService(),!entry.local&&document.body.dataset.currentView==='executors'?loadExecutorManagement(entry,ui,isCurrent):Promise.resolve()])
      }))
      if(generation!==executorRefresh||window.currentUser?.id!==identity)return
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
