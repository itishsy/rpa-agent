'use strict'
function timestamp(value) {
  if(typeof value==='number')return Number.isFinite(value)?value:NaN
  if(!value)return NaN
  const text=String(value)
  return Date.parse(text.replace(' ','T')+(/Z$|[+-]\d\d:\d\d$/.test(text)?'':'+08:00'))
}
const reasons=[
  ['SCHEDULE_MISMATCH',/执行计划.*不匹配|执行间隔时间未到/],
  ['NO_PENDING_DATA',/没有待申报数据|没有待审核数据|没有需执行数据/],
  ['NO_EXPORTABLE_DATA',/没有可申报数据/],
  ['BASE_DECLARATION_PENDING',/基数未完成申报/],
  ['PAYMENT_DISABLED',/缴费已暂停|已暂停API自动任务/],
  ['NO_PAYMENT_ORDER',/未查到.*缴费单|未查询到.*缴费单/],
  ['NO_EXECUTOR',/无可用盒子/],
  ['UKEY_UNAVAILABLE',/uKey未配置|uKey非可用/i],
  ['UKEY_MANUAL_IN_USE',/uKey.*申报老师.*使用/i],
  ['UKEY_OTHER_SYSTEM_IN_USE',/uKey.*其他系统.*使用/i],
  ['ACCOUNT_SYSTEM_MUTEX',/同一申报户同一系统.*不能同时/],
  ['ACCOUNT_MUTEX',/同一申报户不能同时/],
  ['SHARED_PORT_MUTEX',/同一共享端口号不能/],
  ['SHARED_PORT_DEVICE_AFFINITY',/同一共享端口号只能同一个盒子/],
  ['PHONE_LOGIN_MUTEX',/同一手机号不能同时/],
  ['SMS_RATE_LIMIT',/10分钟内短信发送次数/],
  ['IDENTITY_SWITCH_LIMIT',/60分钟内校验身份切换次数/],
  ['RETRY_FAIRNESS_LIMIT',/已重试3次数据未跑完/],
  ['PROFILE_MISMATCH',/画像.*不能/],
  ['SESSION_REFRESH_MUTEX',/刷新会话.*不能|会话维持任务.*不能/],
  ['SESSION_DEVICE_AFFINITY',/非会话维持设备/],
  ['FIXED_DEVICE_MISMATCH',/非指定设备/],
  ['DEVICE_LOAD_BALANCE',/不是数量最少/],
  ['H5_SESSION_OR_WORKTIME',/H5登录.*(?:未维持|当前时间|任何时间|会话已丢失)/],
  ['FLOW_UNAVAILABLE',/流程为空|未找到对应服务项|未关联执行计划/]
]
function reportedReason(stage,message,reference={}) {
  const text=String(message||'')
  return {stage,code:reasons.find(([,pattern])=>pattern.test(text))?.[0]||'BACKEND_REPORTED',
    message:text,...reference,observed:true,note:'后台在所示时间记录的判断；不代表当前仍满足该条件'}
}
function queueObservation(item,now) {
  const created=timestamp(item.createTime)
  const waiting=Number(item.status)===2&&Number.isFinite(created)&&created<=now.getTime()
  return {stage:'dequeue',code:Number(item.status)===2?'QUEUED_WAITING':'QUEUE_STATE',executionCode:item.executionCode,
    status:item.status,createTime:item.createTime,observedAt:now.toISOString(),
    waitingMinutesAtObservation:waiting?Math.floor((now.getTime()-created)/60000):null,
    preStartTime:item.preStartTime,preEndTime:item.preEndTime,comment:item.comment,
    note:'等待分钟数按本条队列生成时间计算，不是执行器等待耗时或预计剩余时间；创建时间异常或非待执行时不计算'}
}
function executionFailures(details) {
  return details.filter(step=>step.error||step.status!=null&&Number(step.status)===0).sort((a,b)=>(timestamp(a.startTime)||a.startDate||0)-(timestamp(b.startTime)||b.startDate||0)).map(step=>{
    const error=String(step.error||'')
    const text=String(step.stepName||'')+' '+error
    let code='STEP_FAILED'
    if(/未扫码|扫码超时|等待.{0,10}扫码|未.{0,3}扫描二维码/.test(error))code='SCAN_WAIT'
    else if(/验证码/.test(error))code='CAPTCHA_REQUIRED'
    else if(/ukey|u-key|usb|证书/i.test(error))code=/识别|未检测|未找到|找不到/.test(error)?'UKEY_RECOGNITION_FAILED':'UKEY_EXECUTION_ERROR'
    else if(/click|点击/i.test(text))code='CLICK_FAILED'
    return {stage:'execution',code,executionCode:step.executionCode,flowCode:step.flowCode,stepCode:step.stepCode,
      stepName:step.stepName,startTime:step.startTime,status:step.status,error,
      symptomOnly:true,note:'步骤报告的异常现象；根因需结合实际页面、配置和截图验证'}
  })
}
module.exports={timestamp,reportedReason,queueObservation,executionFailures}
