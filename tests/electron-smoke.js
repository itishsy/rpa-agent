'use strict'
// Real Electron + preload + encrypted persistence + local mock platform/executor.
// Never connects to declaration websites or starts/stops an installed robot.
const { app, BrowserWindow, safeStorage, dialog } = require('electron')
app.disableHardwareAcceleration()
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const artifactDirectory = path.join(root, 'artifacts')
fs.mkdirSync(artifactDirectory, { recursive: true })
process.env.RPA_AGENT_TEST_DATA = fs.mkdtempSync(path.join(artifactDirectory, 'smoke-data-'))
const errors = []
const commands = [{ actionCode: 'page', actionName: '页面', groupName: '浏览器' }, { actionCode: 'subFlow', actionName: '调用子流程', groupName: '流程' },
  { actionCode: 'h5Login', actionName: 'H5登录', groupName: 'declare' }]
const h5Fields = require('../src/services/action-knowledge.json').actions.find(action => action.actionCode === 'h5Login').actionFields.map(field => ({
  fieldKey: field.key, fieldName: field.name, required: field.required ? 1 : 0, fieldType: 'text',
  cond: field.conditions.length ? JSON.stringify(Object.fromEntries(field.conditions.map(condition => {
    const separator = condition.indexOf(':'); return [condition.slice(0, separator), condition.slice(separator + 1).split(',')]
  }))) : ''
}))
const fields = [{ fieldKey: 'actionType', fieldName: '操作', fieldType: 'singleDropList' }, { fieldKey: 'actionArgs', fieldName: '参数', fieldType: 'text' }]
let rows = [{ stepCode: 's1', stepName: '打开页面', actionCode: 'page', level: 0, number: 0,
  actionArgs: '{"actionType":"access","actionArgs":"https://example.test"}', targetArgs: '{}' }]
let childRows = [{ stepCode: 'child-step', stepName: '子页面', actionCode: 'page', level: 0, number: 0,
  actionArgs: '{"actionType":"access","actionArgs":"https://example.test/child"}', targetArgs: '{}' }]
const publicTemplates = [{ flowCode: 'template-child', flowName: '医疗增员单个' },
  { flowCode: 'template-leaf', flowName: '模板末级' }, { flowCode: 'template-body', flowName: '来源模板' }]
