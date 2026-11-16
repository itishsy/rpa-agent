'use strict'
function normalizeExecutorAccounts(data){
  const rows=Array.isArray(data)?data:data?.rows||data?.records||data?.list
  if(!Array.isArray(rows))throw new Error('执行器未返回有效的申报账户列表，请检查运行时平台登录状态及应用同步情况')
  const accounts=new Map()
  for(const row of rows){
    if(!row||row.taskCode==null||!String(row.taskCode).trim())continue
    const taskCode=String(row.taskCode).trim()
    if(!accounts.has(taskCode))accounts.set(taskCode,{...row,taskCode,taskName:String(row.taskName||row.accountName||row.accountNumber||row.accfundNumber||row.socialNumber||row.username||taskCode)})
  }
  if(rows.length&&!accounts.size)throw new Error('申报账户列表缺少任务编号，不能用于运行，请检查执行器接口版本')
  return [...accounts.values()]
}
module.exports={normalizeExecutorAccounts}
