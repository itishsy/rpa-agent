(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.debugExecutionResult = api
})(globalThis, function () {
  const labels = { SUCCEEDED: '成功', FAILED: '失败', IGNORED: '忽略', CANCELLED: '已停止', SKIPPED: '跳过', BRANCH: '分支跳转' }

  function executionSteps(result) {
    const trace = Array.isArray(result.trace) ? result.trace.filter(row => row && Object.hasOwn(labels, row.status)) : []
    const details = Array.isArray(result.details) ? result.details.filter(Boolean) : []
    if (trace.length && (!details.length || trace.some(row => ['SUCCEEDED', 'FAILED', 'IGNORED'].includes(row.status)))) {
      return trace
    }
    return details.map(row => ({
      ...row, status: row.status === 1 || row.status === '1' ? 'SUCCEEDED'
        : row.status === 0 || row.status === '0' ? 'FAILED' : row.status
    }))
  }

  function conclusion(result, rows = executionSteps(result)) {
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
    if (status !== 'SUCCEEDED') text.push(reason ? String(reason).replace(/\s+/g, ' ').slice(0, 320) :
      status === 'CANCELLED' ? '执行已中断' : '执行器未提供具体原因')
    const ignored = rows.filter(row => row.status === 'IGNORED').length
    if (rows.length) text.push('步骤记录：成功 ' + succeeded + ' 次，失败 ' + failed.length + ' 次' + (ignored ? '，忽略 ' + ignored + ' 次' : ''))
    return { status, content: text.join(' · ') }
  }

  function displaySteps(result, dsl = result.dsl) {
    const steps = []
    function indexSteps(list, flowCode) {
      for (const step of list || []) {
        if (!step) continue
        steps.push({ step, flowCode })
        for (const field of ['body', 'children', 'list']) indexSteps(step[field], flowCode)
      }
    }
    function indexFlow(flow) {
      if (!flow) return
      indexSteps(flow.steps, flow.flowCode)
      for (const child of flow.subflows || []) indexFlow(child)
    }
    indexFlow(dsl)
    return executionSteps(result).map(row => {
      if (!['FAILED', 'IGNORED'].includes(row.status)) return row
      const matches = row.stepCode ? steps.filter(item => item.step.stepCode === row.stepCode &&
        (!row.flowCode || item.flowCode === row.flowCode)) : []
      const strategy = row.failedStrategy ?? (matches.length === 1 ? matches[0].step.failedStrategy : undefined)
      if (row.status !== 'IGNORED' && strategy !== 1 && strategy !== '1') return row
      return { ...row, status: 'IGNORED', message: '', error: '', errorStack: '' }
    })
  }

  return { executionSteps, displaySteps, conclusion, statusLabel: status => labels[status] || '未知' }
})
