'use strict'

const { execFile, spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')
const ROOT = 'D:\\seebon\\rpa'

function getExecutorService() {
  return require('./executor-service')
}

async function localProcessStatus() {
  const script = "$ErrorActionPreference='Stop'; try { $java=@(Get-CimInstance Win32_Process -Filter \"Name='java.exe' OR Name='javaw.exe'\"); $robot=@($java | Where-Object { $_.ExecutablePath -like 'D:\\seebon\\rpa\\*' -and $_.CommandLine -match 'rpa-robot[^\\s]*\\.jar' }); if ($robot.Count -gt 0) { 'running' } elseif (@($java | Where-Object { !$_.ExecutablePath -or !$_.CommandLine }).Count -gt 0) { 'unknown' } else { 'stopped' }; exit 0 } catch { exit 1 }"
  const result = await new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      resolve(error ? 'unknown' : String(stdout).trim())
    })
  })
  if (result === 'stopped') return { status: -1, text: '已停止' }
  if (result === 'running') return { status: 2, text: '未连接（执行器进程仍在运行）' }
  return { status: -2, text: '状态未知（无法查询执行器进程）' }
}

function connectedStatus(response) {
  let status = response && Object.prototype.hasOwnProperty.call(response, 'data') ? response.data : response
  if (status && typeof status === 'object' && Object.prototype.hasOwnProperty.call(status, 'status')) status = status.status
  status = Number(status)
  if (status === 0) return { status, text: '准备就绪' }
  if (status === 1) return { status, text: '运行中' }
  if (status === -1) return { status, text: '已停止' }
  return { status: -2, text: '状态未知（执行器返回异常）' }
}

async function disconnectedStatus(baseUrl) {
  if (!baseUrl) return localProcessStatus()
  const service = getExecutorService()
  const normalized = service.normalizeBaseUrl(baseUrl)
  try {
    const response = await service.request(normalized, {
      path: '/api/robot/start/status', method: 'GET', timeout: 2000
    })
    return connectedStatus(response)
  } catch (error) {
    if (service.isLocalBaseUrl(normalized)) return localProcessStatus()
    return { status: -1, text: `连接失败：${error && error.message ? error.message : '无法连接远程执行器'}` }
  }
}

function running() {
  return new Promise(resolve => {
    const req = http.get('http://127.0.0.1:9090/api/robot/start/status', { timeout: 1000 }, res => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })
}

async function stop() {
  if (process.platform !== 'win32') throw new Error('执行器仅支持 Windows')
  // 仅停止安装目录下的执行器 Java 进程，不影响其他 Java 应用。
  const script = "$ErrorActionPreference='Stop'\ntry {\n  $targets=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^javaw?\\.exe$' -and $_.ExecutablePath -like 'D:\\seebon\\rpa\\*' -and $_.CommandLine -match 'rpa-robot[^\\s]*\\.jar' })\n  foreach ($target in $targets) {\n    $robotProcess = Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue\n    if (!$robotProcess) { continue }\n    try {\n      Stop-Process -InputObject $robotProcess -Force -ErrorAction Stop\n    } catch {\n      if (Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue) { throw }\n    }\n    if (!$robotProcess.WaitForExit(15000)) { throw 'Executor did not stop within 15 seconds' }\n  }\n  exit 0\n} catch {\n  [Console]::Error.WriteLine($_.Exception.Message)\n  exit 1\n}"
  await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = error.code === 'ENOENT' ? '找不到 Windows PowerShell' :
          error.killed ? '停止命令执行超时（30 秒）' :
          String(stderr || '').trim().slice(0, 1500) || '停止命令退出码：' + error.code
        reject(new Error('停止执行器失败：' + detail))
      } else resolve()
    })
  })
  if (await running()) throw new Error('执行器仍在运行，已取消切换')
}

async function start(debugToken) {
  const startup = path.join(ROOT, 'startup.bat')
  if (!fs.existsSync(startup)) throw new Error('执行器启动脚本不存在')
  const env = debugToken ? { ...process.env, RPA_DEBUG_ACCESS_TOKEN: debugToken } : process.env
  const child = spawn('cmd.exe', ['/d', '/c', startup], { cwd: ROOT, windowsHide: true, stdio: 'ignore', env })
  let failure
  child.on('error', () => { failure = new Error('无法启动执行器') })
  child.on('exit', code => { if (code !== 0) failure = new Error('执行器启动进程异常退出') })
  for (let i = 0; i < 60; i++) {
    if (failure) throw failure
    if (await running()) return
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  await stop()
  throw new Error('执行器启动超时，已停止本次启动的执行器，请检查执行器日志')
}

module.exports = { stop, start, disconnectedStatus }