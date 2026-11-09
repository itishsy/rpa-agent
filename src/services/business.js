'use strict'
const text = value => String(value ?? '').trim()
const object = value => {
  const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value || {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('应用参数必须是对象')
  return parsed
}
const rowsOf = data => Array.isArray(data) ? data : ['rows', 'records', 'list'].map(key => data?.[key]).find(Array.isArray) || []
const required = (value, label) => { if (!text(value)) throw new Error('请填写' + label); return text(value) }
const integer = (value, low, high, label) => { const n = Number(value); if (!text(value) || !Number.isInteger(n) || n < low || n > high) throw new Error(label + '范围为' + low + '至' + high); return n }
const WRITES = new Set(['saveApplication', 'releaseApplication', 'offlineApplication', 'statusApplication', 'syncApplication', 'activateVersion', 'saveFlow', 'deleteFlow', 'orderFlow', 'organizeFlows', 'statusFlow'])
function createBusinessService(request) {
  const listFlows = async input => {
    const result = await request({ path: 'robot/flow/list', body: { appCode: required(input.appCode, '应用编码'),
      flowTypeList: input.flowTypeList || [1, 2], serviceItemList: input.serviceItemList || [], declareSystemList: input.declareSystemList || [] } })
    if (!Array.isArray(result)) throw new Error('流程列表返回格式无效')
    return result
  }
  async function ownedFlow(input) {
    const list = await listFlows({ appCode: input.appCode })
    const row = list.find(item => item.flowCode === input.flowCode)
    if (!row) throw new Error('流程不属于当前应用，或已被删除，请刷新')
    return { list, row }
  }
  const actions = {
    async applications(input) {
      const page = integer(input.page ?? 1, 1, 100000, '页码'), size = integer(input.size ?? 20, 1, 100, '每页条数')
      const query = [{ property: 'keyWord', value: text(input.keyword) }]
      if (input.statuses?.length) query.push({ property: 'appStatusList', value: input.statuses })
      const data = await request({ path: 'robot/app/getAppData', body: { page, size, start: (page - 1) * size, query } })
      if (!Array.isArray(data) && !['rows','records','list'].some(key=>Array.isArray(data?.[key]))) throw new Error('应用分页返回格式无效')
      const rows = rowsOf(data), rawTotal = data?.total ?? data?.count ?? (typeof data?.records === 'number' ? data.records : undefined)
      const total = rawTotal === undefined ? null : Math.max(0, Number(rawTotal))
      if (total !== null && !Number.isFinite(total)) throw new Error('应用分页总数无效')
      return { rows, page, size, total, hasNext: total === null ? rows.length === size : page * size < total }
    },
    async application(input) {
      const data = await request({ path: 'robot/app/page', body: { page: 1, start: 0, size: 100, query: [{ property: 'appCode', value: required(input.appCode, '应用编码') }] } })
      const row = rowsOf(data).find(item => item.appCode === input.appCode)
      if (!row) throw new Error('应用不存在或无权访问')
      return row
    },
    appTypes: () => request({ path: 'robot/app/type' }),
    regions: () => request({ path: 'policy/declareAddr/addrList' }),
    dynamicFields: input => request({ path: 'robot/app/dynamic/field', params: { robotCode: required(input.robotCode, '机器人类型') } }),
    dictionary: input => request({ path: 'policy/sys/dict/getDictByKey', method: 'GET', params: { dataKey: required(input.key, '字典编码') } }),
    robotDictionary: input => request({ path: 'robot/data/dict/' + encodeURIComponent(required(input.key, '字典编码')) }),
    async saveApplication(input) {
      const appArgs = object(input.appArgs), services = input.robotServiceItemList || []
      if (!Array.isArray(services)) throw new Error('服务项目必须为数组')
      for (const item of services) if (Number(item.serviceStatus) === 0 && !text(item.serviceRemark)) throw new Error('未实现的服务项目必须填写情况说明')
      const body = { appName: required(input.appName, '应用名称'), robotName: required(input.robotName, '机器人类型'), appArgs: JSON.stringify(appArgs),
        appRemark: text(input.appRemark), robotServiceItemList: services, id: input.id ?? null, appCode: input.appCode || null }
      return request({ path: input.appCode ? 'robot/app/updateApp' : 'robot/app/add', body })
    },
    async releaseApplication(input) {
      if (!['主版本号', '子版本号', '补丁'].includes(input.rule)) throw new Error('请选择版本规则')
      const comment = required(input.comment, '更新内容'); if (comment.length > 500) throw new Error('更新内容不能超过500字')
      return request({ path: 'robot/app/release', body: { appCode: required(input.appCode, '应用编码'), rule: input.rule,
        changeReason: required(input.changeReason, '变更原因'), comment } })
    },
    offlineApplication: input => request({ path: 'robot/app/offlineStatus', params: { appCode: required(input.appCode, '应用编码'),
      appStatus: integer(input.appStatus, 0, 6, '下架后状态'), comment: required(input.comment, '下架原因') } }),
    statusApplication: input => request({ path: 'robot/app/updateAppStatus', params: { appCode: required(input.appCode, '应用编码'),
      appStatus: integer(input.appStatus, 0, 6, '应用状态'), remark: required(input.remark, '原因备注') } }),
    syncApplication: input => request({ path: 'robot/app/syncOut', params: { appCode: required(input.appCode, '应用编码'), comment: required(input.comment, '同步说明') } }),
    versions: input => request({ path: 'robot/app/history', params: { appCode: required(input.appCode, '应用编码') } }),
    activateVersion: input => request({ path: 'robot/app/activate', params: { appCode: required(input.appCode, '应用编码'), version: required(input.version, '版本号') } }),
    flows: listFlows,
    flowSources: input => request({ path: 'robot/flow/showOneAppFlow', params: input.appCode ? { appCode: input.appCode } : {} }),
    templates: () => request({ path: 'robot/flow/listTemplate', params: { templateType: 1, flowType: 1 } }),
    async saveFlow(input) {
      const mode = input.mode || 'add'
      if (!['add', 'edit', 'copyAdd', 'relateAdd'].includes(mode)) throw new Error('流程添加方式无效')
      const appCode = required(input.appCode, '应用编码'), flowName = required(input.flowName, '流程名称')
      const flowType = integer(input.flowType ?? 1, 1, 2, '流程类型')
      const flows = await listFlows({ appCode })
      if (flows.some(row => text(row.flowName) === flowName && (mode !== 'edit' || row.flowCode !== input.flowCode))) throw new Error('流程名称不能重复')
      const fields = { appCode, flowName, flowType, serviceItem: flowType === 2 ? '' : input.serviceItem || '',
        declareSystem: required(input.declareSystem, '申报系统'), runSupport: required(input.runSupport, '运行载体'),
        templateFlowCode: input.templateFlowCode || '', tagCode: input.tagCode || '' }
      if (mode === 'edit') {
        const row = flows.find(item => item.flowCode === input.flowCode); if (!row) throw new Error('流程已变化，请刷新')
        return request({ path: 'robot/flow/editFlow', body: { ...fields, id: row.id, flowCode: row.flowCode } })
      }
      if (mode !== 'add') {
        const source = required(input.sourceFlowCode, '来源流程')
        const sources = mode === 'relateAdd' ? flows : rowsOf(await actions.flowSources({}))
        if (!sources.some(row => row.flowCode === source)) throw new Error('来源流程不存在或不在允许范围')
        fields.flowCode = source; fields.flowType = ''
      }
      return request({ path: 'robot/flow/' + mode, params: fields })
    },
    async deleteFlow(input) { await ownedFlow(input); return request({ path: 'robot/flow/delete', params: { flowCode: input.flowCode } }) },
    async orderFlow(input) {
      const { list, row } = await ownedFlow(input), orders = list.map(item => Number(item.execOrder))
      const execOrder = integer(input.execOrder, Math.min(...orders), Math.max(...orders), '执行顺序')
      return request({ path: 'robot/flow/editFlowOrder', body: { id: row.id, appCode: input.appCode, execOrder } })
    },
    async organizeFlows(input) {
      const flows = await listFlows({ appCode: input.appCode }), { planFlowMoves } = require('./flow-organizer')
      const { moves, desired } = planFlowMoves(flows); let completed = 0
      try {
        for (const move of moves) { await request({ path: 'robot/flow/editFlowOrder', body: { ...move, appCode: input.appCode } }); completed++ }
        const actual = (await listFlows({ appCode: input.appCode })).slice().sort((a, b) => Number(a.execOrder) - Number(b.execOrder))
        if (actual.length !== desired.length || actual.some((row, index) => String(row.id) !== String(desired[index].id))) throw new Error('服务器顺序与目标不一致')
      } catch (error) { throw new Error('流程整理已完成' + completed + '/' + moves.length + '次调整；请刷新核对：' + error.message) }
      return { completed, count: desired.length }
    },
    async statusFlow(input) {
      const { row } = await ownedFlow(input), status = integer(input.status, 0, 4, '流程状态')
      if (status === 4 && !text(input.comment)) throw new Error('修复问题必须填写原因备注')
      return request({ path: 'robot/flow/editFlowStatus', body: { appCode: input.appCode, flowCode: row.flowCode, id: row.id, status, comment: text(input.comment) } })
    },
    flowHistory: input => request({ path: 'robot/flow/statusHistory', body: { appCode: required(input.appCode, '应用编码'), flowCode: required(input.flowCode, '流程编码'), historyType: 2 } })
  }
  return { async invoke(name, input = {}) { if (!Object.hasOwn(actions, name)) throw new Error('不支持的业务操作'); return actions[name](input) }, isWrite: name => WRITES.has(name) }
}
module.exports = { createBusinessService, rowsOf }
