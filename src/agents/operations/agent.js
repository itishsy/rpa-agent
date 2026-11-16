'use strict'
const { authenticatedRequest } = require('../../services/undeclared-monitor')
const { completeChat } = require('../../agent-core/model-client')
const { AgentRunner } = require('../../agent-core/runner')
const { operationsProfile } = require('./policy')
const { createOperationsSession } = require('./session')
const { createOperationsTools } = require('./tools')
const { classifyDiagnosis } = require('./diagnosis-schema')
const { createRepairHandoff } = require('../../handoff/repair-handoff')
const { redact } = require('../../agent-core/store')
const { checkpoint, abortable } = require('../../agent-core/control')

const {localTime,bounded,sanitize,resolveTask,matchingExecution} = require('./task-scope')
const { INSTRUCTIONS } = require('./instructions')
const {isStoppedTask,stoppedTaskDiagnosis} = require('./direct-diagnosis')

async function analyzeTask(input, server, settings, dependencies = {}) {
  checkpoint(dependencies.signal)
  if (!input.accountNumber || !input.appName && (!input.appCode || !input.taskCode)) throw new Error('任务缺少应用、任务编号或申报账户，无法限定分析范围')
  if(isStoppedTask(input)){
    const result=stoppedTaskDiagnosis(input,{now:dependencies.now, snapshotAt:dependencies.snapshotAt,platformId:dependencies.platformId})
    dependencies.store?.save(result.session)
    checkpoint(dependencies.signal)
    dependencies.onResult?.(result.analysis)
    dependencies.onProgress?.({stage:'complete',message:'该户已停用，已直接生成分析结果',sessionId:result.session.id})
    return result.reason
  }
  if (!server) throw new Error('找不到该任务的数据源登录配置')
  if (!dependencies.complete && (!settings.modelBaseUrl || !settings.modelName)) throw new Error('请先在系统设置中配置大模型地址和模型名称')
  const request = dependencies.request || authenticatedRequest, complete = dependencies.complete || completeChat
  const progress = dependencies.onProgress || (() => {}), signal = dependencies.signal
  checkpoint(signal)
  const readRaw = (path, body = {}, requestSignal = signal) => abortable(request(server, path, body, { signal: requestSignal, maxBytes: 8 * 1024 * 1024 }),requestSignal)
  const row = await resolveTask(input, readRaw)
  checkpoint(signal)
  const end = dependencies.now || new Date(), start = new Date(end.getTime() - 86400000)
  const state = { images:new Map(), visionUnavailable:false }
  const images = state.images
  let initial = true
  const store = dependencies.store || {save(){}}
  const session = createOperationsSession(row, dependencies.platformId, start, end)
  const registry = createOperationsTools({row,server,dependencies,session,readRaw,start,end,state})
  const safeComplete = async (input, turnSignal) => {
    if (initial && !input.finalOnly) {
      initial = false
      return {completionStatus:'complete',finishReason:'tool_calls',message:{role:'assistant',content:'先读取近24小时执行、本任务队列及服务计划。',tool_calls:['recent_executions','queue_status','service_flows'].map((name,index)=>({id:'initial-'+index,type:'function',function:{name,arguments:JSON.stringify({_purpose:['定位近24小时最早失败步骤和执行状态','核对任务是否排队或被调度阻塞','核对服务启停、执行计划及未完成数据'][index]})}}))}}
    }
    const messages = [{role:'system',content:INSTRUCTIONS},...input.messages.filter(message=>message.role!=='system')]
    if (images.size && !state.visionUnavailable) messages.push({role:'user',content:[{type:'text',text:'以下截图仅为本任务工具读取的现场证据：'},...[...images].flatMap(([id,data])=>[{type:'text',text:'截图文件编号 '+id},{type:'image_url',image_url:{url:data}}])]})
    if (state.visionUnavailable) messages.push({role:'user',content:'图像输入不受当前模型支持，截图未识别；请只依据文字证据，明确缺口。'})
    try { return await complete(settings,settings.modelApiKey,{...input,messages},undefined,turnSignal) }
    catch(error) {
      checkpoint(turnSignal)
      if (!images.size || state.visionUnavailable || !/400|422|image|vision|图像|不支持/i.test(error.message)) throw error
      state.visionUnavailable=true; progress({stage:'tool',message:'当前模型未接受图像输入，改用文字证据并标注截图缺口'})
      return safeComplete(input,turnSignal)
    }
  }
  const harness = new AgentRunner({profile:operationsProfile,store,registry,complete:safeComplete,budgets:{modelCalls:8,toolCalls:16,executions:0,durationMs:5*60*1000,contextChars:60000,parallelReads:1},emit:event=>{
    if (event.type==='item/started') progress({stage:'tool',tool:event.data.tool,message:event.data.purpose==='执行请求的工具操作'?(registry.get(event.data.tool)?.description||'工具不可用'):event.data.purpose,sessionId:session.id})
    else if (event.type==='model/started') progress({stage:'model',message:initial?'准备读取本任务近24小时执行及队列':'大模型正在分析本任务证据',sessionId:session.id})
  }})
  progress({stage:'start',message:'任务分析Agent已启动，仅查询当前任务的只读证据',sessionId:session.id})
  let reason
  try { reason = await harness.start(session,'分析以下任务的未完成原因，并提供具体处理建议：'+bounded({task:row,timeWindow:{start:localTime(start),end:localTime(end),timezone:'Asia/Shanghai'}}),{mode:'diagnose',signal}) }
  catch(error) {
    checkpoint(signal)
    reason=session.turn?.conclusion?.content || '未完成原因：现有证据不足，暂不能确定。\n分析中断：'+redact(String(error.message).slice(0,300))+'。\n建议：核对最近执行的首个失败步骤、申报账户及调度队列；分析取证已保留，请勿仅据此重复提交业务。\n缺失证据：未取得完整模型分析结论。'
  }
  checkpoint(signal)
  progress({stage:'complete',message:'分析结论已生成',sessionId:session.id})
  const category=classifyDiagnosis(reason,session.state)
  dependencies.onResult?.({sessionId:session.id,state:session.state,category,flowConfigurationIssue:category==='流程配置',
    details:state.evidenceDetails,
    ...(category==='流程配置'?{handoff:createRepairHandoff(session,reason,input)}:{}),modelCalls:session.turn.modelCalls,tools:session.turn.tools})
  return reason
}
module.exports = {analyzeTask,localTime,bounded,sanitize,resolveTask,matchingExecution}
