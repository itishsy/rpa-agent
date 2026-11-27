'use strict'
const http=require('node:http'),https=require('node:https')
const {normalizeBaseUrl}=require('./executor-service')
function runtimeUrl(connection, inferProxyPort=false){
  if(connection.runtimeUrl)return normalizeBaseUrl(connection.runtimeUrl)
  const url=new URL(normalizeBaseUrl(connection.baseUrl))
  if(inferProxyPort && /^\/virwin\/p\/\d+\/\d+$/.test(url.pathname)){
    url.pathname=url.pathname.replace(/\/\d+$/, '/19090')
    return url.href
  }
  if(url.pathname!=='/')throw Error('代理执行器请填写对应的 Runtime 地址')
  url.port='19090';return url.origin
}
function request(connection,path,body,{signal}={}){
  if(!['/api/agent/status','/api/agent/takeover','/api/agent/platforms','/api/agent/control'].includes(path))throw Error('不支持的 Runtime 操作')
  const debugToken = String(connection.debugToken || '').trim()
  if(debugToken.length<16)throw Error('请先配置至少16位的执行器调试令牌，并与 Runtime 保持一致')
  const url=new URL(runtimeUrl(connection)+path),payload=body?Buffer.from(JSON.stringify(body)):null
  return new Promise((resolve,reject)=>{
    const req=(url.protocol==='https:'?https:http).request(url,{method:payload?'POST':'GET',signal,timeout:payload?240000:10000,headers:{'X-RPA-Debug-Token':debugToken,...(payload?{'Content-Type':'application/json','Content-Length':payload.length}:{})}},res=>{
      let raw='';res.on('data',part=>{raw+=part;if(raw.length>1024*1024)req.destroy(Error('Runtime 响应过大'))});res.on('error',reject)
      res.on('end',()=>{
        let data, parseError
        try{data=JSON.parse(raw)}catch(error){parseError=error}
        if(res.statusCode!==200){
          const error=Error(data?.error||'Runtime 请求失败（HTTP '+res.statusCode+'）')
          error.runtimeData=data;error.status=res.statusCode;reject(error)
        }else if(parseError)reject(parseError)
        else resolve(data)
      })
    });req.on('timeout',()=>req.destroy(Error('Runtime 请求超时，请刷新并核对远程状态')));req.on('error',reject);if(payload)req.write(payload);req.end()
  })
}
async function readServiceName(connection){
  const fallback=connection.serviceName||''
  const unavailable=reason=>({name:fallback,reason})
  if(String(connection.debugToken||'').trim().length<16)return unavailable('请在执行器管理中配置与 Runtime 一致的调试令牌。')
  let address
  try{address=runtimeUrl(connection,true)}
  catch(error){return unavailable(error.message)}
  try{
    const status=await request({...connection,runtimeUrl:address},'/api/agent/status',undefined,{signal:AbortSignal.timeout(2500)})
    const name=typeof status?.platformName==='string'?status.platformName.trim().slice(0,80):''
    return name?{name,reason:'',managementAvailable:status.managementAvailable===true}:unavailable('Runtime 未返回后台服务名称，请核对当前服务账号和 Runtime 版本。')
  }catch(error){
    if([401,403].includes(error.status))return unavailable('Runtime 鉴权失败（HTTP '+error.status+'），请核对调试令牌。')
    const detail=error.status?'HTTP '+error.status:error.code==='ABORT_ERR'?'超时':'无法连接或响应无效'
    return unavailable('Runtime 状态读取失败（'+detail+'），请检查状态端口和执行器管理中的 Runtime 地址。')
  }
}
function matchTask(tasks,row){
  const matches=tasks.filter(task=>row.taskCode?task.taskCode===row.taskCode:[task.accountNumber,task.accNumber,task.taskName].some(value=>value&&[row.accountNumber,row.accNumber].includes(String(value))))
  if(matches.length!==1)throw Error('无法唯一匹配该执行器的申报账户，请核对任务编号和账户配置')
  return matches[0]
}
module.exports={runtimeUrl,request,readServiceName,matchTask}
