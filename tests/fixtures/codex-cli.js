'use strict'
const fs = require('node:fs')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')

async function main() {
  const args = process.argv.slice(2), config = {}
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '-c') {
      const value = args[++index], separator = value.indexOf('=')
      config[value.slice(0, separator)] = JSON.parse(value.slice(separator + 1))
    }
  }
  const output = event => process.stdout.write(JSON.stringify(event) + '\n')
  const scenario = process.env.RPA_CODEX_FIXTURE_CASE
  let prompt = ''
  for await (const chunk of process.stdin) prompt += chunk
  if (!prompt.includes('get_flow_context')) throw new Error('missing task prompt')
  output({ type: 'thread.started', thread_id: 'fixture-thread' })
  output({ type: 'turn.started' })
  if (scenario === 'auth-required') throw new Error('unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses')
  if (scenario === 'hang') { setInterval(() => {}, 1000); return }
  if (scenario === 'invalid-jsonl') { process.stdout.write('invalid event\n'); setInterval(() => {}, 1000); return }
  if (scenario === 'exit-without-terminal') return
  const client = new Client({ name: 'codex-fixture', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(config['mcp_servers.rpa_agent.url']), {
    requestInit: { headers: { Authorization: 'Bearer ' + process.env.RPA_AGENT_MCP_TOKEN } }
  })
  await client.connect(transport)
  const tools = (await client.listTools()).tools.map(tool => tool.name)
  if (tools.includes('run_proposed_dsl')) throw new Error('candidate validation is outside phase one')
  const call = async (name, arguments_ = {}) => {
    output({ type: 'item.started', item: { id: name, type: 'mcp_tool_call', tool: name, status: 'in_progress' } })
    const result = await client.callTool({ name, arguments: arguments_ })
    output({ type: 'item.completed', item: { id: name, type: 'mcp_tool_call', tool: name, status: result.isError ? 'failed' : 'completed' } })
    if (result.isError) throw new Error(result.content[0].text)
    return { value: JSON.parse(result.content[0].text), content: result.content }
  }
  const { value: context } = await call('get_flow_context')
  if (scenario === 'stop-during-tool') { await call('run_current_dsl'); return }
  let evidenceId = null, executionStatus = 'NOT_RUN'
  const generating = scenario === 'generate' || scenario === 'generate-tool-budget'
  if (!generating) {
    const { value: executed } = await call('run_current_dsl')
    evidenceId = executed.artifactId; executionStatus = executed.status
    const screenshot = await call('inspect_step_evidence', { snapshotIndex: 0, screenshot: true })
    if (!screenshot.content.some(block => block.type === 'image' && block.mimeType === 'image/png')) throw new Error('screenshot missing from MCP result')
    if (scenario === 'repeat-execution') await call('run_current_dsl')
  } else if (tools.includes('run_current_dsl')) throw new Error('generation mode exposed execution')
  let proposal
  if (scenario === 'generate-tool-budget') {
    for (let index = 0; index < 3; index++) await call('get_flow_context')
  } else {
    const staged = await call('propose_dsl_patch', { baseRevision: context.revision,
      operations: [{ op: 'set', stepCode: 's', field: 'stepName', value: '候选修复步骤' }] })
    proposal = staged.value
  }
  if (scenario.includes('tool-budget')) {
    for (let index = 0; index < 2; index++) {
      const denied = await client.callTool({ name: 'get_flow_context', arguments: {} })
      if (!denied.isError || !denied.content[0].text.includes('TOOL_BUDGET')) throw new Error('missing graceful budget result')
    }
    if (scenario === 'tool-budget-hang') {
      await client.close()
      setInterval(() => {}, 1000)
      return
    }
    if (scenario === 'tool-budget-no-report') {
      await client.close()
      throw new Error('fixture failed before report')
    }
  }
  await client.close()
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({
    summary: proposal ? '已读取证据并生成候选补丁' : '已有材料不足以确认定位，请补充失败页面的元素信息', cause: '请核对页面定位', executionStatus,
    evidenceIds: evidenceId ? [evidenceId] : [], candidateId: scenario === 'bad-report' ? 'fabricated' : proposal?.id || null,
    validationStatus: 'NOT_RUN', remainingIssues: []
  }))
  output({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 10 } })
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
