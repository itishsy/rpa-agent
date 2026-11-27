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
function renderOverviewCustomers(monitor) {
  const host=$('overviewCustomerData');host.replaceChildren()
  if(!monitor?.lastUpdatedAt){host.textContent='尚无任务数据，请配置任务数据源后刷新。';return}
  if(!monitor.allRows.length){host.textContent='暂无待办客户任务。';return}
  const customers=new Map()
  for(const row of monitor.allRows){
    const name=String(row.customerName||'').trim()||(row.customerId?'客户 '+row.customerId:'未知客户')
    const customer=customers.get(name)||{name,tasks:0,data:0}
    customer.tasks++;customer.data+=Number(row.noDeclaredCount)||0
    customers.set(name,customer)
  }
  const table=document.createElement('table');table.className='overview-customer-table'
  const head=table.createTHead().insertRow()
  for(const title of ['客户','任务数','数据量']){const cell=document.createElement('th');cell.scope='col';cell.textContent=title;head.append(cell)}
  const body=table.createTBody()
  for(const customer of [...customers.values()].sort((a,b)=>b.data-a.data||b.tasks-a.tasks||a.name.localeCompare(b.name,'zh-CN'))){
    const row=body.insertRow()
    const name=row.insertCell();name.textContent=customer.name;name.title=customer.name
    row.insertCell().textContent=customer.tasks.toLocaleString('zh-CN')
    row.insertCell().textContent=customer.data.toLocaleString('zh-CN')
  }
  host.append(table)
}
function renderOverview() {
  if (!window.currentUser) {
    for (const id of ['overviewApps','overviewTasks','overviewTodayTakeovers','overviewTakeovers']) $(id).textContent='—'
    overviewTakeoverStats=null;overviewTakeoverRevision++
    $('overviewExecutorList').replaceChildren();$('overviewCustomerData').replaceChildren()
    $('overviewMonitorStatus').textContent='等待任务数据';return
  }
  const appData=overviewAppData.user===window.currentUser.id?overviewAppData:null
  const monitor=window.taskMonitor, available=!!monitor?.lastUpdatedAt
  const names=monitor?.monitoredApplications||[]
  const count=Number.isFinite(appData?.count)?appData.count.toLocaleString('zh-CN'):'—'
  $('overviewApps').textContent=new Set(names).size.toLocaleString('zh-CN')+'/'+count
  $('overviewApps').nextElementSibling.textContent=appData?.error?'读取失败，点击刷新概览重试':'已配置监控应用 / 可访问应用'
  $('overviewTasks').textContent=available?monitor.allRows.length.toLocaleString('zh-CN')+'/'+monitor.allRows.reduce((sum,row)=>sum+(Number(row.noDeclaredCount)||0),0).toLocaleString('zh-CN'):'—'
  const stats=overviewTakeoverStats?.userId===window.currentUser.id?overviewTakeoverStats:null
  $('overviewTodayTakeovers').textContent=stats?stats.today.toLocaleString('zh-CN'):'—'
  $('overviewTakeovers').textContent=stats?stats.total.toLocaleString('zh-CN'):'—'
  $('overviewTaskTime').textContent=available?(monitor.lastRefreshFailed?'刷新失败 · 保留上次数据':'更新于 '+new Date(monitor.lastUpdatedAt).toLocaleTimeString('zh-CN',{hour12:false})):'尚无任务数据'
  $('overviewMonitorStatus').textContent=monitor?.lastRefreshFailed?'任务数据刷新失败，请检查任务监控设置后重试。':monitor?.elements?.refreshStatus.textContent||'请配置任务数据源后读取任务。'
  renderOverviewCustomers(monitor)
  const cards=[...$('executorCards').children],list=$('overviewExecutorList');list.replaceChildren()
  if(!cards.length){list.textContent='暂无连接，请前往执行器管理配置。';return}
  for(const card of cards){
    const row=document.createElement('div');row.className='overview-executor'
    const label=document.createElement('div'),name=document.createElement('strong'),address=document.createElement('small')
    name.textContent=card.querySelector('h2').textContent;address.textContent=card.querySelector('.executor-address').textContent
    label.append(name,address)
    const service=card.querySelector('.executor-service')
    if(service&&!service.hidden){const detail=document.createElement('small');detail.textContent=service.textContent;label.append(detail)}
    row.append(label,card.querySelector('.executor-health').cloneNode(true));list.append(row)
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
