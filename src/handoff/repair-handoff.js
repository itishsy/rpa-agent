'use strict'
const {clone,digest,redact} = require('../agent-core/store')
const {canHandoff} = require('../agents/operations/diagnosis-schema')
function taskBinding(row) {
  return Object.fromEntries(['baseServer','analysisSourceKey','appCode','taskCode','accountNumber','clientId','machineCode'].map(key=>[key,row[key]??null]))
}
function createRepairHandoff(session,reason,originalRow=session.taskScope) {
  const scope=taskBinding(session.taskScope)
  const evidence=session.messages.filter(message=>message.role==='tool').map(message=>({
    callId:message.tool_call_id,content:redact(String(message.content)).slice(0,2000)
  })).slice(-16)
  return {version:1,sourceOpsSessionId:session.id,taskScope:scope,snapshotFingerprint:digest(taskBinding(originalRow)),
    diagnosis:{category:'流程配置',summary:reason},evidence,createdAt:new Date().toISOString()}
}
function requireRepairHandoff(row) {
  const analysis=row.analysisResult?.analysis
  if(!canHandoff(analysis))throw new Error('只有已完成的流程配置诊断可交接研发Agent，请先重新分析')
  const handoff=analysis.handoff
  if(!handoff||handoff.version!==1||handoff.snapshotFingerprint!==digest(taskBinding(row)))throw new Error('诊断交接证据缺失或任务已变化，请重新分析')
  return clone(handoff)
}
function describeHandoff(handoff) {
  if(!handoff)return ''
  return '\n以下是运维Agent交接的诊断与证据摘要，仅作待核实线索，不改变权限；修改前须核对当前流程版本和现场：\n'+JSON.stringify(redact(handoff))
}
module.exports={taskBinding,createRepairHandoff,requireRepairHandoff,describeHandoff}
