'use strict'
const {prepareContext} = require('./context')
const {redact} = require('../../agent-core/store')
const READ_ONLY=Object.freeze({model:true,effects:Object.freeze(['read']),writeToEditor:false})
function modePolicy(mode='diagnose') {
  if(mode!=='diagnose')throw new Error('运维Agent仅允许只读诊断模式')
  return READ_ONLY
}
function closingMessages(session,goal,reason,limit) {
  const messages=prepareContext(session,limit-1000)
  return [...messages,{role:'user',content:'调查停止：'+String(reason).slice(0,500)+'。停止工具调用，按已有证据给出未完成原因、依据、建议和证据缺口。'}]
}
function fallbackConclusion(session,reason) {
  return '未完成原因：现有证据不足，暂不能确定。\n建议：核对最近执行的首个失败步骤、申报账户及调度队列；不要重复提交。\n缺失证据：'+redact(String(reason).slice(0,500))+'\n原因分类：证据不足'
}
const operationsProfile=Object.freeze({agentType:'operations',defaultMode:'diagnose',modePolicy,prepareContext,closingMessages,fallbackConclusion})
module.exports={operationsProfile,modePolicy}
