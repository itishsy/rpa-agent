'use strict'
const { spawn, execFile } = require('node:child_process')
const { createEventReader } = require('./events')

function stopProcess(child) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, error => {
      if (error && child.exitCode === null) child.kill('SIGKILL')
    })
  } else child.kill('SIGTERM')
}

function executeCodex({ executable, args, cwd, env, prompt, signal, onEvent, spawnProcess = spawn }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(Object.assign(new Error('Codex 已停止'), { code: 'CANCELLED' })); return }
    let child
    try { child = spawnProcess(executable, args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }) }
    catch (error) { reject(error); return }
    let stderr = '', failure, completed = false
    const reader = createEventReader(event => {
      if (event.type === 'turn.completed') completed = true
      if (event.type === 'turn.failed') failure = new Error(event.error?.message || 'Codex 本轮执行失败')
      onEvent(event)
    })
    const fail = error => { failure ||= error; stopProcess(child) }
    const abort = () => fail(Object.assign(new Error('Codex 已停止'), { code: 'CANCELLED' }))
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => { try { reader.write(chunk) } catch (error) { fail(error) } })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-6000) })
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') fail(error) })
    child.once('error', error => { failure ||= new Error('Codex 启动失败：' + error.message) })
    child.once('close', code => {
      signal.removeEventListener('abort', abort)
      try { reader.end() } catch (error) { failure ||= error }
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error('Codex 退出码 ' + code + '：' + stderr.slice(-2000)))
      else if (!completed) reject(new Error('Codex 已退出，但未返回本轮完成事件；请查看已保存的执行证据'))
      else resolve()
    })
    child.stdin.end(prompt)
    if (signal.aborted) abort()
  })
}

module.exports = { executeCodex, stopProcess }
