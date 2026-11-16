'use strict'
const { executorKey } = require('./control')
class ExecutorLeases {
  constructor() { this.owners = new Map(); this.quarantines = new Map() }
  acquire(executor, sessionId) {
    const key = executorKey(executor)
    // Interrupted execution records are diagnostic only; active requests still hold a lease.
    if (this.owners.has(key)) throw new Error('该执行器已有任务，等待结束或停止后重试')
    const owner = { sessionId }
    this.owners.set(key, owner)
    return () => { if (this.owners.get(key) === owner) this.owners.delete(key) }
  }
  quarantine(executor, sessionId) {
    const key = executorKey(executor), owners = this.quarantines.get(key) || new Set()
    owners.add(sessionId); this.quarantines.set(key, owners)
  }
}

module.exports = { ExecutorLeases }