let requests = [], cancelled = false, modelCalls = 0, lastDebugDsl, steeredResponse
let budgetSamples = 0, closingSamples = 0
let officialBusinessState = '已入账'
let changedTemplateLeaf = false
let duplicateIdentityTest = false
const server = http.createServer((req, res) => {
  requests.push({ method: req.method, path: req.url })
  let body = ''; req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const url = new URL(req.url, 'http://local')
    let data
    if (url.pathname === '/v1/chat/completions') {
      const lastUser = JSON.parse(body).messages.filter(item => item.role === 'user').at(-1)?.content
      if (JSON.parse(body).tool_choice === 'none') {
        closingSamples++
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '修改建议：核对失败步骤的输入变量及来源。当前缺少完整失败 DOM，暂不能确定定位应改成什么；引用流程应在来源流程中修改并复核。' } }] }))
        return
      }
      if (lastUser === '[budget-conclusion]') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [
          { id: 'budget-read-' + (++budgetSamples), type: 'function', function: { name: 'get_flow_context', arguments: '{}' } }
        ] } }] }))
        return
      }
      if(lastUser==='[execute-without-confirmation]'){
        const done=JSON.parse(body).messages.some(message=>message.role==='tool'&&message.tool_call_id==='auto-execution')
        const message=done?{role:'assistant',content:'执行完成'}:{role:'assistant',content:'',tool_calls:[{id:'auto-execution',type:'function',function:{name:'run_current_dsl',arguments:'{}'}}]}
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message}]}));return
      }
      if (lastUser === '[truncated-integration]') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'incomplete',
          tool_calls: [{ id: 'truncated-execution', type: 'function', function: { name: 'run_current_dsl', arguments: '{}' } }] } }] }))
        return
      }
      if (lastUser === '[steer-integration]') { steeredResponse = res; return }
      if (lastUser === '仅分析当前步骤，不运行') {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '已接收补充指令，仅分析。' } }] })); return
      }
      const response = modelCalls++ === 0 ? { role: 'assistant', content: '', tool_calls: [{ id: 'context-call', type: 'function', function: { name: 'get_flow_context', arguments: JSON.stringify({ _purpose: '确认当前流程基线，为生成修复候选做准备' }) } }] }
        : modelCalls === 2 ? { role: 'assistant', content: '', tool_calls: [{ id: 'patch-call', type: 'function', function: { name: 'propose_dsl_patch', arguments: JSON.stringify({ baseRevision: 1, operations: [{ op: 'set', stepCode: 's1', field: 'stepName', value: '模型候选页面' }] }) } }] }
          : { role: 'assistant', content: '候选已生成，请审阅后应用和保存。' }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: response }] })); return
    }
    if (url.pathname.endsWith('/oauth/token')) data = { access_token: 'smoke-only-token', expires_in: 3600, custId: 1, custName: 'Mock' }
    else if (url.pathname.endsWith('/oauth/check_token')) data = { active: true, exp: Date.now() / 1000 + 3600 }
    else if (url.pathname.endsWith('/sys/user/menu/listMenuByUser/1')) data = { menus:[],tabs:[],buttons:[] }
    else if (url.pathname.endsWith('/robot/app/getAppData') || url.pathname.endsWith('/robot/app/page')) data = { rows: [{ appCode: 'app', appName: '离线示例', appArgs: '{}' }], total: 1 }
    else if (url.pathname.endsWith('/robot/flow/list')) data = [{ flowCode: 'flow', flowName: '示例流程', appCode: 'app' }, { flowCode: 'child', flowName: '子流程', appCode: 'app' },
      { flowCode: 'template-alias', flowName: '引用模板', appCode: 'app', templateFlowCode: 'template-body' },
      ...(duplicateIdentityTest ? [{ flowCode: 'duplicate-flow', flowName: '重复编码场景', appCode: 'app' }] : [])]
    else if (url.pathname.endsWith('/robot/flow/listTemplate')) {
      assert.equal(url.searchParams.get('flowType'), '2'); assert.equal(url.searchParams.get('templateType'), '1'); data = publicTemplates
    }
    else if (url.pathname.endsWith('/robot/client/app/getByFlowCode/template-body')) data = publicTemplates.find(flow => flow.flowCode === 'template-body')
    else if (url.pathname.endsWith('/robot/flow/step/list/template-alias')) {
      assert.equal(url.searchParams.get('templateFlowCode'), 'template-body')
      data = [{ stepCode: 'alias-call', stepName: '调用模板单个', actionCode: 'subFlow', level: 0, actionArgs: '{"flowName":"医疗增员单个"}' }]
    }
    else if (url.pathname.endsWith('/robot/flow/step/list/template-child')) data = [{ stepCode: 'template-page', stepName: '模板页面', actionCode: 'page', level: 0,
      actionArgs: '{"actionType":"access","actionArgs":"https://example.test/template"}', list: [
        { stepCode: 'template-nested', stepName: '模板中的嵌套调用', actionCode: 'subFlow', level: 1, actionArgs: '{"flowName":"模板末级"}' }
      ] }]
    else if (url.pathname.endsWith('/robot/flow/step/list/template-leaf')) data = [{ stepCode: 'template-leaf-step', stepName: '模板末级页面', actionCode: 'page', level: 0,
      actionArgs: JSON.stringify({ actionType: 'access', actionArgs: 'https://example.test/leaf' + (changedTemplateLeaf ? '?changed=1' : '') }) }]
    else if (url.pathname.endsWith('/robot/flow/step/list/flow') || url.pathname.endsWith('/robot/flow/step/list/duplicate-flow')) data = rows
    else if (url.pathname.endsWith('/robot/flow/step/list/child')) data = childRows
    else if (url.pathname.endsWith('/robot/flow/step/save')) { if (url.searchParams.get('flowCode') === 'child') childRows = JSON.parse(body); else rows = JSON.parse(body); data = true }
    else if (url.pathname.endsWith('/robot/action/all')) data = commands
    else if (url.pathname.endsWith('/robot/action/args')) data = url.searchParams.get('dataCode') === 'h5Login' ? h5Fields
      : url.searchParams.get('dataCode') === 'subFlow' ? [{ fieldKey: 'flowName', fieldName: '流程', fieldType: 'text' }] : fields
    else if (url.pathname.endsWith('/robot/action/target/args')) data = []
    else if (url.pathname.endsWith('/api/robot/task/listAllTask')) {
      assert.equal(req.method, 'POST'); data = [{ taskCode: 'task', taskName: '测试账户' }]
    } else if (url.pathname.endsWith('/api/robot/debug/runs/active/cancel')) { cancelled = true; data = { cancelled: true } }
    else if (url.pathname.endsWith('/api/robot/debug/runs')) {
      assert.equal(req.headers['x-rpa-debug-token'], 'smoke-debug')
      lastDebugDsl = JSON.parse(body).dsl
      data = { status: 'SUCCEEDED', executionCode: 'run-1', snapshots: [{ phase: 'FINAL', snapshotId: 'final-1', dom: { status: 'AVAILABLE', content: `<html><body>业务成功<span id="account">unit1</span><span id="period">2026-11</span><span id="count">2</span><span id="amount">100.00</span><span id="officialState">${officialBusinessState}</span><table><tr><td class="person">p1</td><td class="state">已入账</td></tr><tr><td class="person">p2</td><td class="state">${officialBusinessState}</td></tr></table></body></html>`, url: 'https://example.test' } }] }
    } else if (url.pathname.endsWith('/api/robot/start/status')) data = 0
    else { res.writeHead(404); res.end(JSON.stringify({ message: 'unknown mock endpoint: ' + req.url })); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ code: 200, data }))
  })
})
const deadline = setTimeout(() => { console.error('Electron smoke timed out'); app.exit(1) }, 45000)
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_event, details, message) => { if (details?.level === 'error' || details === 3) errors.push(details?.message || message) })
  contents.on('preload-error', (_event, file, error) => errors.push(file + ': ' + error.message))
})
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (!win.webContents.getURL().endsWith('/index.html')) return
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const endpoint = `http://127.0.0.1:${server.address().port}`
      const run = script => win.webContents.executeJavaScript(script, true)
      assert.equal(await run('typeof window.require'), 'undefined')
      assert.equal(await run('typeof window.desktop.invoke'), 'function')
      assert.equal(safeStorage.isEncryptionAvailable(), true)
      await run(`(async () => {
        await desktop.invoke('auth:login',{baseUrl:${JSON.stringify(endpoint+'/api')},username:'test',password:'offline-user'});
        const saved = await desktop.invoke('platforms:save', [{name:'Mock',url:${JSON.stringify(endpoint + '/api')},username:'test',password:'local-only-password'}]);
        await desktop.invoke('platform:select', saved.platforms[0].id);
        await desktop.invoke('settings:save', {modelBaseUrl:${JSON.stringify(endpoint + '/v1')},modelName:'mock-model',modelApiKey:'mock-model-key',localDebugToken:'',remoteEnabled:true,connections:[{baseUrl:${JSON.stringify(endpoint)},debugToken:'smoke-debug'}]});
        await bootstrap(); await loadApplications(); document.getElementById('application').value='app'; await loadFlows(); document.getElementById('flow').value='flow'; await openFlow();
        current = await desktop.invoke('workspace:update', current.id, {taskCode:'task'});
        current = await desktop.invoke('workspace:assertions', current.id, [{id:'success',type:'textContains',expected:'业务成功'}]);
        return true;
      })()`)
      assert.equal(await run('document.querySelectorAll(".step-item").length'), 1)
      await run(`(async()=>{ document.getElementById('stepName').value='修改后的页面'; document.getElementById('commitStep').click(); })()`)
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal(await run('current.dsl.steps[0].stepName'), '修改后的页面')
      await run('desktop.invoke("workspace:save", current.id)')
      assert.equal(rows[0].stepName, '修改后的页面')
      await run('direct("run_current_dsl")')
      assert.equal(await run('current.runs[0].verification.status'), 'VERIFIED')
      const beforeAuto=requests.filter(item=>item.path==='/api/robot/debug/runs').length
      await run('desktop.invoke("agent:start",current.id,{request:"[execute-without-confirmation]",mode:"develop"})')
      assert.equal(requests.filter(item=>item.path==='/api/robot/debug/runs').length,beforeAuto+1)
      assert.equal(await run('current.pendingApproval==null&&$("approval").hidden'),true)
      assert.match(await run('$("timeline").textContent'),/调用工具：run_current_dsl，真实执行当前流程并采集现场。/)
      assert.equal(await run('[...$("timeline").querySelectorAll(".event-line")].every(item=>!item.textContent.includes("\\n")&&getComputedStyle(item).whiteSpace==="nowrap"&&item.title===item.textContent)'),true)
      await run('desktop.invoke("agent:start", current.id, {request:"生成修复候选",mode:"generate"})')
      assert.match(await run('document.getElementById("timeline").textContent'), /调用工具：get_flow_context，确认当前流程基线，为生成修复候选做准备/)
      await run('refreshSnapshot()')
      assert.equal(await run('current.proposal.dsl.steps[0].stepName'), '模型候选页面')
      assert.equal(await run('current.dsl.steps[0].stepName'), '修改后的页面')
      assert.equal(modelCalls, 3)
      await run('(async()=>{ current = await desktop.invoke("workspace:candidate", current.id, "apply"); current = await desktop.invoke("workspace:save", current.id); renderWorkspace() })()')
      assert.equal(rows[0].stepName, '模型候选页面')
      const executionCount = requests.filter(item => item.path === '/api/robot/debug/runs').length
      const steeringTurn = run('desktop.invoke("agent:start",current.id,{request:"[steer-integration]",mode:"develop"})')
      for (let tries = 0; tries < 30 && !steeredResponse; tries++) await new Promise(resolve => setTimeout(resolve, 50))
      assert.ok(steeredResponse)
      await run('refreshSnapshot()')
      await run('desktop.invoke("agent:steer",current.id,"仅分析当前步骤，不运行",current.turn.id)')
      steeredResponse.setHeader('Content-Type', 'application/json')
      steeredResponse.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'obsolete-steer', type: 'function', function: { name: 'run_current_dsl', arguments: '{}' } }] } }] }))
      await steeringTurn; await run('refreshSnapshot()')
      assert.equal(requests.filter(item => item.path === '/api/robot/debug/runs').length, executionCount)
      assert.equal(await run('current.messages.some(item=>item.tool_calls?.some(call=>call.id==="obsolete-steer"))'), false)
      await assert.rejects(run('desktop.invoke("agent:start",current.id,{request:"[truncated-integration]",mode:"develop"})'), /截断/)
      await run('refreshSnapshot()')
      assert.equal(await run('current.state'), 'failed')
      assert.equal(await run('current.turn.modelOutcome.finishReason'), 'length')
      assert.equal(requests.filter(item => item.path === '/api/robot/debug/runs').length, executionCount)
      const sessionId = await run('current.id')
      const beforeRestore = await run('current.savedBaseline')
      await run(`openFlow(${JSON.stringify(sessionId)})`)
      assert.equal(await run('current.runs.length'), 2)
      if (await run('!!current.serverChanged')) console.error('Baseline before/after', JSON.stringify(beforeRestore), JSON.stringify(await run('current.savedBaseline')))
      assert.equal(await run('!!current.serverChanged'), false)
      assert.equal(await run('current.runs[0].verification.status'), 'VERIFIED')
      const encryptedSettings = fs.readFileSync(path.join(process.env.RPA_AGENT_TEST_DATA, 'settings.enc'), 'utf8')
      assert.ok(!encryptedSettings.includes('smoke-debug'))
      const config = await run('desktop.invoke("mcp:control", current.id, true)')
      const unauth = await fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      assert.equal(unauth.status, 401)
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const client = new Client({ name: 'smoke', version: '1.0.0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: 'Bearer ' + config.bearerToken } } }))
      const tools = await client.listTools(); assert.ok(tools.tools.some(tool => tool.name === 'get_flow_context'))
      const context = await client.callTool({ name: 'get_flow_context', arguments: {} }); assert.ok(!context.isError)
      const dom = await client.callTool({ name: 'inspect_page_dom', arguments: { snapshotIndex: 0 } })
      assert.ok(!dom.isError); assert.match(dom.content[0].text, /业务成功/)
      const runArtifact = await run('current.runs[0].artifactId')
      const artifactPage = await client.callTool({ name: 'read_artifact', arguments: { artifactId: runArtifact, length: 100000,
        _purpose: '分页读取执行证据，核对业务成功页面' } })
      assert.ok(!artifactPage.isError)
      const pageData = JSON.parse(artifactPage.content[0].text)
      assert.equal(pageData.maxLength, 14000)
      assert.equal(pageData.requestedLength, 100000)
      assert.ok(pageData.length <= 14000)
      const beforeMcpExecution=requests.filter(item=>item.path==='/api/robot/debug/runs').length
      const executing = await client.callTool({ name: 'run_current_dsl', arguments: {} })
      assert.ok(!executing.isError)
      assert.equal(requests.filter(item=>item.path==='/api/robot/debug/runs').length,beforeMcpExecution+1)
      assert.equal(await run('!!approvals'),false)
      const restoreSession=await run('current.id')
      const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve))
      win.webContents.reload(); await reloaded
      for (let tries = 0; tries < 40 && !await run('!!currentUser'); tries++) await new Promise(resolve => setTimeout(resolve, 50))
      await run(`(async()=>installWorkspace(await desktop.invoke('workspace:attach',${JSON.stringify(restoreSession)})))()`)
      assert.equal(await run('$("approval").hidden&&!approvals'),true)
      await run(`(async()=>{ const dsl=structuredClone(current.dsl); dsl.steps.push({stepCode:'call-child',stepName:'调用子流程',actionCode:'subFlow',actionArgs:{flowName:'子流程'}}); current=await desktop.invoke('workspace:update',current.id,{dsl}); renderWorkspace() })()`)
      const child = await client.callTool({ name: 'get_subflow_context', arguments: { flowCode: 'child' } })
      assert.ok(!child.isError)
      const childContext = JSON.parse(child.content[0].text)
      const proposedChild = await client.callTool({ name: 'propose_dsl_patch', arguments: { flowCode: 'child', baseRevision: childContext.revision,
        operations: [{ op: 'set', stepCode: 'child-step', field: 'stepName', value: '修复后的子页面' },
          { op: 'insert', step: { stepCode: 'draft-template-call', stepName: '候选新增模板调用', actionCode: 'subFlow', actionArgs: { flowName: '模板末级' } } }] } })
      assert.ok(!proposedChild.isError)
      await run('refreshSnapshot()'); assert.equal(await run('current.proposal.targetFlowCode'), 'child')
      await run('direct("run_current_dsl")')
      assert.equal(lastDebugDsl.subflows.find(flow => flow.flowCode === 'child').steps.some(step => step.stepCode === 'draft-template-call'), false)
      const beforeChangedApproval = requests.filter(item => item.path === '/api/robot/debug/runs').length
      const savedChildRows = JSON.parse(JSON.stringify(childRows))
      childRows[0].stepName = '执行前服务器子流程发生变化'
      const rejectedExecution = await client.callTool({ name: 'run_proposed_dsl', arguments: {} })
      assert.equal(rejectedExecution.isError, true)
      assert.match(rejectedExecution.content[0].text, /基线已变化|授权失效|过期/)
      assert.equal(requests.filter(item => item.path === '/api/robot/debug/runs').length, beforeChangedApproval)
      childRows = savedChildRows
      await run('direct("run_proposed_dsl")')
      assert.equal(lastDebugDsl.subflows[0].steps[0].stepName, '修复后的子页面')
      assert.equal(lastDebugDsl.subflows.find(flow => flow.flowName === '模板末级').flowCode, 'template-leaf')
      await run('(async()=>{ current=await desktop.invoke("workspace:candidate",current.id,"apply"); current=await desktop.invoke("workspace:save",current.id); renderWorkspace() })()')
      assert.equal(childRows[0].stepName, '修复后的子页面')
      assert.equal(await run('current.scope.flowCode'), 'child')
      await client.close(); await run('desktop.invoke("mcp:control", current.id, false)')
      const h5Values = Object.fromEntries(h5Fields.map(field => [field.fieldKey, 'fixture']))
      Object.assign(h5Values, { validateType: 'qrCode', inputType: '', inputXpath: 'stale-sms-input', smsXpath: 'stale-sms-button' })
      await run(`(async()=>{const dsl=structuredClone(current.dsl);dsl.steps.push({stepCode:'h5-qr',stepName:'h5扫码登录',actionCode:'h5Login',actionArgs:${JSON.stringify(h5Values)}});current=await desktop.invoke('workspace:update',current.id,{dsl});renderWorkspace()})()`)
      const rendererFields = await run(`window.argumentFields.visible(${JSON.stringify(h5Fields)},${JSON.stringify(h5Values)})`)
      assert.equal(rendererFields.find(field => field.fieldKey === 'inputType').hidden, true)
      await run('direct("run_current_dsl")')
      const submittedQr = lastDebugDsl.steps.find(step => step.stepCode === 'h5-qr')
      assert.equal(submittedQr.actionArgs.validateType, 'qrCode')
      assert.equal(submittedQr.actionArgs.qrCodeXpath, 'fixture')
      assert.equal(submittedQr.actionArgs.smsXpath, '')
      assert.equal(submittedQr.actionArgs.inputXpath, '')
      await run(`(async()=>{const dsl=structuredClone(current.dsl);dsl.steps.push({stepCode:'template-call',stepName:'调用引用模板',actionCode:'subFlow',actionArgs:{flowName:'引用模板'}});current=await desktop.invoke('workspace:update',current.id,{dsl});renderWorkspace()})()`)
      await run('direct("run_current_dsl")')
      assert.deepEqual(lastDebugDsl.subflows.map(flow => flow.flowName).sort(), ['引用模板', '医疗增员单个', '模板末级'].sort())
      assert.equal(lastDebugDsl.subflows.find(flow => flow.flowName === '医疗增员单个').steps[0].children[0].actionArgs.flowName, '模板末级')
      assert.ok(requests.some(request => request.path.includes('templateFlowCode=template-body')))
      const readConfig = await run('desktop.invoke("mcp:control",current.id,true)')
      const readClient = new Client({ name: 'readonly-smoke', version: '1.0.0' })
      await readClient.connect(new StreamableHTTPClientTransport(new URL(readConfig.url), { requestInit: { headers: { Authorization: 'Bearer ' + readConfig.bearerToken } } }))
      const referenced = await readClient.callTool({ name: 'get_subflow_context', arguments: { flowCode: 'template-child' } })
      assert.ok(!referenced.isError)
      assert.equal(JSON.parse(referenced.content[0].text).advisoryOnly, true)
      const referencedSteps = await readClient.callTool({ name: 'get_app_flow_steps', arguments: { flowCode: 'template-child' } })
      assert.ok(!referencedSteps.isError)
      const deniedRead = await readClient.callTool({ name: 'get_app_flow_steps', arguments: { flowCode: 'unrelated-flow' } })
      assert.equal(deniedRead.isError, true)
      await readClient.close(); await run('desktop.invoke("mcp:control",current.id,false)')
      const beforeConclusionRuns = requests.filter(request => request.path === '/api/robot/debug/runs').length
      await run('desktop.invoke("agent:start",current.id,{request:"[budget-conclusion]",mode:"develop"})')
      await run('refreshSnapshot()')
      assert.equal(await run('current.state'), 'budget_exhausted')
      assert.equal(await run('current.turn.conclusion.source'), 'model')
      assert.match(await run('document.getElementById("timeline").textContent'), /修改建议：核对失败步骤/)
      assert.equal(closingSamples, 1)
      assert.ok(budgetSamples > 0 && budgetSamples <= 23)
      assert.ok(await run('current.turn.modelCalls<=24'))
      assert.equal(requests.filter(request => request.path === '/api/robot/debug/runs').length, beforeConclusionRuns)
      // Exercise actual forms, IPC, inert row extraction, reconciliation and encrypted knowledge.
      await run('(async()=>{current=await desktop.invoke("workspace:update",current.id,{taskCode:"task"});$("businessContext").click()})()')
      for (let tries = 0; tries < 30 && !await run('$("businessDialog").open'); tries++) await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(await run('$("businessDialog").open'), true)
      await run(`(async()=>{
        const values={region:'示例地区',system:'示例网厅',businessType:'汇缴',account:'unit1',period:'2026-11',personCount:'2',amount:'100'};
        for(const [key,value] of Object.entries(values))$('businessFields').querySelector('[name="'+key+'"]').value=value;
        await $('businessForm').onsubmit({preventDefault(){}});
      })()`)
      assert.equal(await run('$("businessDialog").open'), false)
      const businessRules = [
        { id: 'account', type: 'textEquals', businessField: 'account', selector: '#account', expected: 'unit1' },
        { id: 'period', type: 'textEquals', businessField: 'period', selector: '#period', expected: '2026-11' },
        { id: 'count', type: 'numberEquals', businessField: 'personCount', selector: '#count', expected: 2 },
        { id: 'amount', type: 'numberEquals', businessField: 'amount', selector: '#amount', expected: 100 },
        { id: 'state', type: 'businessState', selector: '#officialState', acceptedValues: ['已入账'], pendingValues: ['审核中'] },
        { id: 'people', type: 'recordSet', selector: 'tr', keySelector: '.person', valueSelector: '.state', pendingValues: ['审核中'], records: [{ key: 'p1', value: '已入账' }, { key: 'p2', value: '已入账' }] }
      ]
      await run(`(async()=>{current=await desktop.invoke('workspace:assertions',current.id,${JSON.stringify(businessRules)})})()`)
      officialBusinessState = '审核中'; await run('direct("run_current_dsl")')
      assert.equal(await run('current.runs[0].verification.status'), 'PENDING')
      assert.equal(await run('current.runs[0].verification.details.find(item=>item.id==="people").counts.PENDING'), 1)
      await assert.rejects(run('desktop.invoke("business-knowledge:archive",current.id)'), /业务已验证/)
      officialBusinessState = '已入账'; await run('direct("run_current_dsl")')
      assert.equal(await run('current.runs[0].verification.status'), 'VERIFIED')
      assert.deepEqual(await run('current.runs[0].verification.coverage.missing'), [])
      await run('desktop.invoke("business-knowledge:archive",current.id)')
      changedTemplateLeaf = true
      try { await assert.rejects(run('desktop.invoke("business-knowledge:archive",current.id)'), /子流程已变化/) }
      finally { changedTemplateLeaf = false }
      const ruleFile = path.join(process.env.RPA_AGENT_TEST_DATA, 'rules.json')
      const today = new Date().toISOString().slice(0,10)
      fs.writeFileSync(ruleFile, JSON.stringify([{ id:'example',title:'示例规则',region:'示例地区',system:'示例网厅',businessType:'汇缴',source:'测试用规则来源',effectiveFrom:'2020-01-01',effectiveTo:'2099-12-31',verifiedAt:today,preconditions:['核对主体'],successCriteria:['官方状态明确'],rejectionAdvice:[] }]))
      const originalOpen = dialog.showOpenDialog
      try {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [ruleFile] })
        assert.equal((await run('desktop.invoke("business-knowledge:import-rules",current.id)')).count, 1)
      } finally { dialog.showOpenDialog = originalOpen }
      const businessConfig = await run('desktop.invoke("mcp:control",current.id,true)')
      const businessClient = new Client({ name:'business-smoke',version:'1.0.0' })
      await businessClient.connect(new StreamableHTTPClientTransport(new URL(businessConfig.url), { requestInit:{headers:{Authorization:'Bearer '+businessConfig.bearerToken}} }))
      const rulesReply = await businessClient.callTool({ name:'search_business_rules',arguments:{query:''} })
      assert.equal(JSON.parse(rulesReply.content[0].text).rules.length, 1)
      const casesReply = await businessClient.callTool({ name:'search_experience',arguments:{query:''} })
      assert.equal(JSON.parse(casesReply.content[0].text).cases[0].status, 'VERIFIED_OUTCOME')
      await businessClient.close(); await run('desktop.invoke("mcp:control",current.id,false)')
      await run('$("businessDiagnosis").click()')
      assert.match(await run('$("businessFields").textContent'), /p2：PASSED/)
      await run('$("businessDialog").close()')
      duplicateIdentityTest = true
      rows = [
        { id: 101, stepCode: 'reused', stepName: '读取单位页面', actionCode: 'page', level: 0, actionArgs: '{"actionType":"access","actionArgs":"https://example.test/unit"}' },
        { id: 102, stepCode: 'reused', stepName: '读取缴费页面', actionCode: 'page', level: 1, actionArgs: '{"actionType":"access","actionArgs":"https://example.test/payment"}' },
        { id: 103, stepCode: 'finish', stepName: '读取结果', actionCode: 'page', level: 0, actionArgs: '{"actionType":"access","actionArgs":"https://example.test/result"}' }
      ]
      const beforeIdentityRepair = requests.filter(request => request.path.includes('/robot/flow/step/save')).length
      await run('(async()=>{if(![...$("application").options].some(item=>item.value==="app"))$("application").add(new Option("离线示例","app"));$("application").value="app";await loadFlows();$("flow").value="duplicate-flow";await openFlow()})()')
      assert.equal(requests.filter(request => request.path.includes('/robot/flow/step/save')).length, beforeIdentityRepair)
      assert.equal(await run('current.dsl.steps.length'), 2)
      assert.equal(await run('current.dsl.steps[0].children.length'), 1)
      assert.equal(await run('new Set(current.dsl.steps.flatMap(step=>[step.stepCode,...(step.children||[]).map(child=>child.stepCode)])).size'), 3)
      assert.match(await run('$("notice").textContent'), /重复或缺失编码/)
      const repairedIdentity = await run('current.dsl.steps[0].children[0].stepCode')
      await run('openFlow(current.id)')
      assert.equal(await run('current.dsl.steps[0].children[0].stepCode'), repairedIdentity)
      await run('desktop.invoke("workspace:save",current.id)')
      assert.equal(rows.length, 3)
      assert.deepEqual(rows.map(row => row.id), [101, 102, 103])
      assert.equal(rows.some(row => Object.hasOwn(row, 'sourceStepCode')), false)
      await run('openFlow(current.id)')
      assert.equal(await run('current.dsl.steps[0].children[0].stepCode'), repairedIdentity)
      await run('setView("workspace")')
      assert.equal(await run('getComputedStyle(document.getElementById("workspace")).display!=="none"'), true)
      const shot = await win.webContents.capturePage(); fs.writeFileSync(path.join(artifactDirectory, 'workbench.png'), shot.toPNG())
      assert.deepEqual(errors, [])
      assert.equal(cancelled, false)
      fs.writeFileSync(path.join(artifactDirectory, 'electron-smoke.json'), JSON.stringify({ passed: true, requests, checks: ['secure-preload', 'safeStorage', 'platform-auth', 'load-flow', 'native-edit', 'save', 'mock-model-tool-loop', 'candidate-review', 'mock-debug', 'business-assertion', 'external-artifact', 'session-restore', 'MCP-auth', 'MCP-tool', 'MCP-execution-without-confirmation', 'turn-steering', 'refresh-attach-execution-history', 'model-execution-without-confirmation', 'single-line-tool-events', 'changed-dependency-rejected', 'subflow-context', 'subflow-patch', 'subflow-candidate-run', 'subflow-apply-save', 'platform-window'] }, null, 2))
      console.log('Electron integration passed: native UI, IPC, safeStorage, mock platform/executor, save/restore, business assertions and authenticated MCP.')
      clearTimeout(deadline); server.close(); app.exit(0)
    } catch (error) { console.error(error.stack); console.error(errors); clearTimeout(deadline); server.close(); app.exit(1) }
  })
})
require('../src/main')
