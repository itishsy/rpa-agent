'use strict'
const {clone,redact} = require('../agent-core/store')
const {checkpoint} = require('../agent-core/control')
const {analysisSourceKey} = require('../services/undeclared-monitor')
const {isStoppedTask} = require('../agents/operations/direct-diagnosis')
function registerOperationsHandlers({handle,ensureIdentity,activeUserId,userAuth,getSettings,getSnapshot,monitorAnalysisRuns,createStore}) {
  handle('monitor:analyze', async (input, event) => {
    const settings=getSettings()
    const identity = ensureIdentity(activeUserId())
    const snapshot = getSnapshot(), row = snapshot?.rows?.get(input?.id)
    if (!row || !userAuth.isCurrent(snapshot.identity) || input.snapshotAt !== snapshot.at) throw new Error('任务列表已变化，请先刷新再分析')
    if(row.analysisResult&&input.force!==true&&(!isStoppedTask(row)||row.analysisResult.analysis?.ruleCode==='TASK_DISABLED'))return clone(row.analysisResult)
    const sources = row.isPayFeeTask ? settings.monitor.paymentServers || [] : settings.monitor.servers || []
    const server = sources.find(item => item.baseServer === row.baseServer && analysisSourceKey(item)===row.analysisSourceKey)
    const runKey=identity.id+':'+row.id
    if(monitorAnalysisRuns.has(runKey))throw new Error('该任务正在分析，请等待结论')
    const controller = new AbortController(), destroyed = () => controller.abort()
    event.sender.once('destroyed',destroyed)
    monitorAnalysisRuns.set(runKey,{controller,sender:event.sender.id})
    const modelSettings={...settings}
    let analysis
    try {
      const reason = await require('../agents/operations/agent').analyzeTask(row, server, modelSettings, {
        signal:controller.signal, platformId:identity.id,snapshotAt:snapshot.at,
        store:createStore(),
        onResult:result=>{analysis=result},
        onProgress: progress => {
          if(!userAuth.isCurrent(identity))throw new Error('用户已退出')
          if(!event.sender.isDestroyed())event.sender.send('monitor:analysis-progress',{id:row.id,requestId:input.requestId,...progress})
        }
      })
      if (!userAuth.isCurrent(identity)) throw new Error('用户已退出')
      checkpoint(controller.signal)
      if(getSnapshot()!==snapshot)throw new Error('任务列表已更新，旧分析结果未回填')
      const result = {id:row.id,reason,analyzedAt:new Date().toISOString(),modelName:analysis?.method==='rule'?'':modelSettings.modelName,analysis}
      Object.assign(row,{incompleteReason:reason,analyzedAt:result.analyzedAt,analysisModel:result.modelName,analysisCategory:analysis?.category||'证据不足',analysisAttempted:true,analysisResult:clone(result)})
      return result
    } catch(error){
      if(!controller.signal.aborted&&userAuth.isCurrent(identity)&&getSnapshot()===snapshot){
        const reason='分析失败：'+redact(String(error.message)),analyzedAt=new Date().toISOString()
        const analysis={state:'failed',category:'证据不足',flowConfigurationIssue:false}
        Object.assign(row,{incompleteReason:reason,analyzedAt,analysisAttempted:true,analysisCategory:'证据不足',analysisResult:{id:row.id,reason,analyzedAt,analysis}})
      }
      throw error
    } finally {event.sender.removeListener('destroyed',destroyed);monitorAnalysisRuns.delete(runKey)}
  })
  handle('monitor:analysis-stop',event=>{
    ensureIdentity(activeUserId())
    for(const run of monitorAnalysisRuns.values())if(run.sender===event.sender.id)run.controller.abort()
    return true
  })
}
module.exports={registerOperationsHandlers}
