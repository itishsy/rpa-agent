'use strict'
const { redact, digest } = require('./store')

function object(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch (_) { return {} } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
const FIELDS = {
  region: ['region', 'addrName', 'cityName'], system: ['declareSystem', 'declareSystemName'],
  businessType: ['businessType', 'businessName', 'serviceItem'], subject: ['companyName', 'customerName', 'unitName'],
  account: ['accountNumber', 'accNumber', 'socialNumber'], period: ['declareMonth', 'feeMonth', 'period'],
  personCount: ['personCount', 'declareCount'], amount: ['amount', 'payAmount', 'totalAmount']
}
function businessContext(session, task = null, { redactResult = true } = {}) {
  const confirmed = session.businessProfile && session.businessProfile.taskCode === session.taskCode ? session.businessProfile.values : {}
  const sources = [['task', object(task)], ['task.taskArgs', object(task?.taskArgs)],
    ['dsl', session.dsl || {}], ['dsl.appArgs', object(session.dsl?.appArgs)]]
  const fields = {}, missing = []
  for (const [field, keys] of Object.entries(FIELDS)) {
    const candidates = sources.flatMap(([source, value]) => keys.filter(key => value[key] !== undefined && value[key] !== null && value[key] !== '')
      .map(key => ({ source: source + '.' + key, value: value[key] })))
    fields[field] = { candidates, conflict: new Set(candidates.map(item => JSON.stringify(item.value))).size > 1 }
    if (confirmed?.[field]) fields[field] = { ...fields[field], confirmed: { source: '用户确认的业务预期', value: confirmed[field] } }
    if (!candidates.length && !confirmed?.[field]) missing.push(field)
  }
  const name = String(session.dsl?.flowName || '')
  const hints = ['补缴', '汇缴', '缴费', '增员', '减员', '在册', '登录'].filter(word => name.includes(word))
  const context = { taskCode: session.taskCode || null, taskState: !session.taskCode ? 'UNSELECTED' : task ? 'SELECTED' : 'NOT_FOUND',
    flowCode: session.scope.flowCode, revision: session.revision, dslFingerprint: digest(session.dsl || {}),
    identity: digest({ taskCode: session.taskCode || null, fields }), fields, missing,
    inferred: { businessHints: hints, domain: /公积金/.test(session.dsl?.appName || '') ? '公积金' : /社保/.test(session.dsl?.appName || '') ? '社保' : null },
    note: '候选值保留来源，不自动合并冲突；用户确认值是业务预期，仍须与网厅核对；流程名推断不是地区业务规则。' }
  return redactResult ? redact(context) : context
}
function walkSteps(dsl, visit) {
  const walk = (steps, path, active) => (steps || []).forEach((step, index) => {
    const location = `${path}[${index}]`, enabled = active && step.status !== 0
    visit(step, location, enabled)
    walk(step.body || step.children || step.list, location + '.body', step.actionCode === 'codeBlock' ? enabled : active)
  })
  walk(dsl.steps, 'steps', true)
}
async function loadBusinessContext(session, readTasks) {
  const tasks = await readTasks(session)
  const selected = session.taskCode ? tasks.filter(task => task.taskCode === session.taskCode) : []
  if (selected.length > 1) throw new Error('选定任务重复，无法确定业务上下文')
  session.businessContext = businessContext(session, selected[0])
  return session.businessContext
}
function traceVariable(dsl, name, offset = 0, limit = 40) {
  const matches = []
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const token = new RegExp('(^|[^\\w$])' + escaped + '(?![\\w$])')
  const visit = (value, path, meta) => {
    if (typeof value === 'string') {
      const parsed = object(value)
      if (Object.keys(parsed).length) return visit(parsed, path, meta)
      if (token.test(value)) matches.push({ ...meta, path, kind: 'reference-or-expression', value: value.slice(0, 800) })
    } else if (Array.isArray(value)) value.forEach((item, i) => visit(item, `${path}[${i}]`, meta))
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      if (key === name) matches.push({ ...meta, path: path + '.' + key, kind: 'named-field', value: item })
      else visit(item, path + '.' + key, meta)
    }
  }
  visit(dsl.appArgs, 'appArgs', { flowCode: dsl.flowCode, enabled: true })
  walkSteps(dsl, (step, path, enabled) => {
    const meta = { flowCode: dsl.flowCode, stepCode: step.stepCode, stepName: step.stepName, actionCode: step.actionCode, enabled }
    for (const field of ['actionArgs', 'targetArgs', 'skipCondition']) visit(step[field], path + '.' + field, meta)
  })
  return redact({ variable: name, matches: matches.slice(offset, offset + limit), total: matches.length,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
    note: '静态出现位置，不代表实际赋值顺序或运行时值；条件分支、任务覆盖与子流程传参须结合现场核对。' })
}
module.exports = { businessContext, loadBusinessContext, traceVariable }
