'use strict'
const { redact } = require('../../agent-core/store')
const { findRecordArray } = require('../../services/undeclared-monitor')
function localTime(date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date)
}
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object') {
    const secret = /password|passwd|secret|token|cookie|密码|令牌/i.test(String(value.argsKey || value.fieldKey || value.fieldName || ''))
    return redact(Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      secret && /^(argsValue|fieldValue|inputValue|value)$/.test(key) ? '[REDACTED]' : sanitize(item)])))
  }
  if (typeof value === 'string' && /^[\[{]/.test(value.trim())) { try { return sanitize(JSON.parse(value)) } catch (_) {} }
  return redact(value)
}
function bounded(value) { return JSON.stringify(sanitize(value)) }

function same(value, expected) { return String(value ?? '') === String(expected ?? '') }
function matchingExecution(item, row) {
  return same(item.appCode, row.appCode) && same(item.taskCode, row.taskCode) &&
    (!item.accountNumber || same(item.accountNumber, row.accountNumber)) && (!row.clientId || !item.clientId || same(item.clientId, row.clientId))
}
async function resolveTask(row, read) {
  if (row.appCode && row.taskCode) return row
  const data = await read('robot/app/client/list', { keyWord: row.appName, status: [], machineCode: '', clientId: row.clientId || null })
  const matches = findRecordArray(data, ['appCode', 'taskCode']).filter(item => item.appCode && item.taskCode && same(item.appName, row.appName) &&
    same(item.accountNumber || item.accNumber, row.accountNumber) && (!row.customerId || same(item.custId || item.customerId, row.customerId)))
  const unique = new Map(matches.map(item => [item.appCode + ':' + item.taskCode, item]))
  if (unique.size !== 1) throw new Error('任务缺少应用或任务编号，且无法按账户唯一定位；请核对任务配置')
  const task = [...unique.values()][0]
  return { ...row, appCode: task.appCode, taskCode: task.taskCode, clientId: task.clientId || row.clientId,
    machineCode: row.machineCode || task.machineCode, addrId: row.addrId || task.addrId, businessType: row.businessType || task.businessType }
}

module.exports = {localTime,bounded,sanitize,same,resolveTask,matchingExecution}
