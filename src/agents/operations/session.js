'use strict'
const {randomUUID} = require('node:crypto')
function createOperationsSession(row,platformId,start,end) {
  return {id:randomUUID(),agentType:'operations',scope:{platformId:platformId||'analysis',source:row.baseServer,
    appCode:row.appCode,taskCode:row.taskCode,accountNumber:row.accountNumber,clientId:row.clientId},
    taskScope:{...row,timeWindow:{start:start.toISOString(),end:end.toISOString(),timezone:'Asia/Shanghai'}},
    state:'idle',messages:[],events:[],sequence:0,artifacts:{},runs:[],plan:[]}
}
module.exports={createOperationsSession}
