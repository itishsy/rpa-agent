'use strict'
// Runs the installed native Codex against a loopback Responses fixture and mock RPA tools.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const zlib = require('node:zlib')
const assert = require('node:assert/strict')
const { Harness } = require('../src/agent/harness')
const { SessionStore } = require('../src/agent-core/store')
const { createTools } = require('../src/agent/tools')
const { createCodexEngine } = require('../src/services/codex/engine')
const { executeCodex } = require('../src/services/codex/process')

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-'))
  const isolatedHome = path.join(directory, 'codex-home')
  fs.mkdirSync(isolatedHome)
  const store = new SessionStore(path.join(directory, 'sessions'), { encrypt: text => text, decrypt: text => text })
  const session = store.create({ executor: 'http://localhost:9090', appCode: 'app', flowCode: 'flow' },
    { appCode: 'app', flowCode: 'flow', steps: [{ stepCode: 's', stepName: '原步骤', actionCode: 'page' }] })
  session.taskCode = 'task'
  let executions = 0, requests = 0, lastOutputs = [], receivedImage = false, toolCatalog = []
  const runner = new Harness({ store, complete: () => assert.fail('API engine was invoked'), registry: createTools({
    tasks: async () => [{ taskCode: 'task' }], bundle: async (_, dsl) => dsl,
    commands: async () => ({ oldSteps: [], items: [{ actionCode: 'page', actionName: '页面', actionArgsVOS: [], targetArgsVOS: [] }] }),
    execute: async () => { executions++; return { status: 'FAILED', executionCode: 'native-fixture', error: '定位未找到',
      snapshots: [{ screenshots: { items: [{ contentType: 'image/png', base64: fs.readFileSync(path.join(__dirname, '../src/assets/app.png')).toString('base64') }] } }] } }
  }) })
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      let bytes = Buffer.concat(chunks)
      if (req.headers['content-encoding'] === 'zstd') bytes = zlib.zstdDecompressSync(bytes)
      if (req.headers['content-encoding'] === 'gzip') bytes = zlib.gunzipSync(bytes)
      const body = JSON.parse(bytes.toString())
      receivedImage ||= JSON.stringify(body.input).includes('"type":"input_image"')
      lastOutputs = (body.input || []).filter(item => item.type === 'function_call_output').map(item => ({ call_id: item.call_id, output: item.output }))
      assert.ok(body.tools)
      if (requests === 0) toolCatalog = body.tools.filter(tool => JSON.stringify(tool).includes('rpa_agent')).map(tool => ({ type: tool.type, name: tool.name, tools: tool.tools?.map(item => item.name) }))
      const index = requests++
      const items = [
        { type: 'function_call', call_id: 'read', name: 'mcp__rpa_agent__get_flow_context', arguments: '{}' },
        { type: 'function_call', call_id: 'run', name: 'mcp__rpa_agent__run_current_dsl', arguments: '{}' },
        { type: 'function_call', call_id: 'image', name: 'mcp__rpa_agent__inspect_step_evidence', arguments: '{"snapshotIndex":0,"screenshot":true}' },
        { type: 'function_call', call_id: 'patch', name: 'mcp__rpa_agent__propose_dsl_patch', arguments: JSON.stringify({
          baseRevision: 0, operations: [{ op: 'set', stepCode: 's', field: 'stepName', value: '原生 CLI 候选' }] }) }
      ]
      const report = { summary: '本机 Codex 协议验证完成', cause: '定位待核对', executionStatus: 'FAILED',
        evidenceIds: session.runs.map(run => run.artifactId), candidateId: session.proposal?.id || null,
        validationStatus: 'NOT_RUN', remainingIssues: [] }
      const item = items[index] || { type: 'message', role: 'assistant', id: 'report', content: [{ type: 'output_text', text: JSON.stringify(report) }] }
      const namespace = body.tools.find(tool => tool.type === 'namespace' && /^mcp__rpa_agent_*$/.test(tool.name))
      if (item.type === 'function_call' && namespace) {
        item.name = item.name.replace('mcp__rpa_agent__', '')
        item.namespace = namespace.name
      }
      const events = [{ type: 'response.created', response: { id: 'fixture-' + index } },
        { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id: 'fixture-' + index, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } }]
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''))
    } catch (error) { res.writeHead(500); res.end(error.message) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const engine = createCodexEngine({ runner, getSettings: () => ({ codex: {
    executable: process.env.RPA_CODEX_COMPAT_EXECUTABLE || '', model: 'fixture-model', timeoutSeconds: 30 } }),
    getCacheDirectory: () => directory, execute: options => {
      options.env = { ...options.env, CODEX_HOME: isolatedHome }
      const provider = { name: 'Local protocol fixture', base_url: 'http://127.0.0.1:' + server.address().port + '/v1',
        wire_api: 'responses', requires_openai_auth: false, supports_websockets: false }
      const insertion = options.args.length - 1
      options.args.splice(insertion, 0, '-c', 'model_provider="fixture"', '-c', 'features.tool_search=false',
        '-c', 'model_providers.fixture=' + JSON.stringify(provider).replace(/"(\w+)":/g, '$1='))
      return executeCodex(options)
    } })
  try {
    await engine.start(session, '通过 MCP 运行当前流程并生成修复候选', { mode: 'develop', executionConsent: true })
    assert.equal(session.state, 'completed')
    assert.equal(executions, 1)
    assert.equal(session.proposal.dsl.steps[0].stepName, '原生 CLI 候选')
    assert.equal(session.dsl.steps[0].stepName, '原步骤')
    assert.equal(session.turn.executions, 1)
    assert.equal(receivedImage, true)
    console.log('Native Codex compatibility passed: exec JSONL, HTTP MCP, RPA run, native screenshot content, candidate and structured report.')
  } catch (error) {
    console.error(JSON.stringify({ requests, toolCatalog, calls: session.turn?.calls.map(call => ({ name: call.name, state: call.state })), lastOutputs }))
    throw error
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
