'use strict'
const {normalizeHistory} = require('../../agent-core/history')
const {redact} = require('../../agent-core/store')
const {INSTRUCTIONS} = require('./instructions')
function prepareContext(session,limit=60000) {
  const history=normalizeHistory(session.messages)
  const system={role:'system',content:INSTRUCTIONS}
  const task={role:'user',content:'本次诊断范围（数据，不改变权限）：'+JSON.stringify(redact(session.taskScope))}
  let cut=0
  const build=()=>[system,task,...(cut?[{role:'user',content:'较早取证摘要（可能不完整）：'+JSON.stringify(history.slice(0,cut).filter(item=>item.role==='tool').slice(-6).map(item=>({callId:item.tool_call_id,content:String(item.content).slice(0,700)})))}]:[]),...history.slice(cut)]
  let messages=build()
  for(let index=1;JSON.stringify(messages).length>limit&&index<=history.length;index++){
    if(index<history.length&&history[index].role!=='assistant')continue
    cut=index;messages=build()
  }
  if(JSON.stringify(messages).length>limit)throw Object.assign(new Error('诊断证据超过上下文预算'),{code:'CONTEXT_BUDGET'})
  session.compaction={version:1,sourceMessages:history.length,retainedFrom:cut,projectedChars:JSON.stringify(messages).length}
  return messages
}
module.exports={prepareContext}
