'use strict'

const MODEL_REQUEST_TIMEOUT_MS = 300000

function completionUrl (base) {
  const parsed = new URL(base)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('模型 API 地址无效')
  if (parsed.pathname.replace(/\/$/, '').endsWith('/chat/completions')) return parsed.toString()
  parsed.pathname = parsed.pathname.replace(/\/$/, '') + '/chat/completions'
  return parsed.toString()
}

function networkFailure (error) {
  const detail = [error && error.message, error && error.cause && error.cause.code].join(' ')
  return /fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|UND_ERR_SOCKET/i.test(detail)
}

async function completeChat (settings, apiKey, input, fetcher = fetch, signal) {
  if (!settings.modelBaseUrl || !settings.modelName) throw new Error('请先在“设置 → 模型API设置”配置模型 API 地址和模型名称')
  if (!Array.isArray(input.messages) || input.messages.length < 2 || !Array.isArray(input.tools)) throw new Error('模型请求无效')
  const messages=input.messages.map(message=>{
    if(message.tool_calls==null||Array.isArray(message.tool_calls)&&!message.tool_calls.length){const clean={...message};delete clean.tool_calls;return clean}
    return message
  })
  const body = { model: settings.modelName, messages, tools: input.tools, tool_choice: 'auto' }
  if (input.finalOnly) { delete body.tools; body.tool_choice = 'none' }
  if (JSON.stringify(body).length > 3_000_000) throw new Error('对话上下文过大，请开启新对话')
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', abort, { once: true })
  }
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, MODEL_REQUEST_TIMEOUT_MS)
  try {
    const url = completionUrl(settings.modelBaseUrl)
    const options = { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body) }
    let response
    for (let attempt = 0; attempt < 2; attempt++) {
      try { response = await fetcher(url, options); break } catch (error) {
        if (attempt || !networkFailure(error) || controller.signal.aborted) throw error
        await new Promise(resolve => setTimeout(resolve, 400))
        if (controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
    }
    const raw = await response.text()
    if (!response.ok) throw new Error(`模型 API 返回 ${response.status}：${raw.slice(0, 500)}`)
    let data
    try { data = JSON.parse(raw) } catch (_) { throw new Error('模型 API 返回了无效 JSON') }
    const choice = data?.choices?.[0], message = choice?.message
    if (!message || (!message.content && !Array.isArray(message.tool_calls) && !message.refusal && !choice?.finish_reason)) throw new Error('模型 API 未返回有效消息')
    const finishReason = choice.finish_reason ?? null
    const completionStatus = message.refusal || choice.finish_reason === null ||
      (finishReason === 'stop' && (!message.content || message.tool_calls?.length)) ||
      (finishReason === 'tool_calls' && !message.tool_calls?.length) ? 'incomplete' : finishReason === null ? 'legacy'
      : ['stop', 'tool_calls'].includes(finishReason) ? 'complete' : 'incomplete'
    return { message: { role: 'assistant', content: message.content || '',
      ...(message.tool_calls!=null&&(!Array.isArray(message.tool_calls)||message.tool_calls.length)?{tool_calls:message.tool_calls}:{}) },
      finishReason, completionStatus, refusal: message.refusal || null, usage: data.usage || null }
  } catch (error) {
    if (signal && signal.aborted) throw new Error('本轮 Agent 已停止')
    if (timedOut) throw new Error('模型响应超时（已等待 300 秒），本轮请求已停止；请稍后继续修复，或切换响应更快的模型')
    if (networkFailure(error)) throw new Error('模型连接失败' +
      (error.cause && error.cause.code ? '（' + error.cause.code + '）' : '') +
      '，请检查“设置 → 模型API设置”中的 API 地址和网络连接')
    throw error
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', abort)
  }
}

module.exports = { completionUrl, completeChat, MODEL_REQUEST_TIMEOUT_MS }
