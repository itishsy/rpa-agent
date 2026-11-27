'use strict'
const { executionSteps, statusLabel } = require('../../shared/debug-execution-result')

const elementMissing = /NoSuchElement|no such element|unable to locate element|找不到元素|未找到元素|无法定位元素|元素不存在/i

function shortError(value) {
  return (typeof value === 'string' ? value : value?.message || '')
    .split(/\r?\n|\s+at\s+\S+\(|\s*\(Session info:/i, 1)[0].trim().slice(0, 100)
}

function summarizeDebugRun(result) {
  const status = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(result.status) ? result.status : 'UNKNOWN'
  const title = status === 'UNKNOWN' ? '调试结果待确认' : '调试' + statusLabel(status)
  if (status === 'SUCCEEDED') return { status, content: title }
  if (status !== 'FAILED') {
    const reason = shortError(result.error || result.message) ||
      (status === 'CANCELLED' ? '本次执行已中断' : '未收到执行器的最终结果')
    return { status, content: title + ' · ' + reason }
  }

  const rows = executionSteps(result)
  const failureIndex = rows.findLastIndex(row => row.status === 'FAILED' &&
    (!result.failedStepCode || row.stepCode === result.failedStepCode) &&
    (!result.failedFlowCode || row.flowCode === result.failedFlowCode))
  const failure = rows[failureIndex]
  const stepName = failure?.stepName || result.failedStepCode
  const stepError = failure?.message || failure?.error || failure?.errorStack
  const error = shortError(stepError || result.error || result.message)
  const unitSelection = /选择.*(?:账户|账号|单位)/.test(stepName || '')
  const missing = elementMissing.test(shortError(stepError)) || elementMissing.test(shortError(result.error || result.message))
  const reason = missing ? (unitSelection ? '未找到目标单位选项' : '未找到目标页面元素') :
    error || '执行器未提供具体失败原因'
  const priorSteps = rows.slice(0, Math.max(0, failureIndex))
  const certificateFailure = unitSelection && priorSteps.findLast((row, index) =>
    row.status === 'FAILED' && row.flowCode === failure?.flowCode &&
    (row.actionCode === 'caCertActivate' ||
      /Windows\s*安全中心|证书|\bCA\b/i.test([row.stepName, row.message, row.error].join(' '))) &&
    !priorSteps.slice(index + 1).some(later => later.status === 'SUCCEEDED' &&
      later.stepCode === row.stepCode && later.flowCode === row.flowCode))
  const hint = certificateFailure && (certificateFailure.actionCode === 'caCertActivate'
    ? '此前 CA 证书激活失败，可能影响单位选项加载。'
    : '此前证书确认操作失败，需核实 CA 是否被识别及单位列表是否加载。')

  const content = [title + (stepName ? ' · ' + stepName : '') + '。' + reason.replace(/[。！？]+$/, '') + '。']
  if (hint) content.push('中断分析：' + hint)
  else if (unitSelection && missing) content.push('中断分析：需核实单位列表是否已加载，以及单位名称是否匹配。')
  return { status, content: content.join('\n') }
}

module.exports = { summarizeDebugRun }
