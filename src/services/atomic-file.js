'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

// Never reuse a temp file left behind by a crashed process or another instance.
function atomicWriteFileSync(target, data, options = {}) {
  const temporary = target + '.' + process.pid + '.' + randomUUID() + '.tmp'
  const retryable = new Set(['EPERM', 'EACCES', 'EBUSY'])
  const pause = new Int32Array(new SharedArrayBuffer(4))
  function retry(operation) {
    for (let attempt = 0; ; attempt++) {
      try { return operation() }
      catch (error) {
        if (!retryable.has(error.code) || attempt === 4) throw error
        Atomics.wait(pause, 0, 0, 25 * (attempt + 1))
      }
    }
  }
  let owned = false
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const fd = retry(() => fs.openSync(temporary, 'wx', options.mode ?? 0o600))
    owned = true
    try { fs.writeFileSync(fd, data, options); fs.fsyncSync(fd) }
    finally { fs.closeSync(fd) }
    retry(() => fs.renameSync(temporary, target))
  } catch (error) {
    if (retryable.has(error.code)) {
      const failure = new Error(`无法保存本地文件：${target}（${error.code}，${error.syscall || '文件操作'}）。当前进程被拒绝访问或文件被占用。请在系统设置中选择可写缓存目录后重启。原文件未被删除。`, { cause: error })
      failure.code = error.code
      throw failure
    }
    throw error
  } finally {
    if (owned) { try { fs.unlinkSync(temporary) } catch (_) { /* Best effort; never touch another writer's file. */ } }
  }
}
module.exports = { atomicWriteFileSync }
