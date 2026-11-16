'use strict'
const {digest} = require('../agent-core/store')
const {executorKey} = require('../agent-core/control')
const {requireRepairHandoff,describeHandoff} = require('./repair-handoff')
const {TAKEOVER_COMMENT,takeoverBlockReason,takeoverSource,readTakeoverAccount,pauseTakeoverAccount,updateTakeoverAccount} = require('../services/undeclared-monitor')
function registerTakeoverHandlers({handle,ensureIdentity,activeUserId,userAuth,getSettings,saveSettings,getSnapshot,userRequest,createBusinessService,takeoverContexts,takeovers,assertIdle,refreshUndeclaredData,adapters,harness,openPage,workspaceOwners,requireSession,BrowserWindow,broadcastAccountStatus,broadcastTakeoverStats}) {
  const accountWindows = new Map()
  function takeoverStats(userId) {
    return {
      userId,
      active:[...accountWindows.values()].filter(entry=>entry.userId===userId&&!entry.win.isDestroyed()).length,
      total:getSettings().accountTakeoverTotals?.[digest(userId)] || 0
    }
  }
  handle('monitor:takeover-stats',()=>takeoverStats(ensureIdentity(activeUserId()).id))
  function publish(row, status) {
    for (const item of getSnapshot()?.rows.values() || []) {
      if (item.analysisSourceKey === row.analysisSourceKey && item.appCode === row.appCode && item.taskCode === row.taskCode) Object.assign(item, status)
    }
    broadcastAccountStatus({ analysisSourceKey: row.analysisSourceKey, appCode: row.appCode, taskCode: row.taskCode, ...status })
  }
  handle('monitor:account-takeover',async input=>{
    const identity=ensureIdentity(activeUserId()),snapshot=getSnapshot(),config=getSettings().monitor
    if(!snapshot||snapshot.identity!==identity||Date.now()-snapshot.at>35*60*1000)throw Error('请刷新任务列表后再接管')
    const row=snapshot.rows.get(String(input?.rowId))
    if(!row)throw Error('任务不在当前监控结果中')
    const blocked=takeoverBlockReason(row.taskStatus)
    if(blocked)throw Error(blocked)
    const source=takeoverSource(config,row)
    const detail=row.taskDetails?.find(item=>item.name===input.serviceName&&Number(item.count)>0)
    if(!detail)throw Error('请选择该申报户的未完成服务项目')
    const accountKey = JSON.stringify([row.analysisSourceKey, row.appCode, row.taskCode])
    const existing = accountWindows.get(accountKey)?.win
    if (existing && !existing.isDestroyed()) {
      existing.show()
      existing.focus()
      return
    }
    assertIdle()
    const operation=Symbol()
    takeovers.add(operation)
    try{
      const service=createBusinessService(request=>userRequest(request,identity))
      let application
      try{application=await service.invoke('application',{appCode:row.appCode})}
      catch(error){if(error.message!=='应用不存在或无权访问')throw error}
      if(application?.appName!==row.appName){
        const matches=[]
        for(let page=1;;page++){
          if(page>100)throw Error('应用匹配结果过多，请从应用列表查找')
          const result=await service.invoke('applications',{page,size:100,keyword:row.appName})
          matches.push(...result.rows.filter(item=>item.appName===row.appName))
          if(!result.hasNext||matches.length>1)break
        }
        if(matches.length!==1)throw Error('无法唯一匹配应用，请检查当前用户的应用权限')
        application=matches[0]
      }
      const flows=(await service.invoke('flows',{appCode:application.appCode})).filter(flow=>Number(flow.flowType)===1 &&
        (detail.serviceItem!=null ? String(flow.serviceItem)===String(detail.serviceItem) : flow.serviceItemName===detail.name))
      if(!flows.length)throw Error('该应用没有对应「'+detail.name+'」的主流程')
      const latest=await readTakeoverAccount(source,row)
      const reason=takeoverBlockReason(latest.taskStatus)
      if(reason)throw Error(reason)
      if(!userAuth.isCurrent(identity)||getSettings().monitor!==config)throw Error('用户或任务数据源已变化，请刷新后重试')
      if (latest.taskStatus === '已停用' && latest.taskComment === TAKEOVER_COMMENT) {
        throw Error('该申报户已有旧接管标记，原状态无法确认。请在平台核对并恢复后重新接管')
      }
      const wasDisabled = latest.taskStatus === '已停用'
      const updated = {taskStatus:'已停用',taskComment:TAKEOVER_COMMENT}
      const restore = async () => {
        takeovers.add(operation)
        try {
          const current = await readTakeoverAccount(source, row)
          if (current.taskStatus === '已停用' && current.taskComment === TAKEOVER_COMMENT) {
            await updateTakeoverAccount(source, row, wasDisabled ? 0 : 1, latest.taskComment)
            publish(row, { ...latest, taskStatus: wasDisabled ? '已停用' : '已启用' })
          } else {
            publish(row, current)
          }
        } finally { takeovers.delete(operation) }
      }
      const flow=flows.find(item=>item.flowCode===row.flowCode)||(flows.length===1?flows[0]:null)
      await pauseTakeoverAccount(source,row)
      try{
        if (!userAuth.isCurrent(identity)) throw Error('登录用户已变化')
        const win = openPage('index.html',{designApp:application.appCode,application,taskName:detail.name,serviceItem:flow?.serviceItem??flows[0].serviceItem,
          initialFlowCode:flow?.flowCode,title:application.appName||application.appCode,
          monitorAccount:{taskCode:row.taskCode,taskName:row.accountNumber||row.taskCode,accountNumber:row.accountNumber},
          accountTakeover:{taskCode:row.taskCode}, beforeClose:restore})
        accountWindows.set(accountKey, {win,userId:identity.id})
        win.once('closed', () => {
          accountWindows.delete(accountKey)
          if(activeUserId()===identity.id)broadcastTakeoverStats(takeoverStats(identity.id))
        })
        const totals=getSettings().accountTakeoverTotals ||= {}
        const userKey=digest(identity.id)
        totals[userKey]=(totals[userKey]||0)+1
        try { saveSettings() }
        catch(error) { console.error('接管统计保存失败',error.message) }
        broadcastTakeoverStats(takeoverStats(identity.id))
        publish(row, updated)
      }catch(error){
        try { await restore() }
        catch (restoreError) { throw Error(error.message + '。恢复申报户失败：' + restoreError.message) }
        throw error
      }
      return updated
    }finally{takeovers.delete(operation)}
  })
  handle('monitor:takeover-options',async rowId=>{
    const settings=getSettings()
    const identity=ensureIdentity(activeUserId()),snapshot=getSnapshot()
    if(!snapshot||snapshot.identity!==identity||Date.now()-snapshot.at>35*60*1000)throw Error('请刷新任务列表后再接管')
    const row=snapshot.rows.get(String(rowId));if(!row)throw Error('任务不在当前监控结果中')
    const blocked=takeoverBlockReason(row.taskStatus);if(blocked)throw Error(blocked)
    const handoff=requireRepairHandoff(row)
    const service=createBusinessService(request=>userRequest(request,identity))
    let application
    if(row.appCode)application=await service.invoke('application',{appCode:row.appCode})
    else{
      const matches=[];for(let page=1;page<=100;page++){const result=await service.invoke('applications',{page,size:100,keyword:row.appName});matches.push(...result.rows.filter(item=>item.appName===row.appName));if(!result.hasNext)break}
      if(matches.length!==1)throw Error('无法唯一匹配应用，请检查当前用户的应用权限');application=matches[0]
    }
    const flows=(await service.invoke('flows',{appCode:application.appCode})).filter(flow=>Number(flow.flowType)===1)
    if(!flows.length)throw Error('该应用没有可接管的主流程')
    const executors=settings.remoteEnabled?settings.connections.map(item=>item.baseUrl):[]
    if(!executors.length)throw Error('请先在执行器管理中配置远程执行器及调试令牌')
    const reused=[...takeoverContexts.values()].find(ctx=>ctx.identity===identity&&ctx.row.id===row.id&&ctx.window&&!ctx.window.isDestroyed())
    const id=reused?.id||require('node:crypto').randomUUID()
    if(takeoverContexts.size>100)for(const [key,ctx] of takeoverContexts)if(!ctx.pending&&(!ctx.window||ctx.window.isDestroyed())&&Date.now()-ctx.at>10*60*1000)takeoverContexts.delete(key)
    if(!reused)takeoverContexts.set(id,{id,identity,row,application,flows,at:Date.now(),config:digest(settings.monitor),handoff})
    const matching=flows.filter(flow=>row.taskDetails?.length===1&&(row.taskDetails[0].serviceItem!=null&&String(flow.serviceItem)===String(row.taskDetails[0].serviceItem)||flow.serviceItemName&&flow.serviceItemName===row.taskDetails[0].name))
    return {id,appName:application.appName,accountNumber:row.accountNumber,machineCode:row.machineCode,flows:flows.filter(flow=>!reused||flow.flowCode===reused.window.designTakeover.flowCode).map(flow=>({flowCode:flow.flowCode,flowName:flow.flowName,serviceItemName:flow.serviceItemName||''})),executors:reused?[reused.window.designExecutor]:executors,flowCode:reused?.window.designTakeover.flowCode||row.flowCode||(matching.length===1?matching[0].flowCode:'')}
  })
  handle('monitor:takeover',async input=>{
    const settings=getSettings()
    const identity=ensureIdentity(activeUserId()),ctx=takeoverContexts.get(input?.id)
    if(!ctx||ctx.identity!==identity||Date.now()-ctx.at>10*60*1000)throw Error('接管选项已过期，请重新打开')
    const currentRow=getSnapshot()?.rows.get(ctx.row.id)
    if(!currentRow||requireRepairHandoff(currentRow).sourceOpsSessionId!==ctx.handoff.sourceOpsSessionId)throw Error('诊断已更新，请重新打开接管')
    if(ctx.pending)return ctx.pending
    if(ctx.window&&!ctx.window.isDestroyed()){ctx.window.show();ctx.window.focus();return {opened:true}}
    assertIdle()
    if(!settings.modelBaseUrl||!settings.modelName)throw Error('请先配置 AI 模型，再启动 Agent 接管')
    const selected=settings.connections.find(item=>item.baseUrl===input.executor),flow=ctx.flows.find(item=>item.flowCode===input.flowCode)
    if(!settings.remoteEnabled||!selected||!flow)throw Error('请选择当前应用流程及已配置的远程执行器')
    if(!ctx.row.machineCode&&input.confirmExecutor!==true)throw Error('任务未提供设备编号，请先确认对应执行器')
    if(ctx.config!==digest(settings.monitor))throw Error('任务数据源已变化，请刷新任务后重试')
    const runtimeControl=require('../services/runtime-control'),requestId=ctx.requestId||(ctx.requestId=require('node:crypto').randomUUID())
    const chosen=JSON.stringify([selected.baseUrl,flow.flowCode]);if(ctx.chosen&&ctx.chosen!==chosen)throw Error('接管已提交，请保持原流程和执行器，或重新打开接管操作');ctx.chosen=chosen
    takeovers.add(ctx.id)
    ctx.pending=(async()=>{
      let release
      try{
        const fresh=await refreshUndeclaredData(settings.monitor),row=fresh.rows.find(item=>item.id===ctx.row.id)
        if(!row||['appName','accountNumber','taskCode','machineCode','baseServer'].some(key=>(row[key]||'')!==(ctx.row[key]||'')))throw Error('任务已完成或分配信息发生变化，请刷新列表')
        const blocked=takeoverBlockReason(row.taskStatus);if(blocked)throw Error(blocked)
        const stub={scope:{platformId:identity.id,platformUrl:identity.url,username:identity.username,appCode:ctx.application.appCode,flowCode:flow.flowCode,executor:selected.baseUrl}}
        if(!(await adapters.flows(stub)).some(item=>item.flowCode===flow.flowCode&&Number(item.flowType)===1))throw Error('对应流程已变化，请刷新后重试')
        const status=await runtimeControl.request(selected,'/api/agent/status')
        const address=new URL(selected.baseUrl),proxied=address.pathname!=='/'
        if(!status.machineCode)throw Error('Runtime 未返回设备编号')
        if(proxied){
          if(row.machineCode&&String(status.machineCode)!==String(row.machineCode))throw Error('Runtime 设备编号与任务不匹配')
        }else if(String(status.executorPort)!==(address.port||(address.protocol==='https:'?'443':'80'))){
          throw Error('Runtime 与所选执行器端口不匹配')
        }
        let task
        try{task=runtimeControl.matchTask(await adapters.tasks(stub),row)}catch(error){if((!proxied||row.machineCode)&&row.taskCode&&['Closed','RobotError'].includes(status.status))task={taskCode:row.taskCode};else throw error}
        ensureIdentity(identity.id);if(!userAuth.isCurrent(identity))throw Error('登录用户已变化')
        const key=executorKey(selected.baseUrl),quarantine=harness.leases.quarantines.get(key)
        if(status.mode==='debug'&&status.takeover?.requestId===requestId&&status.takeover?.state==='completed'&&status.takeover?.taskCode===task.taskCode&&status.takeover?.flowCode===flow.flowCode&&status.takeover?.appCode===ctx.application.appCode&&quarantine?.has(ctx.id)){quarantine.delete(ctx.id);if(!quarantine.size)harness.leases.quarantines.delete(key)}
        release=harness.leases.acquire(selected.baseUrl,ctx.id)
        let result
        try{result=await runtimeControl.request(selected,'/api/agent/takeover',{requestId,machineCode:status.machineCode,appCode:ctx.application.appCode,taskCode:task.taskCode,flowCode:flow.flowCode})}
        catch(error){if(!error.runtimeData||error.runtimeData.takeover?.requestId===requestId){harness.leases.quarantine(selected.baseUrl,ctx.id)}throw error}
        if(result.mode!=='debug'||result.machineCode!==status.machineCode||result.takeover?.requestId!==requestId||result.takeover?.state!=='completed'||result.takeover?.taskCode!==task.taskCode||result.takeover?.flowCode!==flow.flowCode||result.takeover?.appCode!==ctx.application.appCode){harness.leases.quarantine(selected.baseUrl,ctx.id);throw Error('Runtime 未确认本次调试接管成功，请核对远程状态')}
        if(runtimeControl.matchTask(await adapters.tasks(stub),row).taskCode!==task.taskCode)throw Error('接管后申报账户发生变化，未打开诊断，请在 Runtime 核对')
        if(!userAuth.isCurrent(identity))throw Error('登录用户已变化，远程已进入调试模式，请在 Runtime 核对')
        const takeover={requestId,flowCode:flow.flowCode,taskCode:task.taskCode,machineCode:status.machineCode,accountNumber:row.accountNumber,appName:row.appName,handoff:ctx.handoff}
        ctx.window=openPage('index.html',{designApp:ctx.application.appCode,application:ctx.application,executor:selected.baseUrl,takeover,title:ctx.application.appName})
        return {opened:true}
      }finally{release?.();takeovers.delete(ctx.id);ctx.pending=null}
    })()
    return ctx.pending
  })
  handle('takeover:diagnose',async (id,event)=>{
    const win=BrowserWindow.fromWebContents(event.sender),context=win.designTakeover,current=requireSession(id)
    if(!context||workspaceOwners.get(id)!==event.sender.id||current.scope.flowCode!==context.flowCode||current.taskCode!==context.taskCode||current.scope.executor!==win.designExecutor)throw Error('接管会话与执行器、流程或申报账户不匹配')
    if(context.started)return {started:true};context.started=true;context.sessionId=id
    const request='接管任务并进行 Agent 开发与诊断。应用：'+context.appName+'；流程：'+current.dsl.flowName+'；申报账户：'+context.accountNumber+'；设备：'+context.machineCode+'。先读取流程与执行现场，定位问题，再生成候选补丁及验证说明，供用户确认。不得直接应用补丁或保存服务器配置；没有足够证据时说明缺口，不编造修复。'+describeHandoff(context.handoff)
    return harness.start(current,request,{mode:'develop',executionConsent:true})
  })
}
module.exports={registerTakeoverHandlers}
