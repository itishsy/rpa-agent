'use strict'
let overviewAppData={user:null,count:null,error:false},overviewAppPending=null
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
    for (const id of ['overviewApps','overviewTasks','overviewIncomplete','overviewMonitoredApps']) $(id).textContent='—'
    $('overviewExecutorList').replaceChildren();return
  }
  const appData=overviewAppData.user===window.currentUser.id?overviewAppData:null
  $('overviewApps').textContent=Number.isFinite(appData?.count)?appData.count.toLocaleString('zh-CN'):'—'
  $('overviewApps').nextElementSibling.textContent=appData?.error?'读取失败，点击刷新概览重试':'当前登录用户可访问'
  const monitor=window.taskMonitor, available=!!monitor?.lastUpdatedAt
  const names=monitor?.monitoredApplications||[]
  $('overviewTasks').textContent=available?monitor.allRows.length.toLocaleString('zh-CN'):'—'
  $('overviewMonitoredApps').textContent=new Set(names).size.toLocaleString('zh-CN')
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
  try{await Promise.all([refreshOverviewApplications(force),refreshExecutorCards(),force&&existed?monitor.refreshData():Promise.resolve()])}
  finally{renderOverview();$('refreshOverview').disabled=false}
}
$('refreshOverview').onclick=()=>refreshOverview(true).catch(error=>notice(error.message,true))
document.querySelectorAll('[data-overview-view]').forEach(button=>button.onclick=()=>setView(button.dataset.overviewView))
document.querySelectorAll('[data-overview-sources]').forEach(button=>button.onclick=()=>{settingsTab='sources';setView('settings')})
