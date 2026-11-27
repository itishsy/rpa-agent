'use strict'
let engineSettingsRequest = 0
function engineSettingsError(error) { return String(error.message).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') }

function usingCodexEngine() { return $('composerEngine').value === 'codex-cli' }
function updateEngineControls() {
  const codex = usingCodexEngine()
  $('composerModel').hidden = codex
  $('composerEngine').title = codex ? 'Codex CLI 引擎，使用本机 Codex 登录' : '模型 API 引擎'
  if (typeof updateComposerMode === 'function') updateComposerMode()
}
function populateEngineSettings(value) {
  $('composerEngine').value = value.engine
  $('defaultAgentEngine').value = value.engine
  $('codexExecutable').value = value.codex.executable || ''
  $('codexHomeDirectory').value = value.codex.homeDirectory || ''
  $('codexModel').value = value.codex.model || ''
  $('codexEffort').value = value.codex.effort || 'medium'
  $('codexTimeout').value = value.codex.timeoutSeconds || 900
  updateEngineControls()
}
async function loadEngineSettings() {
  const request = ++engineSettingsRequest
  const value = await invoke('engine:get')
  if (request === engineSettingsRequest) { populateEngineSettings(value); $('agentEngineMessage').textContent = '' }
}
function engineSettingsInput() {
  return { engine: $('defaultAgentEngine').value, codex: {
    executable: $('codexExecutable').value, homeDirectory: $('codexHomeDirectory').value, model: $('codexModel').value,
    effort: $('codexEffort').value, timeoutSeconds: Number($('codexTimeout').value)
  } }
}
$('composerEngine').onchange = updateEngineControls
$('saveAgentEngine').onclick = async () => {
  $('saveAgentEngine').disabled = true
  $('agentEngineMessage').textContent = '正在保存…'
  try {
    populateEngineSettings(await invoke('engine:save', engineSettingsInput()))
    $('agentEngineMessage').textContent = '引擎设置已保存。'
  } catch (error) { $('agentEngineMessage').textContent = engineSettingsError(error) }
  finally { $('saveAgentEngine').disabled = false }
}
$('checkCodex').onclick = async () => {
  $('checkCodex').disabled = true
  $('agentEngineMessage').textContent = '正在检查 Codex 安装与登录状态…'
  try {
    const value = await invoke('engine:check', engineSettingsInput())
    $('agentEngineMessage').textContent = [value.version, value.message, value.executable].join(' · ')
  } catch (error) { $('agentEngineMessage').textContent = engineSettingsError(error) }
  finally { $('checkCodex').disabled = false }
}
desktop.on('engine:changed', populateEngineSettings)
document.addEventListener('user-authenticated', () => loadEngineSettings().catch(error => notice(error.message, true)))
desktop.on('auth:changed', user => {
  if (!user) { engineSettingsRequest++; populateEngineSettings({ engine: 'model-api', codex: {} }) }
})
