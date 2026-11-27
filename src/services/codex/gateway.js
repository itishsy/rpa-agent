'use strict'
const { digest } = require('../../agent-core/store')
const { checkpoint } = require('../../agent-core/control')
const { createMcpBridge } = require('../mcp')
const { toolContent } = require('./mcp-content')

async function startGateway({ session, turn, runner, onBudgetExhausted, bridgeFactory = createMcpBridge }) {
  const policy = runner.profile.modePolicy(turn.mode)
  const tools = new Map([...runner.registry.tools].filter(([name, tool]) =>
    policy.effects.includes(tool.effect) && (tool.effect !== 'execute' || name === 'run_current_dsl')))
  const baseline = digest({ scope: session.scope, taskCode: session.taskCode, revision: session.revision, dsl: session.dsl })
  let queue = Promise.resolve(), closed = false
  const bridge = bridgeFactory({ registry: { tools }, invoke: (name, args, signal) => {
    let settled = false
    const disconnect = () => { if (!settled) runner.stop(session, 'transport').catch(() => {}) }
    signal.addEventListener('abort', disconnect, { once: true })
    const operation = queue.then(async () => {
      checkpoint(turn.controller.signal)
      if (closed || runner.active.get(session.id) !== turn || !tools.has(name)) throw new Error('Codex 任务或工具授权已失效')
      if (digest({ scope: session.scope, taskCode: session.taskCode, revision: session.revision, dsl: session.dsl }) !== baseline) throw new Error('流程或申报账户已变化，请重新发起 Codex 调试')
      if (turn.tools >= runner.budgets.toolCalls) {
        if (!turn.toolBudgetExhausted) {
          turn.toolBudgetExhausted = true
          session.turn.toolBudgetExhausted = true
          runner.event(session, 'engine/activity', { text: '调查次数已达上限，正在根据已有证据整理结论' })
          onBudgetExhausted?.()
        }
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({
          code: 'TOOL_BUDGET', error: '本轮工具调用次数已达上限，本次工具未执行。停止调用工具，依据已有结果输出最终 JSON 报告，给出结论、修改建议及待确认项。'
        }) }] }
      }
      const output = await runner.invoke(session, name, args, turn)
      const result = toolContent(name, args, output, { session, runner })
      const remaining = runner.budgets.toolCalls - turn.tools
      if (remaining <= 8) result.content.push({ type: 'text', text: JSON.stringify({
        remainingToolCalls: remaining,
        instruction: '本轮调查即将结束。只进行必要的定向核验；有充分证据时立即提交候选补丁，然后输出最终 JSON 报告。次数耗尽后仍需根据已有材料给出结论和建议。'
      }) })
      return result
    })
    queue = operation.catch(error => {
      if (['EXECUTION_BUDGET', 'RESULT_PERSISTENCE', 'EXECUTOR_DEBUG_AUTH'].includes(error.code)) {
        turn.fatalToolError = error
        runner.stop(session, 'tool-failed').catch(() => {})
      }
    })
    return operation.finally(() => { settled = true; signal.removeEventListener('abort', disconnect) })
  }, formatResult: value => value })
  try {
    const connection = await bridge.start()
    return { ...connection, tools: [...tools.keys()], async close() { closed = true; await bridge.stop(); await queue } }
  } catch (error) { await bridge.stop(); throw error }
}

module.exports = { startGateway }
