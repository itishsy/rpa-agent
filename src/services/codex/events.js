'use strict'
const { StringDecoder } = require('node:string_decoder')

function createEventReader(onEvent) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const consume = final => {
    const lines = pending.split('\n')
    pending = final ? '' : lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      if (line.length > 8 * 1024 * 1024) throw new Error('Codex 事件超过大小限制')
      let event
      try { event = JSON.parse(line) } catch (_) { throw new Error('Codex 返回了无效的 JSONL 事件') }
      if (event && typeof event.type === 'string') onEvent(event)
    }
    if (pending.length > 8 * 1024 * 1024) throw new Error('Codex 事件超过大小限制')
  }
  return {
    write(chunk) { pending += decoder.write(chunk); consume(false) },
    end() { pending += decoder.end(); consume(true) }
  }
}

function activity(event) {
  if (event.type === 'thread.started') return 'Codex 已启动，正在准备分析'
  if (event.type === 'turn.started') return 'Codex 正在分析当前流程'
  const item = event.item
  if (!item) return null
  if (item.type === 'mcp_tool_call') return event.type === 'item.completed'
    ? '工具处理结束，Codex 正在分析结果' : 'Codex 正在调用 ' + item.tool
  if (item.type === 'agent_message') return 'Codex 正在整理分析结论'
  if (item.type === 'reasoning') return 'Codex 正在分析流程与执行证据'
  if (item.type === 'todo_list') return 'Codex 正在更新调试计划'
  if (item.type === 'command_execution') return 'Codex 正在检查调试工作目录'
  return null
}

module.exports = { createEventReader, activity }
