'use strict'
const { clone } = require('./store')

// Pair within each assistant batch, not across the entire conversation: providers
// can reuse a call id in a later turn. This is a prompt projection, never a replay.
function normalizeHistory(history) {
  const result = []
  for (let index = 0; index < history.length; index++) {
    const message = history[index]
    if (message.role === 'tool') continue
    const item = clone(message)
    delete item.inputId
    if(item.tool_calls==null||Array.isArray(item.tool_calls)&&!item.tool_calls.length)delete item.tool_calls
    result.push(item)
    if (item.role !== 'assistant' || !item.tool_calls?.length) continue
    const outputs = new Map()
    while (history[index + 1]?.role === 'tool') {
      const output = history[++index]
      if (!outputs.has(output.tool_call_id)) outputs.set(output.tool_call_id, output)
    }
    const ids = new Set()
    item.tool_calls = item.tool_calls.filter(call => call?.id && !ids.has(call.id) && ids.add(call.id))
    const calls=item.tool_calls
    if(!calls.length)delete item.tool_calls
    for (const call of calls) result.push(outputs.has(call.id) ? clone(outputs.get(call.id)) : {
      role: 'tool', tool_call_id: call.id,
      content: JSON.stringify({ error: '调用中断，执行状态需核对；不会自动重放', code: 'INTERRUPTED' })
    })
  }
  return result
}

function validateModelMessage(message, usedIds) {
  if (!message || message.role !== 'assistant' || (message.content != null && typeof message.content !== 'string') ||
      (message.tool_calls !== undefined && !Array.isArray(message.tool_calls))) throw new Error('模型响应结构无效')
  const calls = message.tool_calls || []
  if (calls.length > 16) throw new Error('单次模型返回过多工具调用')
  const seen = new Set()
  for (const call of calls) {
    if (typeof call.id !== 'string' || !call.id || call.id.length > 200 || call.type !== 'function' ||
        !call.function || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') throw new Error('模型工具调用结构无效')
    if (usedIds.has(call.id) || seen.has(call.id)) throw new Error('模型重复使用本轮 callId，已拒绝执行：' + call.id)
    seen.add(call.id)
  }
  for (const id of seen) usedIds.add(id)
  return calls
}
function closePendingTail(messages) {
  const index = messages.findLastIndex(item => item.role === 'assistant')
  const calls = messages[index]?.tool_calls || []
  const outputs = new Set(messages.slice(index + 1).filter(item => item.role === 'tool').map(item => item.tool_call_id))
  for (const call of calls) if (!outputs.has(call.id)) messages.push({ role: 'tool', tool_call_id: call.id,
    content: JSON.stringify({ error: '调用中断，不自动重放；执行结果需核对', code: 'INTERRUPTED' }) })
}
module.exports = { normalizeHistory, validateModelMessage, closePendingTail }
