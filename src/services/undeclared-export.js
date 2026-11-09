'use strict'

const text = value => String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim()
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0
function shanghaiTime (value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '未知'
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date)
}

function summarizeTasks (rows) {
  const groups = new Map()
  const customers = new Set()
  const sourceOf = row => text(row.baseServer).replace(/\/+$/, '').replace(/\/api$/i, '')
  const idOf = row => text(row.customerId) || text(row.custId)
  const namedIds = new Map()
  rows.forEach(row => {
    const name = text(row.customerName)
    const id = idOf(row)
    if (!name || !id) return
    const key = JSON.stringify([sourceOf(row), name])
    if (!namedIds.has(key)) namedIds.set(key, new Set())
    namedIds.get(key).add(id)
  })
  for (const row of rows) {
    const incomplete = count(row.noDeclaredCount)
    const audit = count(row.auditCount)
    if (!incomplete && !audit) continue
    const source = sourceOf(row)
    const appName = text(row.appName) || '应用未标识'
    const key = JSON.stringify([source, appName])
    if (!groups.has(key)) groups.set(key, { source, appName, customers: new Set(), customerNames: new Set(), accounts: new Set(),
      rowCount: 0, dataCount: 0, auditCount: 0, missingCustomerRows: 0, missingAccountRows: 0 })
    const group = groups.get(key)
    const name = text(row.customerName)
    if (name) group.customerNames.add(name)
    const aliases = namedIds.get(JSON.stringify([source, name]))
    const id = idOf(row) || (aliases && aliases.size === 1 ? [...aliases][0] : '')
    const customer = id ? ['id', id] : name && (!aliases || aliases.size === 1) ? ['name', name] : null
    const customerKey = customer && JSON.stringify([source, ...customer])
    if (customerKey) { group.customers.add(customerKey); customers.add(customerKey) }
    else group.missingCustomerRows++
    const account = text(row.accountNumber || row.accNumber)
    if (account && customerKey) group.accounts.add(JSON.stringify([customerKey, account]))
    else group.missingAccountRows++
    group.rowCount++
    group.dataCount += incomplete
    group.auditCount += audit
  }
  const applications = [...groups.values()].map(group => ({ ...group,
    customerCount: group.customers.size, accountCount: group.accounts.size,
    customerNames: [...group.customerNames],
    customers: undefined, accounts: undefined }))
    .sort((a, b) => b.dataCount - a.dataCount || b.auditCount - a.auditCount || a.appName.localeCompare(b.appName, 'zh-CN'))
  return { applications, customerCount: customers.size,
    accountCount: applications.reduce((sum, group) => sum + group.accountCount, 0),
    dataCount: applications.reduce((sum, group) => sum + group.dataCount, 0),
    auditCount: applications.reduce((sum, group) => sum + group.auditCount, 0) }
}

function buildTaskExport (input = {}, now = new Date()) {
  if (!Array.isArray(input.rows) || input.rows.length > 100000 || input.rows.some(row => !row || typeof row !== 'object')) {
    throw new Error('导出任务格式错误或超过容量')
  }
  const summary = summarizeTasks(input.rows)
  const lines = [`合计：${summary.applications.length} 个应用，${summary.customerCount} 个客户，${summary.accountCount} 户，未完成数据 ${summary.dataCount} 条，审核中 ${summary.auditCount} 条。`,
    '任务明细：']
  if (summary.applications.length) lines.push(summary.applications.map(group =>
    `${group.appName}（${group.customerNames.join('、') || '客户名称未知'}）${group.accountCount} 户，未完成${group.dataCount} 条` +
    (group.auditCount ? `，审核中 ${group.auditCount} 条` : '')
  ).join('；') + '。')
  else lines.push('当前筛选范围内没有未完成任务。')
  lines.push('', `导出时间：${shanghaiTime(now)}（北京时间）`,
    `数据更新时间：${shanghaiTime(input.updatedAt)}（北京时间）`,
    `范围：当前页面已应用的筛选结果；${(input.filterLabels || []).map(text).filter(Boolean).join('；') || '无页面过滤'}`)
  if (input.warningCount > 0) lines.push(`注意：本次刷新有 ${count(input.warningCount)} 项加载提示，汇总可能不完整，请核对监控页面。`)
  if (input.refreshFailed) lines.push('注意：最近一次刷新失败，导出的是上次成功读取的数据。')
  summary.applications.forEach(group => {
    if (group.missingCustomerRows || group.missingAccountRows) {
      lines.push(`标识缺失（${group.appName}）：${group.missingCustomerRows} 条记录缺少客户，${group.missingAccountRows} 条记录无法确定申报户，相关去重数量可能偏少。`)
    }
  })
  return { content: '\ufeff' + lines.join('\r\n') + '\r\n',
    filename: 'RPA未完成任务汇总-' + shanghaiTime(now).replace(/[-: ]/g, '') + '.txt',
    applicationCount: summary.applications.length }
}

module.exports = { summarizeTasks, buildTaskExport }
