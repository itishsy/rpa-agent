'use strict'
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { engineSettings } = require('../services/codex/settings')
const { resolveCodexExecutable } = require('../services/codex/executable')
const { prepareCodexEnvironment } = require('../services/codex/environment')
const execute = promisify(execFile)

function registerEngineHandlers({ handle, ensureUser, assertIdle, getSettings, saveSettings, broadcast, getCacheDirectory }) {
  handle('engine:get', () => { ensureUser(); return engineSettings(getSettings().agentEngine) })
  handle('engine:save', input => {
    ensureUser(); assertIdle()
    const next = engineSettings(input), settings = getSettings(), previous = settings.agentEngine
    settings.agentEngine = next
    try { saveSettings() } catch (error) { settings.agentEngine = previous; throw error }
    broadcast(next)
    return next
  })
  handle('engine:check', async input => {
    ensureUser()
    const settings = engineSettings(input)
    const executable = resolveCodexExecutable(settings.codex.executable)
    const env = await prepareCodexEnvironment(getCacheDirectory(), settings.codex.homeDirectory)
    const options = { windowsHide: true, timeout: 10000, maxBuffer: 64000, env }
    const version = await execute(executable, ['--version'], options)
    try {
      await execute(executable, ['login', 'status'], options)
      return { executable, version: version.stdout.trim(), authenticated: true, message: 'Codex 已安装并已登录' }
    } catch (_) {
      const quote = value => "'" + value.replace(/'/g, "''") + "'"
      const login = `$env:CODEX_HOME = ${quote(env.CODEX_HOME)}; & ${quote(executable)} login`
      return { executable, version: version.stdout.trim(), authenticated: false, message: '请在 PowerShell 登录当前 Codex 环境，完成后重新检查：' + login }
    }
  })
}

module.exports = { registerEngineHandlers }
