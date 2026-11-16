'use strict'
const { ToolRegistry } = require('../../agent-core/tool-registry')
const { checkpoint } = require('../../agent-core/control')
const { findRecordArray } = require('../../services/undeclared-monitor')
const { readAnalysisImage } = require('../../services/analysis-image')
const {localTime,sanitize,same,matchingExecution} = require('./task-scope')
const { modePolicy } = require('./policy')
const {registerSaasEvidenceTools} = require('./tools/saas-evidence')
const {queueObservation,executionFailures} = require('./evidence-model')
function createOperationsTools({row,server,dependencies,session,readRaw,start,end,state}) {
  const executions = new Map(), files = new Map(), uuids = new Set(), images = state.images
  const queues = new Map()
  state.evidenceDetails=[]
  let config = null
  const registry = new ToolRegistry({modePolicy}), {z} = require('zod'), empty = z.object({}).strict()
  const read = async (path, body, toolSignal) => {
    try { checkpoint(toolSignal); return await readRaw(path, body, toolSignal) }
    catch (error) { checkpoint(toolSignal); return { unavailable: true, message: error.message } }
  }
  const tool = (name, purpose, schema, run) => {
    registry.add(name, purpose, schema, 'read', async (args, context) => {
      checkpoint(context.signal)
      const value = await run(args,context)
      checkpoint(context.signal)
      const safe=sanitize(value)
      if(safe&&typeof safe==='object'&&Array.isArray(safe.facts)&&safe.facts.length){
        const evidenceId=context.harness.artifact(session,safe)
        state.evidenceDetails.push({tool:name,evidenceId,facts:safe.facts})
        return {...safe,evidenceId}
      }
      return safe
    })
    registry.get(name).parallelSafe=true
  }
  tool('recent_executions', '查询本任务近24小时执行及内嵌步骤明细，建立可查询执行编号。', empty, async (_, { signal }) => {
    const data = await read('robot/app/client/executionList', { appCode: row.appCode, taskCode: row.taskCode,
      ...(row.clientId ? { clientId: row.clientId } : {}), execStartTime: localTime(start), execEndTime: localTime(end) }, signal)
    if (data.unavailable) return data
    const all = findRecordArray(data, ['executionCode']), filtered = all.filter(item => {
      if (!matchingExecution(item, row)) return false
      const date = Date.parse(String(item.startTime || '').replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(item.startTime || '') ? '' : '+08:00'))
      return Number.isFinite(date) && date >= start.getTime() && date <= end.getTime()
    }).sort((a,b) => String(b.startTime).localeCompare(String(a.startTime)))
    filtered.slice(0,20).forEach(item => { if (item.executionCode && item.flowCode) executions.set(item.executionCode + ':' + item.flowCode, item) })
    return { records: filtered.slice(0,20), excluded: all.length - filtered.length, coverage: '近24小时，最多20条；执行成功不等于业务完成', hasMore: filtered.length > 20 }
  })
  tool('execution_detail', '查询已发现的本任务执行编号对应的步骤错误、数据和截图文件信息。', z.object({ executionCode:z.string(), flowCode:z.string() }).strict(), async (args, { signal }) => {
    if (!executions.has(args.executionCode + ':' + args.flowCode)) throw new Error('只能查询本任务已返回的执行编号与流程')
    const data = await read('robot/app/client/client/execution/detail?executionCode=' + encodeURIComponent(args.executionCode) + '&flowCode=' + encodeURIComponent(args.flowCode), {}, signal)
    if (data.unavailable) return data
    const details = findRecordArray(data, ['stepCode']).filter(item => same(item.executionCode, args.executionCode) && same(item.flowCode, args.flowCode))
    for (const step of details) for (const file of step.files || []) {
      const id = String(file.fileId || '')
      if (/^\d+$/.test(id) && (!file.executionCode || same(file.executionCode, args.executionCode)) && (!file.flowCode || same(file.flowCode, args.flowCode))) files.set(id, { ...file, executionCode:args.executionCode, flowCode:args.flowCode, stepCode:step.stepCode })
    }
    return { records:details, facts:executionFailures(details), coverage:'截图文件信息尚不代表已识别图像；失败步骤现象不等于根因，点击失败需结合实际页面和定位，未扫码须有明确日志或页面证据。' }
  })
  tool('queue_status', '查询并严格核对本任务调度队列；不执行置顶、重试或撤销。', empty, async (_, { signal }) => {
    const data = await read('robot/taskQueue/page', { page:1,start:0,size:100,query:[
      {property:'taskCode',value:row.taskCode},{property:'declareAccounts',value:row.accountNumber},
      ...(row.clientId ? [{property:'clientId',value:row.clientId}] : [])] }, signal)
    if (data.unavailable) return data
    const all = findRecordArray(data, ['taskCode'])
    const records=all.filter(item => same(item.taskCode,row.taskCode) && same(item.appCode,row.appCode) && same(item.declareAccount || item.accountNumber,row.accountNumber)&&(!row.clientId||!item.clientId||same(item.clientId,row.clientId)))
    records.forEach(item=>{if(item.executionCode)queues.set(String(item.executionCode),item)})
    return { records,facts:records.map(item=>queueObservation(item,end)),
      coverage:'只读取前100条并核对任务、应用及账户；无匹配记录不能证明没有排队', received:all.length }
  })
  registerSaasEvidenceTools({tool,read,row,start,end,queues,z})
  tool('task_config', '读取本任务配置，核对登录方式、业务参数及配置缺口。', empty, async (_, { signal }) => {
    config = await read('robot/app/client/getRobotTaskConfigInfo/' + encodeURIComponent(row.taskCode), {}, signal); return config
  })
  tool('service_flows', '读取本任务服务流程及启停情况。', empty, (_, { signal }) => read('robot/app/client/showServiceItemFlow/' + [row.appCode,row.taskCode,row.accountNumber].map(encodeURIComponent).join('/'), {}, signal))
  tool('execution_plan', '读取当前账户有效执行计划，包含私有覆盖、启停原因和执行年月日时段。', empty, async (_, { signal }) => {
    if (!row.clientId || !row.machineCode) return { unavailable:true,message:'缺少客户编号或设备编号，不能定位账户执行计划；可先读取 service_flows 的执行计划摘要' }
    const data = await read('robot/app/client/getRobotPlant/' + [row.clientId,row.machineCode,row.appCode].map(encodeURIComponent).join('/') + '?searchText=' + encodeURIComponent(row.accountNumber), {}, signal)
    if (data.unavailable) return data
    const records = findRecordArray(data,['taskCode']).filter(item => matchingExecution(item,row) && same(item.accountNumber,row.accountNumber))
      .map(item => ({...item,scheduleList:(item.scheduleList || []).filter(plan => (!plan.taskCode || same(plan.taskCode,row.taskCode)) && (!plan.appCode || same(plan.appCode,row.appCode)))}))
    return {records,now:localTime(end),timezone:'Asia/Shanghai',coverage:'后台合并私有及公共计划；execYear/execMonth、execCycle、execAreaTime、execStyle共同约束执行时间，缴费等服务有例外。计划匹配不等于已入队，也不等于业务申报期。'}
  })
  tool('declaration_period', '按当前地区和业务读取各申报类型的申报期，核对报盘空白期。', empty, async (_, { signal }) => {
    if (!row.addrId || ![1,2].includes(Number(row.businessType))) return {unavailable:true,message:'缺少地区或明确的社保/公积金业务类型，不能查询申报期'}
    const data = await read('policy/agent/getPolicyAddrDeadlineSettings/' + [row.addrId,row.businessType].map(encodeURIComponent).join('/'), {}, signal)
    if (data.unavailable) return data
    return {records:findRecordArray(data,['declareType']).filter(item => same(item.addrId,row.addrId) && same(item.businessType,row.businessType)),
      now:localTime(end),coverage:'仅本地区本业务规则；需对应增员/减员/调基/补缴。客户declareExpRule=0可绕过按申报期导出；缺少开关及实际报错时不能认定本任务受限。独立部署可能未暴露该政策接口。'}
  })
  tool('queue_rules', '读取SaaS及独立部署源码核对的自动入队条件，规则本身不是当前失败事实。', empty, async () => ({
    source:'RobotTaskQueueComponent.generateDataTasks / ConvertUtl.checkSchedule / ScheduleUtils.matchSchedule（SaaS和独立部署）',
    gates:['账户/任务启用且存在对应服务流程','自动执行计划匹配当前年月、日期、时段；缴费及部分基数场景有例外','增减员等服务需存在对应待申报数据','报盘检查需返回可申报数据','登录方式、H5会话及客户工作时间、前置基数申报等条件可能阻止入队'],
    observedFailure:false,note:'须与当前任务的启停原因、有效计划、服务项、执行错误或队列备注逐项核实；没有执行记录不能区分未入队与入队后尚未执行。'
  }))
  tool('offer_templates', '按本任务地区、业务查询报盘模板；不调用产生报盘文件的导出接口。', empty, async (_, { signal }) => {
    if (!row.addrId || !row.businessType) return { unavailable:true,message:'缺少参保地或业务类型，不能跨地区查询模板' }
    const data = await read('policy/offerSettings/page', {page:1,start:0,size:50,query:[{property:'addrId',value:row.addrId},{property:'businessType',value:row.businessType}]}, signal)
    const records = findRecordArray(data,['uuid']).filter(item => (!item.addrId || same(item.addrId,row.addrId)) && (!item.businessType || same(item.businessType,row.businessType)))
    records.forEach(item => { if (item.uuid) uuids.add(String(item.uuid)) })
    return data.unavailable ? data : {records,coverage:'最多50条，规则约束不等于当前员工触发限制；独立部署可能不提供此接口'}
  })
  for (const name of ['column_rules','template_detail']) tool(name, name === 'column_rules' ? '读取已发现报盘模板的字段校验规则。' : '读取已发现报盘模板的配置与导出约束。', z.object({uuid:z.string()}).strict(), (args, { signal }) => {
    if (!uuids.has(args.uuid)) throw new Error('只能查询当前数据源已返回的模板uuid')
    return read('policy/offerSettings/' + (name === 'column_rules' ? 'columnRuleList/' : 'findByUuid/') + encodeURIComponent(args.uuid), {}, signal)
  })
  tool('offer_rules', '读取已知申报网站的回盘状态和节点判断规则，不能据此认定某员工违规。', empty, (_, { signal }) => {
    const groups = config?.data || config
    const args = Array.isArray(groups) ? groups.flatMap(group => group.args || []) : groups?.args || []
    const website = row.declareWebsite || args.find(item => item.argsKey === 'declareWebsite')?.argsValue
    return website ? read('robot/offerRule/list', {declareWebsite:website}, signal) : {unavailable:true,message:'缺少已确认申报网站编码，未查询全局回盘规则'}
  })
  tool('export_constraints','查看经源码核对的报盘导出接口前置要求；不触发实际报盘导出。',empty,async()=>({
    source:'SaaS及独立部署 EmployeeDeclareServiceImpl.declareOfferExportPage / AbstractOfferExportBase.getDeclareDateRange（本地源码核对）',
    required:['addrName','businessType','declareTypes','tplTypeCode','accountNumbers','declareStatus','dateStr','operationTypes'],
    restrictions:['申报账户必须能关联客户；客户declareExpRule=0时不按申报期导出','按申报期导出时须配置对应地区、业务和申报类型的申报期','起止月相同：日期小于dayBegin或大于dayEnd为空白期；起止月不同：日期大于dayEnd且小于dayBegin为空白期','模板、默认子节点及关联文件缺失可能阻止报盘；字段校验须结合本次模板及实际数据验证'],
    observedFailure:false,note:'仅说明接口前置要求，不能据此认定当前任务缺参；实际原因须结合执行错误、当前任务配置和模板规则。分析不会调用导出接口。'
  }))
  tool('execution_image', '读取已发现的当前执行截图，交给当前模型识别；不支持图像时明确降级。', z.object({fileId:z.string().regex(/^\d+$/)}).strict(), async ({fileId}, {signal,harness}) => {
    if (!files.has(fileId)) throw new Error('只能读取本任务执行明细已返回的截图文件')
    if (state.visionUnavailable) return {unavailable:true,message:'当前模型不支持图像输入，截图内容未识别'}
    if (images.size >= 2 && !images.has(fileId)) return {unavailable:true,message:'本任务最多读取2张截图，请优先失败步骤'}
    const data = await (dependencies.image || readAnalysisImage)(server,fileId,signal)
    images.set(fileId,data)
    return {fileId,...files.get(fileId),imageAttached:true,artifactId:harness.artifact(session,{fileId,data})}
  })
  tool('read_evidence', '分页读取本次分析已保存的完整取证结果。', z.object({artifactId:z.string(),offset:z.number().int().nonnegative().default(0)}).strict(), ({artifactId,offset},{harness}) => {
    const text = JSON.stringify(harness.readArtifact(session,artifactId)), length=6000
    return {content:text.slice(offset,offset+length),nextOffset:offset+length<text.length?offset+length:null,total:text.length}
  })
  return registry
}
module.exports = {createOperationsTools}
