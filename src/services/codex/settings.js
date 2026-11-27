'use strict'
const path = require('node:path')

function codexSettings(value = {}) {
  const executable = String(value.executable || '').trim()
  const homeDirectory = String(value.homeDirectory || '').trim()
  if (homeDirectory && (!path.isAbsolute(homeDirectory) || homeDirectory.length > 4096 || /[\r\n\0]/.test(homeDirectory))) throw new Error('请填写 Codex 数据目录的绝对路径')
  const model = String(value.model || '').trim()
  const effort = value.effort || 'medium'
  const timeoutSeconds = value.timeoutSeconds === undefined ? 900 : Number(value.timeoutSeconds)
  if (executable.length > 4096 || model.length > 200 || /[\r\n\0]/.test(executable + model)) throw new Error('Codex 配置无效')
  if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error('Codex 推理强度无效')
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600) throw new Error('Codex 超时应为30至3600秒')
  return { executable, homeDirectory, model, effort, timeoutSeconds }
}

function engineSettings(value = {}) {
  const engine = value.engine || 'model-api'
  if (!['model-api', 'codex-cli'].includes(engine)) throw new Error('未知 Agent 引擎')
  return { engine, codex: codexSettings(value.codex) }
}

module.exports = { codexSettings, engineSettings }
