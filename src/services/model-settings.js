'use strict'

// Persistence and secret retention belong to the main process settings handler.
function validateModelSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('AI 设置无效')
  const modelName = String(input.modelName || '').trim()
  const modelBaseUrl = String(input.modelBaseUrl || '').trim()
  if (modelName.length > 200) throw new Error('模型配置过长')
  if (modelBaseUrl) {
    let parsed
    try { parsed = new URL(modelBaseUrl) } catch (_) { throw new Error('大模型 API 地址无效') }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || modelBaseUrl.length > 2048) {
      throw new Error('大模型 API 地址无效')
    }
  }
  if (input.modelApiKey && String(input.modelApiKey).trim().length > 4096) throw new Error('模型 API Key 过长')
}

module.exports = { validateModelSettings }
