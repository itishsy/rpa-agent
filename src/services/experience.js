'use strict'
const { redact } = require('../agent/store')

function scrubExperience(value) {
  const safe = redact(value)
  const scrub = item => {
    if (Array.isArray(item)) return item.map(scrub)
    if (!item || typeof item !== 'object') return item
    const result = {}
    for (const [key, content] of Object.entries(item)) {
      if (/^(?:actionArgs|targetArgs)$/.test(key) && typeof content === 'string') {
        try { result[key] = scrub(JSON.parse(content)) } catch (_) { result[key] = '[REDACTED]' }
      } else if (/^(?:inputValue|password|passwd|token|cookie|authorization|requestBody|script|code|sourceCode|body|filePath|fileContent)$/i.test(key) && !(key === 'body' && Array.isArray(content))) {
        result[key] = '[REDACTED]'
      } else if (key === 'fieldValue') {
        // Preserve variable references, not literal customer data from argument VOs.
        result[key] = typeof content === 'string' && /^(?:\$\{[^}]+\}|ctx\.[\w.]+)$/.test(content) ? content : '[REDACTED]'
      } else result[key] = scrub(content)
    }
    return result
  }
  return scrub(safe)
}

async function collectExperience({ request, signal, progress = () => {}, concurrency = 4 }) {
  const apps = new Map(), errors = [], seen = new Set()
  const check = () => { if (signal?.aborted) throw new Error('经验导出已停止，旧目录保留') }
  for (let page = 1; page <= 10000; page++) {
    check()
    const data = await request({ path: 'robot/app/page', body: { page, start: (page - 1) * 50, size: 50, query: [] }, signal })
    const rows = Array.isArray(data) ? data : data?.rows || data?.records
    if (!Array.isArray(rows)) throw new Error('应用分页格式无效，旧目录保留')
    const signature = rows.map(item => item.appCode).join('\0')
    if (rows.length && seen.has(signature)) throw new Error('平台重复返回同一页，旧目录保留')
    seen.add(signature)
    for (const row of rows) if (row.appCode) apps.set(row.appCode, row)
    progress({ phase: 'applications', count: apps.size })
    const total = Number(data.total ?? data.recordsTotal)
    if (!rows.length || Number.isFinite(total) && apps.size >= total || rows.length < 50) break
    if (page === 10000) throw new Error('应用分页超过上限')
  }
  if (!apps.size) throw new Error('没有可读取的应用，旧目录保留')
  const pending = [...apps.values()], flows = []
  let completed = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (pending.length) {
      check()
      const app = pending.shift()
      try {
        const list = await request({ path: 'robot/flow/list', body: { appCode: app.appCode }, signal })
        if (!Array.isArray(list)) throw new Error('流程列表格式无效')
        for (const flow of list) {
          check()
          try {
            let current = flow, steps = [], chain = new Set()
            while (current) {
              if (chain.has(current.flowCode)) throw new Error('循环引用流程')
              chain.add(current.flowCode)
              steps = await request({ path: 'robot/flow/step/list/' + encodeURIComponent(current.flowCode), signal })
              if (!Array.isArray(steps)) throw new Error('步骤返回格式无效')
              if (steps.length || !current.relationFlowCode) break
              current = await request({ path: 'robot/client/app/getByFlowCode/' + encodeURIComponent(current.relationFlowCode), signal })
              if (!current?.flowCode) throw new Error('引用流程不存在')
            }
            flows.push(scrubExperience({ ...flow, appCode: app.appCode, appName: app.appName,
              appArgs: app.appArgs, status: 'UNVERIFIED_REFERENCE', sourceAt: new Date().toISOString(), steps }))
          } catch (error) { check(); errors.push({ appCode: app.appCode, flowCode: flow.flowCode, error: error.message }) }
        }
      } catch (error) { check(); errors.push({ appCode: app.appCode, error: error.message }) }
      progress({ phase: 'flows', completed: ++completed, applications: apps.size, flowCount: flows.length, errors: errors.length })
    }
  }))
  check()
  if (!flows.length) throw new Error('没有读取到流程，旧目录保留')
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), status: errors.length ? 'PARTIAL' : 'COMPLETE',
    report: { applications: apps.size, completed, flowCount: flows.length, errors }, flows }
}
module.exports = { collectExperience, scrubExperience }
