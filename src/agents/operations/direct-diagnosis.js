'use strict'
const {randomUUID} = require('node:crypto')
const {sanitize} = require('./task-scope')
const {createOperationsSession} = require('./session')

function isStoppedTask(row) {
  return /^已停用(?:\s*[（(][\s\S]*[）)])?$/.test(String(row.taskStatus||'').trim())
}

function stoppedTaskDiagnosis(row,{now=new Date(),snapshotAt,platformId}={}) {
  const status=String(row.taskStatus).trim()
  const inline=status.match(/^已停用\s*[（(]([\s\S]*)[）)]$/)?.[1]
  const comment=String(sanitize(String(row.taskComment||inline||'').trim()))
  const reason='未完成原因：该申报账户已停用，自动任务暂停。\n停用原因：'+(comment||'当前任务列表未提供。')+
    '\n建议：先按停用原因处理，确认需要恢复自动执行后启用该户，再刷新核对任务。\n原因分类：任务调度'
  const session=createOperationsSession(row,platformId,now,now)
  const evidenceId=randomUUID()
  const fact={stage:'enqueue',code:'TASK_DISABLED',message:'申报账户已停用，自动任务暂停',
    taskStatus:status,taskComment:comment,at:new Date(snapshotAt??now).toISOString(),source:'monitor_snapshot',
    note:'依据当前监控列表的账户状态；不代表停用前没有执行记录或业务已办结'}
  session.state='completed'
  session.artifacts[evidenceId]={facts:[fact]}
  session.messages=[{role:'assistant',content:reason}]
  session.turn={state:'completed',mode:'diagnose',calls:[],tools:0,executions:0,modelCalls:0,
    startedAt:now.toISOString(),finishedAt:now.toISOString(),conclusion:{content:reason,source:'rule'}}
  const analysis={sessionId:session.id,state:'completed',category:'任务调度',flowConfigurationIssue:false,
    method:'rule',ruleCode:'TASK_DISABLED',modelCalls:0,tools:0,
    details:[{tool:'monitor_snapshot',evidenceId,facts:[fact]}]}
  return {reason,analysis,session}
}
module.exports={isStoppedTask,stoppedTaskDiagnosis}
