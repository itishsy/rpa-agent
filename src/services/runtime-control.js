'use strict'
const http=require('node:http'),https=require('node:https')
const {normalizeBaseUrl}=require('./executor-service')
function runtimeUrl(connection){
  if(connection.runtimeUrl)return normalizeBaseUrl(connection.runtimeUrl)
  const url=new URL(connection.baseUrl);url.port='19090';return url.origin
}
function request(connection,path,body){
  if(!['/api/agent/status','/api/agent/takeover'].includes(path))throw Error('不支持的 Runtime 操作')
  if(!connection.debugToken||connection.debugToken.length<16)throw Error('请先配置至少16位的执行器调试令牌，并与 Runtime 保持一致')
  const url=new URL(path,runtimeUrl(connection)),payload=body?Buffer.from(JSON.stringify(body)):null
  return new Promise((resolve,reject)=>{
    const req=(url.protocol==='https:'?https:http).request(url,{method:payload?'POST':'GET',timeout:payload?240000:10000,headers:{'X-RPA-Debug-Token':connection.debugToken,...(payload?{'Content-Type':'application/json','Content-Length':payload.length}:{})}},res=>{
      let raw='';res.on('data',part=>{raw+=part;if(raw.length>1024*1024)req.destroy(Error('Runtime 响应过大'))});res.on('error',reject)
      res.on('end',()=>{try{const data=JSON.parse(raw);if(res.statusCode!==200){const error=Error(data.error||'Runtime 接管失败');error.runtimeData=data;error.status=res.statusCode;throw error}resolve(data)}catch(error){reject(error)}})
    });req.on('timeout',()=>req.destroy(Error('Runtime 接管超时，请核对远程状态后重试同一请求')));req.on('error',reject);if(payload)req.write(payload);req.end()
  })
}
function matchTask(tasks,row){
  const matches=tasks.filter(task=>row.taskCode?task.taskCode===row.taskCode:[task.accountNumber,task.accNumber,task.taskName].some(value=>value&&[row.accountNumber,row.accNumber].includes(String(value))))
  if(matches.length!==1)throw Error('无法唯一匹配该执行器的申报账户，请核对任务编号和账户配置')
  return matches[0]
}
module.exports={runtimeUrl,request,matchTask}
