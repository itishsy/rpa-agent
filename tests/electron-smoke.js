'use strict'
// Real Electron + preload + encrypted persistence + local mock platform/executor.
// Never connects to declaration websites or starts/stops an installed robot.
const { app, BrowserWindow, safeStorage, dialog, nativeImage } = require('electron')
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
  { actionCode: 'h5Login', actionName: 'H5登录', groupName: 'declare' },{actionCode:'codeBlock',actionName:'代码块',actionArgsVOS:[],targetArgsVOS:[]},
  {actionCode:'start',actionName:'旧图开始'},{actionCode:'end',actionName:'旧图结束'}]
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
let invalidLeafJump=false
let emptyBlockTest=false,emptyBlockRows=[{stepCode:'login-block',stepName:'账号密码登录',actionCode:'codeBlock',level:0,number:0,list:[]}]
const publicTemplates = [{ flowCode: 'template-child', flowName: '医疗增员单个',readOnly:true },
  { flowCode: 'template-leaf', flowName: '模板末级' }, { flowCode: 'template-body', flowName: '来源模板' }]
let requests = [], cancelled = false, modelCalls = 0, lastDebugDsl, lastCapturePoints, steeredResponse, analysisResponse
let holdDebug = false, releaseDebug, accountAvailable = true
let budgetSamples = 0, closingSamples = 0
let duplicateIdentityTest = false
const server = http.createServer((req, res) => {
  requests.push({ method: req.method, path: req.url })
  let body = ''; req.on('data', chunk => { body += chunk })
  req.on('end', async () => {
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
        if(done){analysisResponse=res;return}
        const message={role:'assistant',content:'正在读取现场。',tool_calls:[{id:'auto-execution',type:'function',function:{name:'run_current_dsl',arguments:'{}'}}]}
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
    else if (url.pathname.endsWith('/robot/flow/list')) data = JSON.parse(body).appCode === 'reference-app'
      ? publicTemplates.filter(flow => flow.flowCode !== 'template-body').map(flow => ({...flow,appCode:'reference-app'}))
      : [{ flowCode: 'flow', flowName: '示例流程', appCode: 'app' }, { flowCode: 'child', flowName: '子流程', appCode: 'app',templateFlowCode:'unused-template' },
      { flowCode: 'template-alias', flowName: '引用模板', appCode: 'app', relationFlowCode: 'template-body' },
      ...publicTemplates.filter(flow => flow.flowCode === 'template-leaf').map(flow => ({...flow,appCode:'app'})),
      ...(emptyBlockTest?[{flowCode:'empty-block',flowName:'登录',appCode:'app',templateFlowCode:'stale-template'}]:[]),
      ...(duplicateIdentityTest ? [{ flowCode: 'duplicate-flow', flowName: '重复编码场景', appCode: 'app' }] : [])]
    else if (url.pathname.endsWith('/robot/flow/listTemplate')) {
      assert.equal(url.searchParams.get('flowType'), '2'); assert.equal(url.searchParams.get('templateType'), '1'); data = publicTemplates
    }
    else if (url.pathname.endsWith('/robot/client/app/getByFlowCode/template-body')) data = { flowCode: 'template-body', appCode: 'reference-app', flowName: '来源流程' }
    else if (url.pathname.endsWith('/robot/flow/step/list/template-alias')) {
      data = []
    }
    else if (url.pathname.endsWith('/robot/flow/step/list/template-body')) data=[{stepCode:'alias-call',stepName:'调用模板单个',actionCode:'subFlow',level:0,actionArgs:'{"flowName":"医疗增员单个"}'}]
    else if (url.pathname.endsWith('/robot/flow/step/list/template-child')) data = [{ stepCode: 'template-page', stepName: '模板页面', actionCode: 'page', level: 0,
      actionArgs: '{"actionType":"access","actionArgs":"https://example.test/template"}', list: [
        { stepCode: 'template-nested', stepName: '模板中的嵌套调用', actionCode: 'subFlow', level: 1, actionArgs: '{"flowName":"模板末级"}' }
      ] }]
    else if (url.pathname.endsWith('/robot/flow/step/list/template-leaf')) data = [{ stepCode: 'template-leaf-step', stepName: '模板末级页面', actionCode: 'page', level: 0,
      ...(invalidLeafJump?{skipTo:'退出浏览器'}:{}),
      actionArgs: JSON.stringify({ actionType: 'access', actionArgs: 'https://example.test/leaf' }) }]
    else if (url.pathname.endsWith('/robot/flow/step/list/flow') || url.pathname.endsWith('/robot/flow/step/list/duplicate-flow')) data = rows
    else if (url.pathname.endsWith('/robot/flow/step/list/child')) data = childRows
    else if (url.pathname.endsWith('/robot/flow/step/list/empty-block')) {assert.equal(url.searchParams.has('templateFlowCode'),false);data=emptyBlockRows}
    else if (url.pathname.endsWith('/robot/flow/step/save')) { if (url.searchParams.get('flowCode') === 'child') childRows = JSON.parse(body); else if(url.searchParams.get('flowCode')==='empty-block')emptyBlockRows=JSON.parse(body);else rows = JSON.parse(body); data = true }
    else if (url.pathname.endsWith('/robot/action/all')) data = commands
    else if (url.pathname.endsWith('/robot/action/args')) data = url.searchParams.get('dataCode') === 'h5Login' ? h5Fields
      : url.searchParams.get('dataCode') === 'subFlow' ? [{ fieldKey: 'flowName', fieldName: '流程', fieldType: 'text' }] : fields
    else if (url.pathname.endsWith('/robot/action/target/args')) data = []
    else if (url.pathname.endsWith('/api/robot/task/listAllTask')) {
      assert.equal(req.method, 'POST'); data = accountAvailable ? [{ taskCode: 'task', taskName: '测试账户' }] : []
    } else if (url.pathname.endsWith('/api/robot/debug/runs/active/cancel')) { cancelled = true; data = { cancelled: true } }
    else if (url.pathname.endsWith('/api/robot/debug/runs')) {
      assert.equal(req.headers['x-rpa-debug-token'], 'smoke-debug')
      const debugRequest = JSON.parse(body)
      lastDebugDsl = debugRequest.dsl
      lastCapturePoints = debugRequest.capture?.points
      data = { status: 'SUCCEEDED', executionCode: 'run-1', snapshots: [{ phase: 'FINAL', snapshotId: 'final-1', dom: { status: 'AVAILABLE', content: `<html><body>业务成功<span id="account">unit1</span><span id="period">2026-11</span><span id="count">2</span><span id="amount">100.00</span><span id="officialState">已入账</span><table><tr><td class="person">p1</td><td class="state">已入账</td></tr><tr><td class="person">p2</td><td class="state">已入账</td></tr></table></body></html>`, url: 'https://example.test' } }] }
      data.trace = [{ stepName: '判断页面', status: 'BRANCH', message: '条件成立' },
        { stepName: '关闭窗口1', status: 'FAILED', failedStrategy: 1, message: 'ignored-window-exception-stack' },
        { stepName: '被跳过的页面', status: 'SKIPPED' }, { stepName: '访问页面', status: 'SUCCEEDED' }]
      data.startedAt = '2026-11-12T01:02:03.000Z'
      data.snapshots[0].ctx = { variables: [{ name: 'status', type: 'String', value: 'fixture-context' }] }
      data.snapshots[0].screenshots = { items: [{ contentType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcZkAAAAASUVORK5CYII=' }] }
      if (debugRequest.capture?.points?.length) {
        const point = debugRequest.capture.points[0]
        data.snapshots.unshift({ ...data.snapshots[0], snapshotId: 'point-1', phase: 'POINT',
          flowCode: point.flowCode, stepCode: point.stepCode, timing: point.timing })
      }
      if (debugRequest.capture?.recording?.enabled) {
        const jpeg = nativeImage.createFromPath(path.join(__dirname, '../src/assets/app.png')).resize({ width: 64 }).toJPEG(75)
        const bytes = Buffer.concat([jpeg, jpeg])
        data.recording = { status: 'AVAILABLE', contentType: 'video/x-msvideo', fps: 2, durationMs: 1000,
          stopReason: 'DURATION_LIMIT', base64: bytes.toString('base64'), frames: [
            { offset: 0, length: jpeg.length, elapsedMs: 0, stepCode: 'first-step', flowCode: 'flow' },
            { offset: jpeg.length, length: jpeg.length, elapsedMs: 500, stepCode: 'last-step', flowCode: 'flow' }
          ] }
      }
      if (holdDebug) {
        holdDebug = false
        await new Promise(resolve => { releaseDebug = resolve })
      }
    } else if (url.pathname.endsWith('/api/robot/start/status')) data = 0
    else { res.writeHead(404); res.end(JSON.stringify({ message: 'unknown mock endpoint: ' + req.url })); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ code: 200, data }))
  })
})
const secondExecutor = http.createServer(server.listeners('request')[0])
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
      await new Promise(resolve => secondExecutor.listen(0, '127.0.0.1', resolve))
      const endpoint = `http://127.0.0.1:${server.address().port}`
      const secondEndpoint = `http://127.0.0.1:${secondExecutor.address().port}`
      const run = script => win.webContents.executeJavaScript(script, true)
      const wait=async code=>{for(let i=0;i<300;i++){if(await run(code))return;await new Promise(resolve=>setTimeout(resolve,30))}throw new Error('Timed out '+code+'; '+await run('$("patchReviewDialog")?.textContent||$("notice").textContent'))}
      assert.equal(await run('typeof window.require'), 'undefined')
      assert.equal(await run('typeof window.desktop.invoke'), 'function')
      assert.equal(safeStorage.isEncryptionAvailable(), true)
      await run(`(async () => {
        await desktop.invoke('auth:login',{baseUrl:${JSON.stringify(endpoint+'/api')},username:'test',password:'offline-user'});
        const saved = await desktop.invoke('platforms:save', [{name:'Mock',url:${JSON.stringify(endpoint + '/api')},username:'test',password:'local-only-password'}]);
        await desktop.invoke('platform:select', saved.platforms[0].id);
        await desktop.invoke('settings:save', {modelBaseUrl:${JSON.stringify(endpoint + '/v1')},modelName:'mock-model',modelApiKey:'mock-model-key',localDebugToken:'',remoteEnabled:true,connections:[{baseUrl:${JSON.stringify(endpoint)},debugToken:'smoke-debug'},{baseUrl:${JSON.stringify(secondEndpoint)},debugToken:'smoke-debug'}]});
        await bootstrap(); await loadApplications(); document.getElementById('application').value='app'; await loadFlows(); document.getElementById('flow').value='flow'; await openFlow();
        return true;
      })()`)
      await wait('!taskLoading&&$("task").options.length===2')
      const callsBeforeAccount = modelCalls
      for (const mode of ['dslRun', 'develop']) {
        await run(`$("mode").value=${JSON.stringify(mode)};updateComposerMode()`)
        assert.equal(await run('$("send").disabled'), true)
        await assert.rejects(run(`desktop.invoke("agent:start",current.id,{mode:${JSON.stringify(mode)},request:"调试"})`), /请先选择申报账户/)
      }
      await run('$("mode").value="generate";updateComposerMode()')
      assert.equal(await run('$("send").disabled'), false)
      assert.equal(modelCalls, callsBeforeAccount)
      await run('$("task").value="task";$("task").dispatchEvent(new Event("change"))')
      await wait('current.taskCode==="task"&&!pendingAccountSelections.has(current.id)')
      accountAvailable = false
      try {
        await assert.rejects(run('desktop.invoke("agent:start",current.id,{mode:"develop",request:"调试"})'), /申报账户在当前执行器上已失效/)
        assert.equal(modelCalls, callsBeforeAccount)
        assert.equal(await run('current.turn == null'), true)
      } finally { accountAvailable = true }
      assert.equal(await run('document.querySelectorAll(".step-item").length'), 1)
      await run(`(async()=>{ document.getElementById('stepName').value='修改后的页面'; await commitSelectedStep(); })()`)
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal(await run('current.dsl.steps[0].stepName'), '修改后的页面')
      await run('desktop.invoke("workspace:save", current.id)')
      assert.equal(rows[0].stepName, '修改后的页面')
      const callsBeforeRun = modelCalls
      const runsBeforeRun = requests.filter(item=>item.path==='/api/robot/debug/runs').length
      await run('$("mode").value="develop";updateComposerMode();$("send").click()')
      await wait('$("defaultAgentPrompt").open')
      assert.match(await run('$("defaultAgentPromptText").textContent'),/候选修复补丁/)
      await run('$("defaultAgentPrompt").querySelector("[value=cancel]").click()')
      await wait('!$("defaultAgentPrompt").open&&!$("send").disabled')
      await run('$("mode").value="dslRun";updateComposerMode();$("send").click()')
      await wait('$("defaultAgentPrompt").open')
      assert.match(await run('$("defaultAgentPromptText").textContent'),/采集.*不做诊断/)
      assert.equal(requests.filter(item=>item.path==='/api/robot/debug/runs').length,runsBeforeRun)
      await run('$("confirmDefaultAgentPrompt").click()')
      await wait('$("executionEvidenceDialog")?.open&&!$("send").disabled')
      assert.equal(await run('current.turn.mode'), 'dslRun')
      assert.equal(await run('"verification" in current.runs[0]'), false)
      assert.equal(await run('!!current.proposal'), false)
      assert.doesNotMatch(await run('$("executionEvidenceSummary").textContent'), /业务核验/)
      assert.equal(modelCalls,callsBeforeRun)
      assert.equal(requests.filter(item=>item.path==='/api/robot/debug/runs').length,runsBeforeRun+1)
      await run('$("executionEvidenceDialog").close();$("mode").value="generate";updateComposerMode()')
      await run('$("agentSessionMenuTrigger").click();$("runWithCapturePoints").click()')
      await wait('document.querySelector(".capture-points-dialog")?.open')
      const selectedPoint = await run('current.dsl.steps[0].stepCode')
      await run(`(() => {
        const dialog = document.querySelector('.capture-points-dialog')
        const addPoint = [...dialog.querySelectorAll('button')].find(button => button.textContent === '添加采证点')
        dialog.querySelectorAll('.capture-point-row select')[1].value = 'BEFORE'
        addPoint.click()
        dialog.querySelector('button[type=submit]').click()
      })()`)
      await wait('$("executionEvidenceDialog")?.open&&!$("send").disabled')
      assert.deepEqual(lastCapturePoints.map(point => [point.stepCode, point.timing]), [[selectedPoint, 'BEFORE'], [selectedPoint, 'AFTER']])
      assert.equal(await run('"verification" in current.runs[0]'), false)
      assert.equal(await run('$("executionEvidenceDialog")?.open'), true)
      assert.match(await run('$("executionEvidenceSummary").textContent'), /当前完整 DSL/)
      assert.match(await run('$("executionEvidenceRun").textContent'), /run-1.*2026.*09:02:03/)
      assert.match(await run('$("executionEvidenceSummary").textContent'), /调试成功/)
      assert.doesNotMatch(await run('$("executionEvidenceSummary").textContent'), /业务核验/)
      assert.match(await run('$("executionEvidencePanel").textContent'), /判断页面.*分支跳转.*访问页面.*成功/)
      assert.doesNotMatch(await run('$("executionEvidencePanel").textContent'), /被跳过的页面/)
      assert.match(await run('$("executionEvidencePanel").textContent'), /关闭窗口1.*忽略/)
      assert.doesNotMatch(await run('$("executionEvidencePanel").textContent'), /ignored-window-exception-stack/)
      assert.match(await run('$("executionEvidenceSummary").textContent'), /失败 0 次，忽略 1 次/)
      await run('$("evidence-tab-ctx").click()')
      assert.match(await run('$("executionEvidencePanel").textContent'), /fixture-context/)
      assert.match(await run('$("executionEvidencePanel").querySelector("select").textContent'), /指定采证 · 执行前/)
      await run('$("evidence-tab-dom").click()')
      assert.match(await run('$("executionEvidencePanel pre")?.textContent || $("executionEvidencePanel").textContent'), /<html>.*业务成功/)
      await run('$("evidence-tab-screenshots").click()')
      assert.match(await run('$("executionEvidencePanel").querySelector("img").src'), /^data:image\/png;base64,/)
      await run('$("executionEvidenceDialog").close()')
      await run('$("mode").value="dslRun";updateComposerMode();$("request").value="启动录屏运行";$("send").click()')
      await wait('$("executionEvidenceDialog")?.open&&!$("send").disabled')
      assert.equal(await run('current.turn.recording.enabled'), true)
      await run('$("evidence-tab-recording").click()')
      await wait('$("executionEvidencePanel").querySelector("img")?.naturalWidth>0')
      assert.match(await run('$("executionEvidencePanel").textContent'), /first-step.*已达到录制时长上限/)
      assert.match(await run('$("executionEvidencePanel").querySelector("a").download'), /\.avi$/)
      await run('$("executionEvidencePanel").querySelector("button").click()')
      await wait('$("executionEvidencePanel").textContent.includes("last-step")')
      await run('(()=>{const seek=$("executionEvidencePanel").querySelector("input");seek.value="0";seek.dispatchEvent(new Event("input"))})()')
      assert.match(await run('$("executionEvidencePanel").textContent'), /first-step/)
      await run('$("executionEvidenceDialog").close();$("mode").value="generate";updateComposerMode()')
      const beforeAuto=requests.filter(item=>item.path==='/api/robot/debug/runs').length
      await run('window.analysisRun = desktop.invoke("agent:start",current.id,{request:"[execute-without-confirmation]",mode:"develop"}); void 0')
      await wait('!$("agentActivity").hidden && $("agentPhase").textContent.includes("等待模型分析执行结果")')
      for (let tries = 0; tries < 30 && !analysisResponse; tries++) await new Promise(resolve => setTimeout(resolve, 50))
      assert.ok(analysisResponse)
      assert.equal(await run('$("stopAgentActivity").disabled'),false)
      assert.match(await run('$("agentElapsed").textContent'), /秒/)
      assert.ok(await run('$("timeline").querySelector("[data-agent-result]")'))
      assert.equal(await run('$("timeline").querySelectorAll("[data-agent-progress]").length'),0)
      analysisResponse.setHeader('Content-Type','application/json')
      analysisResponse.end(JSON.stringify({choices:[{message:{role:'assistant',content:'执行完成'}}]}))
      await run('window.analysisRun')
      await wait('$("agentActivity").hidden && current.state === "completed"')
      assert.equal(requests.filter(item=>item.path==='/api/robot/debug/runs').length,beforeAuto+1)
      assert.equal(await run('current.pendingApproval==null&&$("approval").hidden'),true)
      await run('[...$("timeline").querySelectorAll("button[data-debug-artifact]")].at(-1).click()')
      await wait('$("executionEvidenceDialog")?.open')
      await run('$("executionEvidenceDialog").close()')
      assert.match(await run('[...$("timeline").querySelectorAll("[data-agent-result]")].at(-1).textContent'), /调试成功.*查看本次执行明细/)
      assert.doesNotMatch(await run('$("timeline").textContent'),/调用工具：|正在读取现场|执行完成/)
      assert.equal(await run('$("plan").childElementCount'),0)
      await run('refreshSnapshot()')
      await run('$("timeline").replaceChildren();restoreAgentTimeline(current)')
      assert.match(await run('[...$("timeline").querySelectorAll("[data-agent-result]")].at(-1).textContent'), /调试成功.*查看本次执行明细/)
      assert.doesNotMatch(await run('$("timeline").textContent'),/调用工具：|正在读取现场|执行完成/)
      assert.ok(await run('$("timeline").querySelector("button[data-debug-artifact]")'))
      const recentProgress = await run(`(() => {
        const timeline = $("timeline"), resultCount = timeline.querySelectorAll("[data-agent-result]").length
        const event = (type,data) => ({type,data,turnId:"progress-limit-test"})
        renderAgentTimelineEvent(event("input/queued",{content:"保留用户消息"}))
        for (let index=1;index<=5;index++) {
          renderAgentTimelineEvent(event("item/started",{tool:"tool_"+index,purpose:"进度 "+index}))
        }
        const rows = [...timeline.querySelectorAll("[data-agent-progress]")].map(row=>row.textContent)
        renderAgentTimelineEvent(event("turn/completed",{}))
        return {rows, cleared:!timeline.querySelector("[data-agent-progress]"),
          resultKept:timeline.querySelectorAll("[data-agent-result]").length===resultCount,
          inputKept:timeline.textContent.includes("保留用户消息")}
      })()`)
      assert.deepEqual(recentProgress,{rows:['调用工具：tool_3，进度 3','调用工具：tool_4，进度 4','调用工具：tool_5，进度 5'],
        cleared:true,resultKept:true,inputKept:true})
      await run('desktop.invoke("agent:start", current.id, {request:"生成修复候选",mode:"generate"})')
      assert.match(await run('$("timeline").textContent'),/候选已生成/)
      assert.doesNotMatch(await run('$("timeline").textContent'),/调用工具：get_flow_context/)
      await run('refreshSnapshot()')
      assert.equal(await run('current.proposal.dsl.steps[0].stepName'), '模型候选页面')
      assert.equal(await run('current.dsl.steps[0].stepName'), '修改后的页面')
      assert.equal(modelCalls, 3)
      await run('(async()=>{ current = await desktop.invoke("workspace:candidate", current.id, "apply", {reviewId:(await desktop.invoke("workspace:candidate",current.id,"review")).reviewId}); current = await desktop.invoke("workspace:save", current.id); renderWorkspace() })()')
      assert.equal(rows[0].stepName, '模型候选页面')
      const executionCount = requests.filter(item => item.path === '/api/robot/debug/runs').length
      const steeringTurn = run('desktop.invoke("agent:start",current.id,{request:"[steer-integration]",mode:"develop"})')
      for (let tries = 0; tries < 30 && !steeredResponse; tries++) await new Promise(resolve => setTimeout(resolve, 50))
      assert.ok(steeredResponse)
      await run('refreshSnapshot()')
      await run('desktop.invoke("agent:steer",current.id,"仅分析当前步骤，不运行",current.turn.id,[])')
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
      await run(`(async()=>installWorkspace(await desktop.invoke('workspace:attach',${JSON.stringify(sessionId)})))()`)
      assert.equal(await run('current.runs.length'), 4)
      if (await run('!!current.serverChanged')) console.error('Baseline before/after', JSON.stringify(beforeRestore), JSON.stringify(await run('current.savedBaseline')))
      assert.equal(await run('!!current.serverChanged'), false)
      assert.equal(await run('"verification" in current.runs[0]'), false)
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
      await run('setView("workspace")')
      assert.equal(await run('$("approval").hidden&&!approvals'),true)
      await run(`(async()=>{ const dsl=structuredClone(current.dsl); dsl.steps.push(
        {stepCode:'call-child',stepName:'调用子流程',actionCode:'subFlow',actionArgs:{flowName:'子流程'}},
        {stepCode:'disabled-call',stepName:'禁用调用',actionCode:'subFlow',status:0,actionArgs:{flowName:'当前应用缺失的子流程'}}
      ); current=await desktop.invoke('workspace:update',current.id,{dsl}); renderWorkspace() })()`)
      const child = await client.callTool({ name: 'get_subflow_context', arguments: { flowCode: 'child' } })
      assert.ok(!child.isError)
      const childContext = JSON.parse(child.content[0].text)
      assert.equal(Object.hasOwn(childContext.dsl,'templateFlowCode'),false)
      const flowList=await client.callTool({name:'list_app_flows',arguments:{}})
      assert.ok(!JSON.stringify(flowList.content).includes('templateFlowCode'))
      const retiredAction=await client.callTool({name:'get_action_detail',arguments:{actionCode:'start'}})
      assert.equal(retiredAction.isError,true)
      const proposedChild = await client.callTool({ name: 'propose_dsl_patch', arguments: { flowCode: 'child', baseRevision: childContext.revision,
        operations: [{ op: 'set', stepCode: 'child-step', field: 'stepName', value: '修复后的子页面' },
          { op: 'insert', step: { stepCode: 'draft-template-call', stepName: '候选新增模板调用', actionCode: 'subFlow', actionArgs: { flowName: '模板末级' } } }] } })
      assert.ok(!proposedChild.isError)
      await run('refreshSnapshot()'); assert.equal(await run('current.proposal.targetFlowCode'), 'child')
      await run('direct("run_current_dsl")')
      assert.equal(lastDebugDsl.subflows.find(flow => flow.flowCode === 'child').steps.some(step => step.stepCode === 'draft-template-call'), false)
      assert.equal(lastDebugDsl.steps.length, 2)
      assert.ok(!lastDebugDsl.steps.some(step => step.stepCode === 'disabled-call'))
      assert.equal(await run('current.dsl.steps.find(step => step.stepCode === "disabled-call").status'), 0)
      const visibleDsl = await run('desktop.invoke("workspace:dsl",current.id)')
      assert.deepEqual(visibleDsl.dsl.steps, lastDebugDsl.steps)
      assert.deepEqual(visibleDsl.diagnostics, [])
      assert.ok(!lastDebugDsl.subflows.some(flow => flow.flowName === '当前应用缺失的子流程'))
      const archivedDsl = await run('desktop.invoke("workspace:execution-evidence",current.id,current.runs[0].artifactId).then(entry=>entry.dsl)')
      assert.deepEqual(archivedDsl, lastDebugDsl)
      await run('$("executionEvidenceDialog").close()')
      const beforeChangedApproval = requests.filter(item => item.path === '/api/robot/debug/runs').length
      const savedChildRows = JSON.parse(JSON.stringify(childRows))
      childRows[0].stepName = '执行前服务器子流程发生变化'
      const rejectedExecution = await client.callTool({ name: 'run_proposed_dsl', arguments: {} })
      assert.equal(rejectedExecution.isError, true)
      assert.match(rejectedExecution.content[0].text, /基线已变化|授权失效|过期/)
      assert.equal(requests.filter(item => item.path === '/api/robot/debug/runs').length, beforeChangedApproval)
      childRows = savedChildRows
      await run('direct("run_proposed_dsl")')
      await run('$("executionEvidenceDialog").close()')
      assert.equal(lastDebugDsl.subflows[0].steps[0].stepName, '修复后的子页面')
      assert.equal(lastDebugDsl.subflows.find(flow => flow.flowName === '模板末级').flowCode, 'template-leaf')
      const rootBeforeApply=await run('JSON.stringify(current.dsl)')
      await run('$("applyCandidate").click()');await wait('$("patchReviewDialog")?.open')
      assert.equal(await run('JSON.stringify(current.dsl)'),rootBeforeApply)
      await run('$("confirmApplyPatch").click()')
      try{await wait('!$("patchReviewDialog")&&current.scope.flowCode==="child"')}
      catch(error){
        console.error(await run('({flow:current.scope.flowCode,staged:!!current.proposal,applying:$("confirmApplyPatch")?.disabled,tabs:workspaceTabs.size})'))
        console.error(requests.slice(-8).map(item=>item.path))
        throw error
      }
      assert.ok(await run('workspaceTabs.has(current.id)'))
      assert.equal(await run('current.dsl.steps[0].stepName'),'修复后的子页面')
      assert.notEqual(childRows[0].stepName,'修复后的子页面')
      await run('(async()=>{current=await desktop.invoke("workspace:save",current.id);renderWorkspace()})()')
      assert.equal(childRows[0].stepName, '修复后的子页面')
      assert.equal(await run('current.scope.flowCode'), 'child')
      await client.close(); await run('desktop.invoke("mcp:control", current.id, false)')
      const h5Values = Object.fromEntries(h5Fields.map(field => [field.fieldKey, 'fixture']))
      Object.assign(h5Values, { validateType: 'qrCode', inputType: '', inputXpath: 'stale-sms-input', smsXpath: 'stale-sms-button' })
      await run(`(async()=>{const dsl=structuredClone(current.dsl);dsl.steps.push({stepCode:'h5-qr',stepName:'h5扫码登录',actionCode:'h5Login',actionArgs:${JSON.stringify(h5Values)}});current=await desktop.invoke('workspace:update',current.id,{dsl});renderWorkspace()})()`)
      const rendererFields = await run(`window.argumentFields.visible(${JSON.stringify(h5Fields)},${JSON.stringify(h5Values)})`)
      assert.equal(rendererFields.find(field => field.fieldKey === 'inputType').hidden, true)
      await run('direct("run_current_dsl")')
      await run('$("executionEvidenceDialog").close()')
      const submittedQr = lastDebugDsl.steps.find(step => step.stepCode === 'h5-qr')
      assert.equal(submittedQr.actionArgs.validateType, 'qrCode')
      assert.equal(submittedQr.actionArgs.qrCodeXpath, 'fixture')
      assert.equal(submittedQr.actionArgs.smsXpath, '')
      assert.equal(submittedQr.actionArgs.inputXpath, '')
      await run(`(async()=>{const dsl=structuredClone(current.dsl);dsl.steps.push({stepCode:'template-call',stepName:'调用引用模板',actionCode:'subFlow',actionArgs:{flowName:'引用模板'}});current=await desktop.invoke('workspace:update',current.id,{dsl});renderWorkspace()})()`)
      await run('direct("run_current_dsl")')
      await run('$("executionEvidenceDialog").close()')
      assert.deepEqual(lastDebugDsl.subflows.map(flow => flow.flowName).sort(), ['引用模板', '医疗增员单个', '模板末级'].sort())
      assert.equal(lastDebugDsl.subflows.find(flow => flow.flowName === '医疗增员单个').steps[0].children[0].actionArgs.flowName, '模板末级')
      assert.ok(!requests.some(request=>request.path.includes('templateFlowCode')||request.path.includes('listTemplate')))
      const readConfig = await run('desktop.invoke("mcp:control",current.id,true)')
      const readClient = new Client({ name: 'readonly-smoke', version: '1.0.0' })
      await readClient.connect(new StreamableHTTPClientTransport(new URL(readConfig.url), { requestInit: { headers: { Authorization: 'Bearer ' + readConfig.bearerToken } } }))
      invalidLeafJump=true
      const referenced = await readClient.callTool({ name: 'get_subflow_context', arguments: { flowCode: 'template-child' } })
      const beforeDslViewRuns=requests.filter(item=>item.path.includes('/robot/debug/runs')).length
      const {dsl:fullDslView,diagnostics}=await run('desktop.invoke("workspace:dsl",current.id)')
      assert.ok(Array.isArray(diagnostics));assert.equal(Object.hasOwn(fullDslView,'inspectionDiagnostics'),false)
      assert.deepEqual(fullDslView.subflows.map(flow=>flow.flowName).sort(),['引用模板','医疗增员单个','模板末级'].sort())
      assert.equal(fullDslView.subflows.find(flow=>flow.flowCode==='template-leaf').steps[0].skipTo,'退出浏览器')
      assert.equal(requests.filter(item=>item.path.includes('/robot/debug/runs')).length,beforeDslViewRuns)
      assert.equal(await run('current.dsl.subflows===undefined'),true)
      await run('$("agentSessionMenuTrigger").click();$("showDsl").click()')
      for(let i=0;i<100&&!await run('!!$("jsonViewerDialog")?.open');i++)await new Promise(resolve=>setTimeout(resolve,20))
      assert.equal(await run('JSON.parse($("jsonViewerSource").value).subflows.length'),3)
      assert.equal(await run('$("jsonViewerFlow").options.length'),4)
      await run('$("jsonViewerFlow").value=[...$("jsonViewerFlow").options].find(option=>option.textContent.includes("医疗增员单个")).value;$("jsonViewerFlow").dispatchEvent(new Event("change"))')
      assert.match(await run('$("jsonViewerDialog").querySelector(".json-viewer-tree").textContent'),/模板页面/)
      assert.equal(await run('[...$("jsonViewerDialog").querySelectorAll("summary")].find(node=>node.textContent.includes("模板页面")).getClientRects().length>0'),true)
      assert.equal(await run('JSON.parse($("jsonViewerSource").value).subflows.length'),3)
      await run('$("jsonViewerDialog").querySelector(".json-viewer-heading button").click()')
      invalidLeafJump=false
      assert.ok(!referenced.isError)
      assert.equal(JSON.parse(referenced.content[0].text).advisoryOnly, true)
      assert.equal(JSON.parse(referenced.content[0].text).dsl.steps.length,1)
      assert.deepEqual(JSON.parse(referenced.content[0].text).jumpDiagnostics,[])
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
      await run('(async()=>installWorkspace(await desktop.invoke("workspace:attach",current.id)))()')
      assert.equal(await run('current.dsl.steps[0].children[0].stepCode'), repairedIdentity)
      await run('desktop.invoke("workspace:save",current.id)')
      assert.equal(rows.length, 3)
      assert.deepEqual(rows.map(row => row.id), [101, 102, 103])
      assert.equal(rows.some(row => Object.hasOwn(row, 'sourceStepCode')), false)
      await run('(async()=>installWorkspace(await desktop.invoke("workspace:attach",current.id)))()')
      assert.equal(await run('current.dsl.steps[0].children[0].stepCode'), repairedIdentity)
      await run('setView("workspace")')
      assert.equal(await run('getComputedStyle(document.getElementById("workspace")).display!=="none"'), true)
      emptyBlockTest=true
      const emptyOpened=await run('desktop.invoke("workspace:open",{appCode:"app",flowCode:"empty-block",executor:current.scope.executor})')
      assert.equal(emptyOpened.session.dsl.steps[0].stepName,'账号密码登录')
      await run(`installWorkspace(${JSON.stringify(emptyOpened)})`)
      assert.ok(await run('$("stepTree").textContent.includes("账号密码登录")'))
      const invalidSave=await run('desktop.invoke("workspace:save",current.id).then(()=>"unexpected",error=>error.message)')
      assert.match(invalidSave,/没有步骤/)
      await run('(async()=>{const dsl=structuredClone(current.dsl);dsl.steps[0].body=[{stepCode:"login-child",stepName:"访问登录页",actionCode:"page",actionArgs:{actionType:"access",actionArgs:"https://example.test/login"}}];current=await desktop.invoke("workspace:update",current.id,{dsl});current=await desktop.invoke("workspace:save",current.id);renderWorkspace()})()')
      assert.equal(emptyBlockRows.length,2)
      assert.equal(emptyBlockRows[1].stepName,'访问登录页')
      const templateOpened=await run('desktop.invoke("workspace:open",{appCode:"app",flowCode:"template-alias",executor:current.scope.executor})')
      assert.equal(templateOpened.session.dsl.steps.length,1)
      assert.equal(templateOpened.session.dsl.steps[0].actionArgs.flowName,'医疗增员单个')
      assert.equal(templateOpened.session.readOnly,true)
      const referenceDsl = await run(`desktop.invoke("workspace:dsl",${JSON.stringify(templateOpened.session.id)})`)
      assert.deepEqual(referenceDsl.diagnostics, [])
      assert.deepEqual(referenceDsl.dsl.subflows.map(flow => flow.flowCode), ['template-child', 'template-leaf'])
      assert.ok(requests.some(request=>request.path.endsWith('/getByFlowCode/template-body')))
      assert.ok(!requests.some(request=>/listTemplate|templateFlowCode|templateType/.test(request.path)))
      await run('(async()=>{const opened=await desktop.invoke("workspace:open",{appCode:"app",flowCode:"flow",executor:current.scope.executor});installWorkspace(opened);setView("workspace");await showDebugExecutionDetails(current.id,null,"dsl")})()')
      assert.equal(await run('current.runs.length'), 0)
      assert.ok(await run('$("executionEvidenceRun").options.length >= 2'))
      assert.match(await run('$("executionEvidencePanel").textContent'), /flowCode|flowName/)
      await run('$("executionEvidenceRun").selectedIndex=1;$("executionEvidenceRun").dispatchEvent(new Event("change"))')
      await wait('$("executionEvidencePanel").textContent.includes("flowCode")')
      await run('$("executionEvidenceDialog").close()')
      const firstId = await run('current.id')
      await run('desktop.invoke("workspace:update",current.id,{taskCode:"task"})')
      holdDebug = true
      const firstRun = run('desktop.invoke("agent:start",current.id,{directTool:{name:"run_current_dsl"}})')
      for (let attempt = 0; attempt < 100 && !releaseDebug; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
      assert.ok(releaseDebug)
      await run('setView("flowManagement");$("flow").value="template-alias";openFlow()')
      await wait('current.scope.flowCode==="template-alias"&&!taskLoading')
      const secondId = await run('current.id')
      await run('desktop.invoke("workspace:update",current.id,{taskCode:"task"})')
      const busyRun = await run('desktop.invoke("agent:start",current.id,{directTool:{name:"run_current_dsl"}}).then(()=>"unexpected",error=>error.message)')
      assert.match(busyRun, /执行器已有任务/)
      const remote = await run(`desktop.invoke("workspace:open",{appCode:"app",flowCode:"template-alias",executor:${JSON.stringify(secondEndpoint)}})`)
      await run(`installWorkspace(${JSON.stringify(remote)});setView("workspace")`)
      await run('desktop.invoke("workspace:update",current.id,{taskCode:"task"})')
      const secondResult = await run('desktop.invoke("agent:start",current.id,{directTool:{name:"run_current_dsl"}})')
      assert.equal(secondResult.status, 'SUCCEEDED')
      assert.equal(await run(`desktop.invoke("agent:snapshot",${JSON.stringify(firstId)}).then(value=>value.state)`), 'running')
      await run(`switchWorkspaceTab(${JSON.stringify(firstId)})`)
      await run(`switchWorkspaceTab(${JSON.stringify(secondId)})`)
      releaseDebug()
      await firstRun
      await run(`switchWorkspaceTab(${JSON.stringify(firstId)})`)
      assert.equal(await run('current.state'), 'completed')
      assert.match(await run('$("timeline").textContent'), /调试成功/)
      const removedId = await run('current.runs[0].artifactId')
      await run('showDebugExecutionDetails(current.id,current.runs[0].artifactId)')
      const countBeforeDelete = await run('$("executionEvidenceRun").options.length')
      const originalMessageBox = dialog.showMessageBox
      dialog.showMessageBox = async () => ({ response: 1 })
      try {
        await run('$("executionEvidenceDialog").querySelector("button.danger").click()')
        await wait('$("executionEvidenceRun").options.length===' + (countBeforeDelete - 1) + '&&!$("executionEvidenceDialog").querySelector("button.danger").disabled')
      } finally { dialog.showMessageBox = originalMessageBox }
      await run('$("executionEvidenceDialog").close()')
      assert.equal(await run(`desktop.invoke("workspace:execution-evidence",current.id,null).then(rows=>rows.some(row=>row.id===${JSON.stringify(removedId)}))`), false)
      const shot = await win.webContents.capturePage(); fs.writeFileSync(path.join(artifactDirectory, 'workbench.png'), shot.toPNG())
      assert.deepEqual(errors, [])
      assert.equal(cancelled, false)
      fs.writeFileSync(path.join(artifactDirectory, 'electron-smoke.json'), JSON.stringify({ passed: true, requests, checks: ['secure-preload', 'safeStorage', 'platform-auth', 'load-flow', 'native-edit', 'save', 'mock-model-tool-loop', 'candidate-review', 'mock-debug', 'business-assertion', 'external-artifact', 'session-restore', 'MCP-auth', 'MCP-tool', 'MCP-execution-without-confirmation', 'turn-steering', 'refresh-attach-execution-history', 'model-execution-without-confirmation', 'single-line-tool-events', 'changed-dependency-rejected', 'subflow-context', 'subflow-patch', 'subflow-candidate-run', 'subflow-apply-save', 'platform-window'] }, null, 2))
      console.log('Electron integration passed: native UI, IPC, safeStorage, mock platform/executor, workspace restore, execution evidence and authenticated MCP.')
      clearTimeout(deadline); server.close(); secondExecutor.close(); app.exit(0)
    } catch (error) { console.error(error.stack); console.error(errors); clearTimeout(deadline); server.close(); secondExecutor.close(); app.exit(1) }
  })
})
require('../src/main')
