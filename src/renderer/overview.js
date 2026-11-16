'use strict'
let overviewAppData={user:null,count:null,error:false},overviewAppPending=null
let overviewTakeoverStats=null,overviewTakeoverRevision=0
desktop.on('monitor:takeover-stats',stats=>{
  if(stats.userId!==window.currentUser?.id)return
  overviewTakeoverRevision++
  overviewTakeoverStats=stats
  renderOverview()
})
async function refreshOverviewTakeovers(){
  const revision=++overviewTakeoverRevision
  const stats=await invoke('monitor:takeover-stats')
  if(revision===overviewTakeoverRevision&&stats.userId===window.currentUser?.id)overviewTakeoverStats=stats
}
async function refreshOverviewApplications(force) {
  const user=window.currentUser?.id
  if(!user||!managed.platformId)return
  if(overviewAppPending?.user===user)return overviewAppPending.promise
  if(!force&&overviewAppData.user===user&&!overviewAppData.error)return
  overviewAppData={user,count:null,error:false}
  const promise=(async()=>{
    try{const result=await business('applications',{page:1,size:1,keyword:''});if(window.currentUser?.id===user)overviewAppData={user,count:result.total,error:false}}
    catch(_){if(window.currentUser?.id===user)overviewAppData={user,count:null,error:true}}
    finally{if(overviewAppPending?.promise===promise)overviewAppPending=null;renderOverview()}
  })()
  overviewAppPending={user,promise};return promise
}
function renderOverview() {
  if (!window.currentUser) {
    for (const id of ['overviewApps','overviewTasks','overviewIncomplete','overviewTakeovers']) $(id).textContent='—'
    overviewTakeoverStats=null;overviewTakeoverRevision++
    $('overviewExecutorList').replaceChildren();return
  }
  const appData=overviewAppData.user===window.currentUser.id?overviewAppData:null
  const monitor=window.taskMonitor, available=!!monitor?.lastUpdatedAt
  const names=monitor?.monitoredApplications||[]
  const count=Number.isFinite(appData?.count)?appData.count.toLocaleString('zh-CN'):'—'
  $('overviewApps').textContent=new Set(names).size.toLocaleString('zh-CN')+'/'+count
  $('overviewApps').nextElementSibling.textContent=appData?.error?'读取失败，点击刷新概览重试':'已配置监控应用 / 可访问应用'
  $('overviewTasks').textContent=available?monitor.allRows.length.toLocaleString('zh-CN'):'—'
  const stats=overviewTakeoverStats?.userId===window.currentUser.id?overviewTakeoverStats:null
  $('overviewTakeovers').textContent=stats?stats.active.toLocaleString('zh-CN')+'/'+stats.total.toLocaleString('zh-CN'):'—'
  $('overviewIncomplete').textContent=available?monitor.allRows.reduce((sum,row)=>sum+(Number(row.noDeclaredCount)||0),0).toLocaleString('zh-CN'):'—'
  $('overviewTaskTime').textContent=available?(monitor.lastRefreshFailed?'刷新失败 · 保留上次数据':'更新于 '+new Date(monitor.lastUpdatedAt).toLocaleTimeString('zh-CN',{hour12:false})):'尚无任务数据'
  $('overviewMonitorStatus').textContent=monitor?.lastRefreshFailed?'任务数据刷新失败，请检查任务监控设置后重试。':monitor?.elements?.refreshStatus.textContent||'请配置任务数据源后读取任务。'
  const cards=[...$('executorCards').children],list=$('overviewExecutorList');list.replaceChildren()
  if(!cards.length){list.textContent='暂无连接，请前往执行器管理配置。';return}
  for(const card of cards){
    const row=document.createElement('div');row.className='overview-executor'
    const label=document.createElement('div'),name=document.createElement('strong'),address=document.createElement('small')
    name.textContent=card.querySelector('h2').textContent;address.textContent=card.querySelector('.executor-address').textContent
    label.append(name,address);row.append(label,card.querySelector('.executor-health').cloneNode(true));list.append(row)
  }
}
async function refreshOverview(force=false) {
  if(!window.currentUser||document.documentElement.dataset.windowMode==='design')return
  const existed=!!window.taskMonitor?.elements,monitor=ensureTaskMonitor()
  renderOverview();$('refreshOverview').disabled=true
  try{await Promise.all([refreshOverviewApplications(force),refreshOverviewTakeovers(),refreshExecutorCards(),force&&existed?monitor.refreshData():Promise.resolve()])}
  finally{renderOverview();$('refreshOverview').disabled=false}
}
$('refreshOverview').onclick=()=>refreshOverview(true).catch(error=>notice(error.message,true))
document.querySelectorAll('[data-overview-view]').forEach(button=>button.onclick=()=>setView(button.dataset.overviewView))
document.querySelectorAll('[data-overview-sources]').forEach(button=>button.onclick=()=>{settingsTab='sources';setView('settings')})
