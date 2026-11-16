(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.debugExecutionResult = api
})(globalThis, function () {
  const labels = { SUCCEEDED: '成功', FAILED: '失败', CANCELLED: '已停止', SKIPPED: '跳过', BRANCH: '分支跳转' }

  function executionSteps(result) {
    const trace = Array.isArray(result.trace) ? result.trace.filter(row => row && Object.hasOwn(labels, row.status)) : []
    const details = Array.isArray(result.details) ? result.details.filter(Boolean) : []
    if (trace.length && (!details.length || trace.some(row => row.status === 'SUCCEEDED' || row.status === 'FAILED'))) {
      return trace
    }
    return details.map(row => ({
      ...row, status: row.status === 1 || row.status === '1' ? 'SUCCEEDED'
        : row.status === 0 || row.status === '0' ? 'FAILED' : row.status
    }))
  }

  function conclusion(result, verification, rows = executionSteps(result)) {
    const status = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(result.status) ? result.status : 'UNKNOWN'
    const failed = rows.filter(row => row.status === 'FAILED')
    const succeeded = rows.filter(row => row.status === 'SUCCEEDED').length
    const matchingFailure = row => row.stepCode === result.failedStepCode &&
      (!result.failedFlowCode || row.flowCode === result.failedFlowCode)
    const failure = status === 'FAILED' && (failed.findLast(matchingFailure) || (!result.failedStepCode && failed.at(-1)))
    const step = failure?.stepName || result.failedStepCode
    const reason = result.error || result.message || failure?.message || failure?.error || failure?.errorStack
    const text = ['调试' + (labels[status] || '结果待确认')]
    if (status === 'FAILED' && step) text.push('失败步骤：' + step)
    if (status !== 'SUCCEEDED' && reason) text.push(String(reason).replace(/\s+/g, ' ').slice(0, 320))
    if (rows.length) text.push('步骤记录：成功 ' + succeeded + ' 次，失败 ' + failed.length + ' 次')
    if (status === 'SUCCEEDED' && verification) {
      text.push('业务核验：' + ({ VERIFIED: '通过', FAILED: '失败', PENDING: '待确认' }[verification.status] || '未确认'))
    }
    return { status, content: text.join(' · ') }
  }

  return { executionSteps, conclusion, statusLabel: status => labels[status] || '未知' }
})
