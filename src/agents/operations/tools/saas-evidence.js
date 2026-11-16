'use strict'
const {findRecordArray}=require('../../../services/undeclared-monitor')
const {same}=require('../task-scope')
const {timestamp,reportedReason}=require('../evidence-model')
function registerSaasEvidenceTools({tool,read,row,start,end,queues,z}) {
  const empty=z.object({}).strict()
  const scoped=item=>same(item.taskCode,row.taskCode)&&(!item.appCode||same(item.appCode,row.appCode))&&
    (!row.clientId||same(item.clientId,row.clientId))
  const within=value=>{const time=timestamp(value);return Number.isFinite(time)&&time>=start.getTime()&&time<=end.getTime()}
  const pick=(item,keys)=>Object.fromEntries(keys.filter(key=>item[key]!==undefined).map(key=>[key,item[key]]))
  tool('queue_generation_records','查询本任务近24小时真实入队判断记录，区分执行计划、无数据、报盘检查、UKey和设备前置限制。',empty,async(_, {signal})=>{
    if(!row.clientId)return {unavailable:true,message:'缺少客户编号，不能查询含任务配置快照的入队记录'}
    const data=await read('robot/loginAuth/findTaskQueueGenerate?limit=50&orderBy=timeStamp&orderDirection=desc',
      {taskCode:row.taskCode,'taskVO.clientId':row.clientId,'taskVO.appCode':row.appCode},signal)
    if(data.unavailable)return data
    const all=findRecordArray(data,['taskCode'])
    const records=all.filter(item=>same(item.taskCode,row.taskCode)&&scoped(item.taskVO||{})&&within(item.createTime)).map(item=>({
      id:item.id,taskCode:item.taskCode,queueItem:item.queueItem,createTime:item.createTime,message:item.message,
      outcome:pick(item.otherData||{},['code','msg']),
      flows:(item.flowVOList||[]).map(flow=>pick(flow,['flowCode','flowName','serviceItem','execYear','execMonth','execCycle','execAreaTime','execStyle','status']))
    }))
    return {records,facts:records.flatMap(item=>[reportedReason('enqueue',item.message,{recordId:item.id,at:item.createTime,queueItem:item.queueItem}),
      ...(item.outcome.msg?[reportedReason('enqueue',item.outcome.msg,{recordId:item.id,at:item.createTime,resultCode:item.outcome.code})]:[])]),
      coverage:'按本任务/客户/应用固定等值条件查询最新50条后过滤24小时；不是完整历史，部分账户停用等分支仅写日志。调用入队列不是入队成功证明，须核对outcome.code/msg和实际队列。'}
  })
  tool('queue_pull_records','查询已发现队列的设备拉取阻塞明细：并发、画像、共享端口、UKey占用、限频与指定设备。',z.object({executionCode:z.string().min(1)}).strict(),async({executionCode},{signal})=>{
    if(!queues.has(executionCode))throw new Error('只能查询本任务队列返回的执行编号，请先读取queue_status')
    const data=await read('robot/taskQueue/getPullPage',{page:1,start:0,size:100,query:[{property:'executionCode',value:executionCode}]},signal)
    if(data.unavailable)return data
    const records=findRecordArray(data,['executionCode']).filter(item=>same(item.executionCode,executionCode)&&within(item.pullTime))
    return {records,facts:records.map(item=>reportedReason('dequeue',item.message,{executionCode,machineCode:item.machineCode,at:item.pullTime})),
      coverage:'最多100条；每台设备同一执行编号的记录会被覆盖，且拉取整体未选中任务的提前返回分支可能未保存。只代表该设备该时刻的判断，不能外推所有设备或阻塞持续时长；无记录不能证明没有阻塞。'}
  })
  tool('login_auth_status','读取本任务登录中心待登录、维持及失效状态；未登录不能直接认定未扫码。',empty,async(_,{signal})=>{
    const data=await read('robot/loginAuth/pageList',{page:1,start:0,size:50,query:[{property:'declareAccount',value:row.accountNumber},
      ...(row.clientId?[{property:'clientId',value:row.clientId}]:[])]},signal)
    if(data.unavailable)return data
    const records=findRecordArray(data,['taskCode']).filter(item=>scoped(item)&&
      (item.accountNumber?same(item.accountNumber,row.accountNumber):same(item.declareAccount,row.accountNumber)||String(item.declareAccount||'').endsWith('-'+row.accountNumber)))
      .slice(0,50).map(item=>pick(item,['id','appCode','taskCode','clientId','accountNumber','declareAccount','declareSystem','machineCode','executionCode','loginType','processStatus','loginStatus','createTime','updateTime','comment','hasFreeDevice']))
    return {records,facts:records.map(item=>({stage:'authentication',code:Number(item.processStatus)===0?'PENDING_LOGIN':'LOGIN_STATE',...item})),
      coverage:'最多保留50条；该服务未保证分页且可能覆盖clientId为当前登录客户，并按账户权限过滤；只采纳当前任务/客户。processStatus 0待登录/1已登录；loginStatus 0未登录/1维持中/2失效。未扫码须有明确日志或页面证据，不能仅凭状态推断。'}
  })
  tool('ukey_bindings','查询当前任务UKey绑定、插入/挂载状态和证书日期，不执行连接或续期。',empty,async(_,{signal})=>{
    if(!row.clientId)return {unavailable:true,message:'缺少客户编号，不能查询UKey绑定'}
    const data=await read('robot/usbKey/usbAccountPage',{page:1,start:0,size:50,query:[{property:'clientId',value:row.clientId},{property:'keyword',value:row.accountNumber}]},signal)
    if(data.unavailable)return data
    const records=findRecordArray(data,['taskCode']).filter(item=>scoped(item)&&same(item.declareAccount,row.accountNumber)).map(item=>pick(item,
      ['id','usbKeyId','clientId','appCode','taskCode','declareAccount','declareSystem','disabled','status','mountClient','physicalId','busId','certEffeStartTime','certEffeEndTime','remark']))
    return {records,facts:records.map(item=>({stage:'environment',code:'UKEY_STATE',...item})),
      coverage:'最多50条；status 1可用/2已挂载/3不可用/4未插入；disabled按实体定义0禁用/1启用。当前状态不能证明过去识别失败；挂载不等于异常，须关联实际执行或拉取拒绝记录。'}
  })
  tool('executor_status','读取当前客户设备状态与心跳，辅助判断队列是否缺少可运行设备。',empty,async(_,{signal})=>{
    if(!row.clientId)return {unavailable:true,message:'缺少客户编号，不能查询执行器'}
    const data=await read('robot/version/client/getByClientId/'+encodeURIComponent(row.clientId),{},signal)
    if(data.unavailable)return data
    const records=findRecordArray(data,['machineCode']).filter(item=>same(item.clientId,row.clientId)).map(item=>pick(item,
      ['machineCode','machineName','clientId','status','heartbeatTime','type','maxKeepNum','remark']))
    return {records,facts:records.map(item=>({stage:'environment',code:'EXECUTOR_STATE',...item})),observedAt:end.toISOString(),
      coverage:'只代表当前客户设备快照；1就绪/2运行/3关闭/4机器人异常/5客户端异常/6升级/7升级失败/8离线/9闲置。无空闲设备只是线索，画像、指定设备、UKey和共享端口仍会影响资格；不宣称精确队列名次或剩余等待时间。'}
  })
}
module.exports={registerSaasEvidenceTools}
