'use strict'
function stopped(reason = '本轮已停止') { return Object.assign(new Error(reason), { code: 'CANCELLED' }) }
function checkpoint(signal) { if (signal?.aborted) throw stopped() }
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(stopped()) }
    const cleanup = () => signal?.removeEventListener('abort', abort)
    // Attach both handlers even when already aborted, to absorb late rejections.
    Promise.resolve(promise).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}
function executorKey(executor) {
  const url = new URL(executor)
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) url.hostname = '127.0.0.1'
  return url.origin
}
function authority(session, tool, args) {
  return { tool: tool.name, args, revision: session.revision, scope: session.scope,
    dsl: session.dsl, proposal: session.proposal || null, taskCode: session.taskCode || null,
    rules: session.rules || [] }
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
module.exports = { checkpoint, abortable, executorKey, authority, stopped, freeze }
