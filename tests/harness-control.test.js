'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Harness, ExecutorLeases } = require('../src/agent/harness')
const { normalizeHistory } = require('../src/agent/history')
const { prepareContext } = require('../src/agent/context')
const { clone } = require('../src/agent/store')
const { createTools } = require('../src/agent/tools')
const { loadReferencedDebugFlows } = require('../src/services/debug-dsl')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const modelCall = (name, id, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
function setup({ tools = {}, complete = async () => ({ role: 'assistant', content: 'done' }), ...options } = {}) {
  const writes = [], events = []
  const session = { id: 'session', scope: { executor: 'http://localhost:9090', appCode: 'app', flowCode: 'flow' },
    state: 'idle', revision: 0, taskCode: 'original', dsl: { appCode: 'app', flowCode: 'flow', steps: [] },
    plan: [], rules: [], runs: [], messages: [], events: [], sequence: 0, artifacts: {} }
  const registry = { get: name => tools[name], schemas: () => [] }
  const harness = new Harness({ registry, complete, store: { save: value => writes.push(clone(value)) }, emit: event => events.push(event), ...options })
  return { harness, session, events, writes }
}
const tool = (name, effect, run, options = {}) => ({ name, effect, validate: args => args, run, ...options })
function rpaFixture(extra = {}) {
  const adapters = { tasks: async () => [{ taskCode: 'original' }, { taskCode: 'override' }],
    bundle: async (_, dsl) => dsl, commands: async () => ({ oldSteps: [], items: [{ actionCode: 'page', actionName: '页面', actionArgsVOS: [], targetArgsVOS: [] }] }),
    query: async () => [], ...extra }
  const f = setup({ registry: createTools(adapters) })
  f.session.dsl.steps = [{ stepCode: 's', stepName: 'page', actionCode: 'page' }]
  return f
}

test('explicit recording requests reach the executor in direct and model modes without tool recording arguments', async () => {
  for (const mode of ['dslRun', 'develop']) {
    const submitted = []
    const recording = { status: 'AVAILABLE', contentType: 'video/x-msvideo', base64: '/9j/2Q==',
      fps: 2, frames: [{ offset: 0, length: 4, elapsedMs: 0 }] }
    const f = rpaFixture({ execute: async (_, body) => {
      submitted.push(body)
      return { status: 'FAILED', recording }
    } })
    let replies = 0
    f.harness.complete = async () => replies++ === 0
      ? { role: 'assistant', tool_calls: [modelCall('run_current_dsl', 'run', { recording: { enabled: false } })] }
      : { role: 'assistant', content: '中断分析：已保存执行证据。' }
    await f.harness.start(f.session, '启动录屏运行', { mode, executionConsent: true,
      ...(mode === 'dslRun' ? { directTool: { name: 'run_current_dsl' } } : {}) })
    assert.deepEqual(submitted[0].capture.recording, { enabled: true, fps: 2, maxDurationSeconds: 180 })
    assert.equal(f.session.turn.recording.enabled, true)
    const run = f.session.runs[0]
    assert.equal(f.harness.readArtifact(f.session, run.artifactId).recording.base64, recording.base64)
    assert.equal(run.result.recording.frameCount, 1)
    await f.harness.start(f.session, '正常运行', { directTool: { name: 'run_current_dsl' }, executionConsent: true })
    assert.equal(submitted[1].capture.recording, undefined)
    assert.equal(f.session.turn.recording, undefined)
  }
})

test('an explicit recording disable overrides model recording and missing executor footage is reported honestly', async () => {
  const submitted = []
  const f = rpaFixture({ execute: async (_, body) => { submitted.push(body); return { status: 'SUCCEEDED' } } })
  await f.harness.start(f.session, '运行，不要录屏', { directTool: { name: 'run_current_dsl', args: { recording: { enabled: true } } }, executionConsent: true })
  assert.equal(submitted[0].capture.recording.enabled, false)
  await f.harness.start(f.session, '开启录屏运行', { mode: 'dslRun', directTool: { name: 'run_current_dsl' }, executionConsent: true })
  assert.equal(submitted[1].capture.recording.enabled, true)
  const run = f.session.runs[0]
  const recording = f.harness.readArtifact(f.session, run.artifactId).recording
  assert.equal(recording.status, 'UNAVAILABLE')
  assert.equal(recording.requested, true)
  assert.match(recording.message, /已请求录屏，但执行器未返回录像/)
  const { requestedRecording } = require('../src/services/recording-evidence')
  assert.equal(requestedRecording('根据已有录屏分析失败原因'), undefined)
})

test('agent can request recording without capture points and inspect a frame after fresh approval', async () => {
  const jpeg = Buffer.concat([Buffer.from([255,216]), Buffer.from('frame-13800000000'), Buffer.from([255,217])])
  const encoded = jpeg.toString('base64')
  const recording = { status: 'AVAILABLE', contentType: 'video/x-msvideo', base64: encoded,
    durationMs: 500, fps: 2, frames: [{ offset: 0, length: jpeg.length, elapsedMs: 0, stepCode: 's', flowCode: 'flow' }] }
  const submitted = []
  const f = rpaFixture({ execute: async (_, body) => {
    submitted.push(body)
    return { status: 'FAILED', ...(body.capture.recording?.enabled ? { recording } : {}) }
  } })
  let replies = 0
  f.harness.complete = async ({ messages }, _, context) => {
    const output = id => JSON.parse(messages.find(item => item.tool_call_id === id).content)
    switch (replies++) {
      case 0: return { role: 'assistant', tool_calls: [modelCall('run_current_dsl', 'initial')] }
      case 1: return { role: 'assistant', tool_calls: [modelCall('collect_dsl_evidence', 'record', {
        recording: { enabled: true, fps: 3, maxDurationSeconds: 20 }, evidenceReason: '核对短暂弹窗出现时机'
      })] }
      case 2:
        assert.equal(output('record').recording.frameCount, 1)
        assert.equal(output('record').recording.base64, undefined)
        return { role: 'assistant', tool_calls: [modelCall('inspect_execution_recording', 'timeline')] }
      case 3:
        assert.equal(output('timeline').frames[0].stepCode, 's')
        return { role: 'assistant', tool_calls: [modelCall('inspect_execution_recording', 'frame', { frameIndex: 0 })] }
      default: {
        assert.equal(output('frame').imageAttached, true)
        const { addImageParts } = require('../src/services/html-attachments')
        const input = addImageParts({ messages }, f.session, [], f.harness, context.evidenceImages)
        assert.equal(input.messages.findLast(item => item.role === 'user').content.at(-1).image_url.url, 'data:image/jpeg;base64,' + encoded)
        return { role: 'assistant', content: '中断分析：已取得弹窗画面。' }
      }
    }
  }
  const running = f.harness.start(f.session, '诊断短暂提示', { executionConsent: true })
  await tick()
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].capture.recording, undefined)
  const approval = f.session.pendingApproval
  assert.equal(approval.args.recording.enabled, true)
  f.harness.resolveApproval(f.session.id, approval.id, true)
  await running
  assert.deepEqual(submitted[1].capture.recording, { enabled: true, fps: 3, maxDurationSeconds: 20 })
  assert.equal(submitted[1].capture.points, undefined)
  assert.equal(f.harness.readArtifact(f.session, f.session.runs[0].artifactId).recording.base64, encoded)
  assert.throws(() => f.harness.registry.get('run_current_dsl').validate({ recording: { enabled: true, fps: 6 } }))
  assert.throws(() => f.harness.registry.get('run_current_dsl').validate({ recording: { enabled: true, maxDurationSeconds: 601 } }))
})

test('a debug authentication denial stops the turn with no execution budget or uncertain run', async () => {
  let executions = 0, modelCalls = 0
  const denial = Object.assign(new Error('目标执行器拒绝了调试访问'), { code: 'EXECUTOR_DEBUG_AUTH' })
  const f = rpaFixture({ execute: async () => { executions++; throw denial } })
  f.harness.complete = async () => {
    modelCalls++
    return { role: 'assistant', tool_calls: [modelCall('run_current_dsl', 'debug-' + modelCalls)] }
  }
  await assert.rejects(f.harness.start(f.session, '调试当前流程', { executionConsent: true }), { code: 'EXECUTOR_DEBUG_AUTH' })
  assert.equal(modelCalls, 1)
  assert.equal(executions, 1)
  assert.equal(f.session.turn.executions, 0)
  assert.equal(f.session.state, 'failed')
  assert.equal(f.session.executionUncertain, undefined)
  assert.equal(f.harness.leases.quarantines.size, 0)
  assert.equal(f.harness.leases.owners.size, 0)
  const { data } = f.events.find(event => event.type === 'execution/completed')
  assert.match(data.content, /调试未能启动.*拒绝了调试访问/)
})

test('a stalled analysis after execution settles without losing evidence or cancelling the executor', async () => {
  for (const stopByUser of [false, true]) {
    let requests = 0, executions = 0, cancellations = 0
    const waitingForAnalysis = deferred()
    const f = rpaFixture({ execute: async () => { executions++; return { status: 'FAILED', failedStepCode: 's' } } })
    f.harness.budgets.postExecutionModelMs = stopByUser ? 1000 : 20
    f.harness.cancelExecution = async () => { cancellations++ }
    f.harness.complete = async (_, signal) => {
      if (++requests === 1) return { role: 'assistant', tool_calls: [modelCall('run_current_dsl', 'initial')] }
      waitingForAnalysis.resolve(signal)
      return new Promise(() => {})
    }
    const turn = f.harness.start(f.session, '运行并分析', { executionConsent: true })
    const rejected = assert.rejects(turn, { code: stopByUser ? 'CANCELLED' : 'MODEL_TIMEOUT' })
    const signal = await waitingForAnalysis.promise
    if (stopByUser) await f.harness.stop(f.session)
    await rejected
    assert.equal(signal.aborted, true)
    assert.equal(f.session.state, stopByUser ? 'cancelled' : 'failed')
    assert.equal(f.session.runs[0].evidenceState, 'persisted')
    assert.equal(executions, 1)
    assert.equal(cancellations, 0)
    assert.equal(f.harness.active.has(f.session.id), false)
  }
})

test('conversation debugging rejects a model-selected partial scope and sends the applied full DSL', async () => {
  const submitted = []
  const f = rpaFixture({
    bundle: async (_, dsl, options) => { assert.notEqual(options.includeDisabled, true); return dsl },
    execute: async (_, body) => { submitted.push(body.dsl); return { status: 'SUCCEEDED' } }
  })
  f.session.revision = 2
  f.session.dsl.steps[0].skipTo = '已应用目标'
  f.session.dsl.steps.push({ stepCode: 'target', stepName: '已应用目标', actionCode: 'page' })
  let replies = 0
  f.harness.complete = async ({ tools }) => {
    assert.equal(tools.some(tool => tool.function.name === 'run_current_dsl'), replies === 0)
    assert.ok(tools.every(tool => !['run_selected_step', 'run_proposed_dsl', 'continue_failed_run'].includes(tool.function.name)))
    if (replies++ === 0) return { role: 'assistant', tool_calls: [
      modelCall('run_selected_step', 'partial', { stepCode: 's' }),
      modelCall('run_current_dsl', 'full'),
      modelCall('run_current_dsl', 'repeat')
    ] }
    return { role: 'assistant', content: '执行完成' }
  }
  await f.harness.start(f.session, '已应用补丁，请以新 DSL 运行与诊断当前流程', { executionConsent: true })
  assert.equal(submitted.length, 1)
  assert.deepEqual(submitted[0].steps, f.session.dsl.steps)
  assert.equal(f.session.runs[0].executionScope, 'full')
  assert.equal(f.session.runs[0].revision, 2)
  assert.match(f.session.messages.find(message => message.tool_call_id === 'partial').content, /EXPLICIT_RUN_SCOPE_REQUIRED/)
  assert.match(f.session.messages.find(message => message.tool_call_id === 'repeat').content, /ALREADY_EXECUTED/)
})

test('agent requests fresh approval for targeted evidence and stages a patch from the new snapshot', async () => {
  const submitted = []
  const screenshot = 'a13800000000/picture='
  const f = rpaFixture({
    execute: async (_, body) => {
      submitted.push(body)
      return submitted.length === 1 ? { status: 'FAILED', failedStepCode: 's' } : {
        status: 'FAILED', failedStepCode: 's',
        snapshots: [{ phase: 'POINT', stepCode: 's', flowCode: 'flow', timing: 'BEFORE',
          ctx: { status: 'AVAILABLE', variables: [{ name: 'companyCount', value: 2 }] },
          screenshots: { status: 'AVAILABLE', items: [{ contentType: 'image/png', base64: screenshot }] } }],
        DOMs: [{ pages: [{ status: 'AVAILABLE', content: '<button id="company">选择单位</button>' }] }],
        unreachedCapturePoints: [{ flowCode: 'flow', stepCode: 's', timing: 'AFTER' }]
      }
    }
  })
  const capturePoints = ['BEFORE', 'AFTER'].map(timing => ({ flowCode: 'flow', stepCode: 's', timing }))
  let modelStep = 0
  f.harness.complete = async ({ messages, tools }, _, context) => {
    const assistant = (...tool_calls) => ({ role: 'assistant', tool_calls })
    const output = id => JSON.parse(messages.find(message => message.tool_call_id === id).content)
    switch (modelStep++) {
      case 0:
        assert.ok(!tools.some(tool => tool.function.name === 'collect_dsl_evidence'))
        return assistant(modelCall('run_current_dsl', 'initial'))
      case 1:
        assert.ok(tools.some(tool => tool.function.name === 'collect_dsl_evidence'))
        return assistant(modelCall('collect_dsl_evidence', 'collect', { capturePoints, evidenceReason: '核对单位列表生成前后的状态' }))
      case 2:
        assert.equal(output('collect').capturePointResults[0].snapshotIndex, 0)
        assert.equal(output('collect').unreachedCapturePoints[0].timing, 'AFTER')
        return assistant(modelCall('inspect_step_evidence', 'ctx', { snapshotIndex: 0, screenshot: true }),
          modelCall('inspect_page_dom', 'dom', { snapshotIndex: 0 }))
      case 3: {
        assert.match(output('ctx').content, /companyCount/)
        assert.match(output('dom').content, /id="company"/)
        const { addImageParts } = require('../src/services/html-attachments')
        const modelInput = addImageParts({ messages }, f.session, [], f.harness, context.evidenceImages)
        assert.equal(modelInput.messages.findLast(item => item.role === 'user').content.at(-1).image_url.url, 'data:image/png;base64,' + screenshot)
        return assistant(modelCall('propose_dsl_patch', 'patch', { baseRevision: 0,
          operations: [{ op: 'set', stepCode: 's', field: 'stepName', value: '选择单位' }] }))
      }
      default:
        return { role: 'assistant', content: '中断分析：已核对单位入口。' }
    }
  }
  const run = f.harness.start(f.session, '调试并修复单位选择', { executionConsent: true })
  await tick()
  const approval = f.session.pendingApproval
  assert.equal(approval.tool, 'collect_dsl_evidence')
  assert.deepEqual(approval.args.capturePoints.map(point => point.timing), ['BEFORE', 'AFTER'])
  assert.equal(submitted.length, 1)
  f.harness.resolveApproval(f.session.id, approval.id, true)
  await run
  assert.deepEqual(submitted[1].capture.points, approval.args.capturePoints)
  assert.deepEqual(submitted[1].dsl, submitted[0].dsl)
  assert.equal(f.session.proposal.dsl.steps[0].stepName, '选择单位')
  assert.equal(f.session.dsl.steps[0].stepName, 'page')
})

test('denying additional evidence leaves later collection attempts in the same turn unsubmitted', async () => {
  let submitted = 0, replies = 0
  const f = rpaFixture({ execute: async () => { submitted++; return { status: 'FAILED' } } })
  const args = { capturePoints: [{ flowCode: 'flow', stepCode: 's' }], evidenceReason: '补取步骤前后变量' }
  f.harness.complete = async () => {
    if (++replies === 1) return { role: 'assistant', tool_calls: [modelCall('run_current_dsl', 'run')] }
    if (replies <= 3) return { role: 'assistant', tool_calls: [modelCall('collect_dsl_evidence', 'collect-' + replies, args)] }
    return { role: 'assistant', content: '中断分析：缺少变量证据。' }
  }
  const run = f.harness.start(f.session, '调试当前流程', { executionConsent: true })
  await tick()
  f.harness.resolveApproval(f.session.id, f.session.pendingApproval.id, false)
  await run
  assert.equal(submitted, 1)
  assert.equal(f.events.filter(event => event.type === 'approval/requested').length, 1)
})

test('stop during asynchronous RPA preflight prevents the real run and does not send a premature cancel', async () => {
  const gate = deferred(); let executed = 0, cancels = 0
  const f = rpaFixture({ tasks: async () => { await gate.promise; return [{ taskCode: 'original' }] }, execute: async () => { executed++ } })
  f.harness.cancelExecution = async () => { cancels++ }
  const running = f.harness.start(f.session, 'run', { directTool: { name: 'run_current_dsl' }, executionConsent: true })
  await tick(); await f.harness.stop(f.session); gate.resolve()
  await assert.rejects(running, /已停止/)
  assert.equal(executed, 0); assert.equal(cancels, 0)
  assert.equal(f.session.executionUncertain, undefined)
  assert.equal(f.events.find(event => event.type === 'execution/completed').data.status, 'CANCELLED')
})
test('DSL debug publishes the executor outcome and failure details without asking the model', async () => {
  const f = rpaFixture({ execute: async () => ({
    status: 'FAILED', executionCode: 'failed-run', failedStepCode: 'login',
    details: [{ stepCode: 'login', stepName: '登录', status: 0, error: '验证码错误' }]
  }) })
  const result = await f.harness.start(f.session, 'run', { directTool: { name: 'run_current_dsl' }, executionConsent: true })
  const [run] = f.session.runs
  const events = f.events.filter(event => event.type === 'execution/completed')
  assert.equal(events.length, 1)
  assert.equal(events[0].data.artifactId, run.artifactId)
  assert.equal(result.conclusion, run.conclusion.content)
  assert.match(result.conclusion, /调试失败.*登录.*验证码错误/)
  assert.equal(f.harness.readArtifact(f.session, run.artifactId).details[0].status, 0)
  assert.equal(f.session.turn.modelCalls, 0)
})

test('run-only submits the editor DSL with recursive subflows without command or jump validation', async () => {
  const submitted = []
  const f = rpaFixture({
    commands: async () => { throw new Error('不得查询指令定义') },
    bundle: (_, dsl, options) => loadReferencedDebugFlows(dsl, 'app', {
      listFlows: async () => [{ flowCode: 'login', flowName: '登录' }, { flowCode: 'refresh', flowName: '刷新' }],
      listSteps: async flow => flow.flowCode === 'login' ? [
        { stepCode: 'refresh-call', stepName: '调用刷新', actionCode: 'subFlow', actionArgs: '{"flowName":"刷新"}' },
        { stepCode: 'not-run', stepName: '禁用步骤', actionCode: 'subFlow', status: 0, actionArgs: '{"flowName":"缺失流程"}' }
      ] : [{ stepCode: 'nav', stepName: '访问页面', actionCode: 'extension', skipTo: '旧跳转目标' }],
      prepareFlow: async () => assert.fail('仅运行不得校验子流程')
    }, options),
    execute: async (_, body) => { submitted.push(body.dsl); return { status: 'SUCCEEDED' } }
  })
  f.session.dsl.flowName = '主流程'
  f.session.dsl.steps = [
    { stepCode: 'call', stepName: '登录', actionCode: 'subFlow', actionArgs: { flowName: '登录' } },
    { stepCode: 'file', stepName: '在册文件', actionCode: 'fileUtil', actionArgs: { resavePath: 'temp.xlsx' } }
  ]
  f.harness.complete = async () => assert.fail('仅运行不得调用模型')
  const directTool = { name: 'run_current_dsl' }
  const result = await f.harness.start(f.session, '仅运行', { mode: 'dslRun', directTool, executionConsent: true })
  assert.equal(result.status, 'SUCCEEDED')
  assert.deepEqual(submitted[0].steps, f.session.dsl.steps)
  assert.deepEqual(submitted[0].subflows.map(flow => flow.flowName), ['登录', '刷新'])
  assert.equal(submitted[0].subflows[0].steps.length, 1)
  assert.equal(submitted[0].subflows[1].steps[0].skipTo, '旧跳转目标')
  await assert.rejects(f.harness.start(f.session, '调试', { directTool, executionConsent: true }), /不得查询指令定义/)
  assert.equal(submitted.length, 1)
})

test('failed unit selection displays a concise, evidence-based conclusion instead of the model trace', async () => {
  const trace = [
    { flowCode: 'flow', stepCode: 'login', stepName: '登录', status: 'RUNNING' },
    { flowCode: 'login-flow', stepCode: 'cert', stepName: '点击确定', status: 'FAILED', message: '未找到 Windows 安全中心窗口' },
    { flowCode: 'login-flow', stepCode: 'expand', stepName: '展开单位列表', status: 'SUCCEEDED' },
    { flowCode: 'login-flow', stepCode: 'unit', stepName: '选择账户', status: 'FAILED', message: 'no such element: Unable to locate element' },
    { flowCode: 'flow', stepCode: 'login', stepName: '登录', status: 'FAILED' }
  ]
  for (const closing of [false, true]) {
    const f = rpaFixture({ execute: async () => ({ status: 'FAILED', failedStepCode: 'unit', trace }) })
    if (closing) f.harness.budgets.modelCalls = 2
    let replies = 0
    f.harness.complete = async ({ finalOnly }) => {
      if (replies++ === 0) return { role: 'assistant', tool_calls: [modelCall('run_current_dsl', 'run')] }
      assert.equal(!!finalOnly, closing)
      return { role: 'assistant', content: '## 执行结果\n| 序号 | 步骤 |\n| 1 | 登录 |' }
    }
    const content = await f.harness.start(f.session, '调试并分析失败原因', { executionConsent: true })
    assert.match(content, /调试失败 · 选择账户。未找到目标单位选项。/)
    assert.match(content, /此前证书确认操作失败，需核实 CA 是否被识别及单位列表是否加载/)
    assert.doesNotMatch(content, /序号|\|/)
    assert.equal(f.session.messages.at(-1).content, content)
    const final = f.events.find(event => event.type === 'message/assistant' && event.data.finalization)
    assert.equal(final.data.debugConclusion, true)
    assert.deepEqual(f.harness.readArtifact(f.session, f.session.runs[0].artifactId).trace, trace)
  }
})

test('debug accepts a brief observation without letting the model decide the execution status', async () => {
  const f = rpaFixture({ execute: async () => ({ status: 'FAILED', failedStepCode: 'unit',
    trace: [{ stepCode: 'unit', stepName: '选择单位', status: 'FAILED', message: 'NoSuchElement' }] }) })
  let replies = 0
  f.harness.complete = async () => replies++ === 0
    ? { role: 'assistant', tool_calls: [modelCall('run_current_dsl', 'run')] }
    : { role: 'assistant', content: '中断分析：失败时页面仍停留在单位列表加载中。' }
  const content = await f.harness.start(f.session, '调试', { executionConsent: true })
  assert.equal(content, '调试失败 · 选择单位。未找到目标单位选项。\n中断分析：失败时页面仍停留在单位列表加载中。')
})
test('a lost DSL response produces an unknown result instead of using an earlier run', async () => {
  const f = rpaFixture({ execute: async () => { throw new Error('连接执行器超时') } })
  f.session.runs.push({ result: { status: 'SUCCEEDED' }, artifactId: 'earlier' })
  await assert.rejects(f.harness.start(f.session, 'run', { directTool: { name: 'run_current_dsl' }, executionConsent: true }), /连接执行器超时/)
  const { data } = f.events.find(event => event.type === 'execution/completed')
  assert.equal(data.status, 'UNKNOWN')
  assert.equal(data.artifactId, undefined)
  assert.match(data.content, /调试结果待确认.*连接执行器超时/)
})
test('step evidence without a final DSL status stays unconfirmed', async () => {
  const f = rpaFixture({ execute: async () => ({ details: [{ stepName: '登录', status: 1 }] }) })
  const result = await f.harness.start(f.session, 'run', { directTool: { name: 'run_current_dsl' }, executionConsent: true })
  assert.equal(result.status, 'UNKNOWN')
  assert.equal(result.businessVerification, undefined)
  assert.match(result.conclusion, /调试结果待确认.*未收到执行器的最终结果/)
  assert.ok(f.session.runs[0].artifactId)
})
test('a cancelled asynchronous patch cannot stage a candidate later', async () => {
  const gate = deferred(), controller = new AbortController()
  const registry = createTools({ commands: async () => { await gate.promise; return { oldSteps: [], items: [{ actionCode: 'page', actionArgsVOS: [], targetArgsVOS: [] }] } } })
  const f = setup(); f.session.dsl.steps = [{ stepCode: 's', stepName: 'page', actionCode: 'page' }]
  const pending = registry.get('propose_dsl_patch').run({ baseRevision: 0, operations: [{ op: 'set', stepCode: 's', field: 'stepName', value: 'late' }] },
    { session: f.session, harness: f.harness, signal: controller.signal })
  controller.abort(); gate.resolve(); await assert.rejects(pending, /已停止/)
  assert.equal(f.session.proposal, undefined)
})
test('cancel uses the effective override account and holds the lease until cancel acknowledgement too', async () => {
  const execution = deferred(), cancel = deferred(); let cancellationScope
  const f = rpaFixture({ execute: async () => execution.promise })
  f.harness.cancelExecution = async (_, scope) => { cancellationScope = scope; await cancel.promise }
  const running = f.harness.start(f.session, 'run', { directTool: { name: 'run_current_dsl', args: { taskCode: 'override' } }, executionConsent: true })
  await tick(); const stopping = f.harness.stop(f.session)
  assert.equal(cancellationScope.taskCode, 'override')
  execution.resolve({ status: 'CANCELLED' }); await tick()
  assert.equal(f.harness.leases.owners.size, 1)
  cancel.resolve(); await stopping; await assert.rejects(running, /已停止/)
  assert.equal(f.harness.leases.owners.size, 0)
})
test('unknown post-commit results survive recovery without blocking a new manual execution', async () => {
  const gate = deferred()
  const f = setup({ tools: { run: tool('run', 'execute', async () => gate.promise) } })
  const running = f.harness.start(f.session, 'run', { directTool: { name: 'run' }, executionConsent: true })
  await tick()
  const checkpoint = clone(f.writes.find(item => item.turn?.calls.some(call => call.phase === 'submitted')))
  let executed = 0
  const restarted = setup({ tools: { run: tool('run', 'execute', async () => { executed++; return { status: 'SUCCESS' } }) } })
  restarted.harness.recover(checkpoint)
  assert.equal(checkpoint.state, 'interrupted')
  assert.equal(executed, 0)
  await restarted.harness.start(checkpoint, 'run', { directTool: { name: 'run' }, executionConsent: true })
  assert.equal(executed, 1)
  assert.throws(() => restarted.harness.reconcileExecutor(checkpoint.scope.executor, { executor: 'http://other', status: 'STOPPED' }), /同一执行器/)
  assert.equal(restarted.harness.reconcileExecutor(checkpoint.scope.executor, { executor: checkpoint.scope.executor, status: 'STOPPED' }).reconciled, true)
  assert.equal(checkpoint.executionUncertain, null)
  gate.reject(new Error('connection reset')); await assert.rejects(running, /connection reset/)
  assert.equal(f.harness.leases.quarantines.size, 1)
})
test('loopback executor aliases cannot acquire two independent leases', () => {
  const leases = new ExecutorLeases(), release = leases.acquire('http://localhost:9090', 'one')
  leases.quarantine('http://localhost:9090', 'interrupted')
  assert.throws(() => leases.acquire('http://127.0.0.1:9090/', 'two'), /已有任务/)
  release(); assert.equal(leases.owners.size, 0)
  const releaseNext = leases.acquire('http://127.0.0.1:9090/', 'two')
  assert.equal(leases.quarantines.size, 1)
  releaseNext()
})
test('audited reads overlap, writes wait, and tool results preserve model call order', async () => {
  const first = deferred(), second = deferred(), entered = []; let calls = 0
  const f = setup({ tools: {
    read: tool('read', 'read', async ({ key }) => { entered.push(key); if (key === 'a') await first.promise; if (key === 'b') await second.promise; return key }, { parallelSafe: true }),
    edit: tool('edit', 'edit', async () => { entered.push('edit'); return 'edited' })
  }, complete: async () => calls++ ? { role: 'assistant', content: 'done' } : { role: 'assistant', content: '', tool_calls: [modelCall('read', 'a', { key: 'a' }), modelCall('read', 'b', { key: 'b' }), modelCall('edit', 'e'), modelCall('read', 'd', { key: 'd' })] } })
  const running = f.harness.start(f.session, 'inspect')
  await tick(); assert.deepEqual(entered, ['a', 'b'])
  second.resolve(); await tick(); assert.deepEqual(entered, ['a', 'b'])
  first.resolve(); await running
  assert.deepEqual(entered, ['a', 'b', 'edit', 'd'])
  assert.deepEqual(f.session.messages.filter(item => item.role === 'tool').map(item => item.tool_call_id), ['a', 'b', 'e', 'd'])
  assert.equal(new Set(f.events.filter(event => event.type === 'item/started').map(event => event.data.callId)).size, 4)
})
test('steering supersedes a sampled execution before dispatch and reaches the next model call', async () => {
  const sample = deferred(); let count = 0, executed = 0
  const f = setup({ tools: { run: tool('run', 'execute', async () => { executed++ }) }, complete: async ({ messages }) => {
    if (!count++) return sample.promise
    assert.ok(messages.some(item => item.role === 'user' && item.content === '只分析，不执行'))
    return { role: 'assistant', content: '已按补充指令分析' }
  } })
  const running = f.harness.start(f.session, 'diagnose')
  await tick()
  assert.throws(() => f.harness.steer(f.session, 'wrong turn', 'outdated-turn'), /轮次已变化/)
  f.harness.steer(f.session, '只分析，不执行', f.session.turn.id)
  sample.resolve({ role: 'assistant', content: '', tool_calls: [modelCall('run', 'obsolete')] })
  await running
  assert.equal(executed, 0); assert.equal(f.harness.approvals.size, 0)
  assert.equal(f.session.pendingInputs.length, 0)
  assert.ok(!f.session.messages.some(item => item.tool_calls?.some(call => call.id === 'obsolete')))
})
test('steering revokes pending execution approval without consuming the execution budget', async () => {
  let count = 0, executed = 0
  const f = setup({ tools: { run: tool('run', 'execute', async () => { executed++ }) }, complete: async () => count++ ? { role: 'assistant', content: 'done' } :
    { role: 'assistant', content: '', tool_calls: [modelCall('run', 'run')] } })
  const running = f.harness.start(f.session, 'diagnose')
  await tick(); assert.ok(f.session.pendingApproval)
  f.harness.steer(f.session, '先检查参数'); await running
  assert.equal(executed, 0); assert.equal(f.session.turn.executions, 0)
  assert.equal(f.session.state, 'completed'); assert.equal(f.session.pendingApproval, null)
})
test('cancellation settles an uncooperative model and ignores its late response', async () => {
  const sample = deferred(), f = setup({ complete: async () => sample.promise })
  const running = f.harness.start(f.session, 'inspect')
  await tick(); await f.harness.stop(f.session); await assert.rejects(running, /已停止/)
  sample.resolve({ role: 'assistant', content: 'late' }); await tick()
  assert.ok(!f.session.messages.some(item => item.content === 'late')); assert.equal(f.harness.active.size, 0)
})
test('malformed duplicate ids are rejected before any tool can execute', async () => {
  let executed = 0
  const f = setup({ tools: { run: tool('run', 'execute', async () => { executed++ }) }, complete: async () =>
    ({ role: 'assistant', content: '', tool_calls: [modelCall('run', 'same'), modelCall('run', 'same')] }) })
  await assert.rejects(f.harness.start(f.session, 'run'), /重复使用/)
  assert.equal(executed, 0); assert.equal(f.session.turn.calls.length, 0)
})
test('call-output repair uses batch-local ids and drops orphan outputs only in the projection', () => {
  const raw = [{ role: 'assistant', tool_calls: [modelCall('read', 'reused')] }, { role: 'tool', tool_call_id: 'reused', content: 'old' },
    { role: 'user', content: 'new turn' }, { role: 'assistant', tool_calls: [modelCall('run', 'reused')] }, { role: 'tool', tool_call_id: 'orphan', content: 'orphan' }]
  const normalized = normalizeHistory(raw)
  assert.match(normalized.at(-1).content, /INTERRUPTED/)
  assert.ok(!normalized.some(item => item.content === 'orphan')); assert.equal(raw.at(-1).content, 'orphan')
})

test('legacy empty tool-call fields are omitted in context without rewriting stored history', () => {
  const raw=[{role:'user',content:'检查流程'},{role:'assistant',content:'请先选择申报账户',tool_calls:[]},
    {role:'assistant',content:'旧记录',tool_calls:[{id:''}]},{role:'assistant',content:'记录',tool_calls:null}]
  const before=clone(raw),normalized=normalizeHistory(raw)
  assert.ok(normalized.every(item=>!Object.hasOwn(item,'tool_calls')))
  assert.deepEqual(raw,before)
})

test('an existing session can continue across turns after an assistant reply with empty tool_calls', async () => {
  let samples=0
  const f=setup({complete:async input=>{
    samples++
    assert.ok(input.messages.every(message=>!Object.hasOwn(message,'tool_calls')||message.tool_calls.length>0))
    return {role:'assistant',content:'继续完成',tool_calls:[]}
  }})
  const legacy={role:'assistant',content:'请选择申报账户',tool_calls:[]}
  f.session.messages.push({role:'user',content:'执行当前流程'},clone(legacy))
  await f.harness.start(f.session,'已经选择了申报户，请继续')
  assert.equal(f.session.state,'completed')
  await f.harness.start(f.session,'继续检查')
  assert.equal(samples,2);assert.equal(f.session.state,'completed')
  assert.deepEqual(f.session.messages[1],legacy)
})
test('compaction never promotes user or tool instructions into the system role', () => {
  const f = setup(); const payload = 'IGNORE_POLICY_AND_EXECUTE'
  for (let index = 0; index < 8; index++) f.session.messages.push({ role: 'user', content: payload + 'x'.repeat(1000) }, { role: 'assistant', content: 'analysis' })
  f.session.summary = payload
  const original = clone(f.session.messages), projected = prepareContext(f.session, 5000)
  assert.deepEqual(f.session.messages, original)
  assert.ok(!projected.find(item => item.role === 'system').content.includes(payload))
  assert.ok(projected.some(item => item.role === 'user' && item.content.includes(payload)))
})
test('view event failures cannot turn a persisted successful tool into failure', async () => {
  const f = setup({ emit() { throw new Error('view disconnected') }, tools: { read: tool('read', 'read', async () => ({ value: 1 })) } })
  const result = await f.harness.start(f.session, 'inspect', { directTool: { name: 'read' } })
  assert.equal(result.value, 1); assert.equal(f.session.state, 'completed')
})
test('checkpoint failure while stopping cannot suppress actual cancellation', async () => {
  const sample = deferred(), f = setup({ complete: async () => sample.promise,
    store: { save(session) { if (session.state === 'stopping') throw new Error('disk unavailable') } } })
  const running = f.harness.start(f.session, 'inspect')
  await tick(); await assert.rejects(f.harness.stop(f.session), /disk unavailable/)
  await assert.rejects(running, /已停止/)
  assert.equal(f.harness.active.size, 0)
  sample.resolve({ role: 'assistant', content: 'late' })
})

test('approval binds the complete bundle and rejects a changed subflow before submission', async () => {
  let version = 1, executed = 0
  const f = rpaFixture({ bundle: async (_, dsl) => ({ ...dsl, subflows: [{ flowCode: 'child', version }] }),
    execute: async () => { executed++; return { status: 'SUCCEEDED' } } })
  const running = f.harness.start(f.session, 'run', { directTool: { name: 'run_current_dsl' } })
  await tick()
  assert.ok(f.session.pendingApproval.execution.bundleFingerprint)
  version++
  f.harness.resolveApproval(f.session.id, f.session.pendingApproval.id, true)
  await assert.rejects(running, /授权失效/)
  assert.equal(executed, 0)
})

test('a local dependency changed during final asynchronous preflight invalidates direct execution', async () => {
  let version = 1, builds = 0, executed = 0
  const f = rpaFixture({ executionDependencies: () => ({ child: version }),
    bundle: async (_, dsl) => { if (++builds === 2) version++; return dsl },
    execute: async () => { executed++; return { status: 'SUCCEEDED' } } })
  await assert.rejects(f.harness.start(f.session, 'run', { directTool: { name: 'run_current_dsl' }, executionConsent: true }), /授权失效|预检期间/)
  assert.equal(executed, 0)
})

test('persisted execution identity binds all subflows without applying stored business rules', async () => {
  const f = rpaFixture({ bundle: async (_, dsl) => ({ ...dsl, subflows: [{ flowCode: 'child', steps: [] }] }),
    execute: async () => ({ status: 'SUCCEEDED', executionCode: 'known', snapshots: [{ phase: 'FINAL', snapshotId: 'final', dom: { status: 'AVAILABLE' } }] }) })
  f.session.rules = [null]
  const result = await f.harness.start(f.session, 'run', { directTool: { name: 'run_current_dsl' }, executionConsent: true })
  assert.equal(result.status, 'SUCCEEDED')
  assert.equal(result.businessVerification, undefined)
  const run = f.session.runs[0]
  assert.notEqual(run.rootDslFingerprint, run.bundleFingerprint)
  assert.equal(run.fingerprint, run.bundleFingerprint)
  const received = f.writes.find(s => s.turn?.calls[0]?.phase === 'result_received')
  assert.equal(received.turn.calls[0].resultRecord.result.executionCode, 'known')
  const restarted = setup()
  restarted.harness.recover(received)
  assert.equal(received.runs[0].result.status, 'SUCCEEDED')
  assert.equal(received.runs[0].verification, undefined)
  assert.equal(restarted.harness.leases.quarantines.size, 0)
})

test('evidence write failure preserves the known result and never classifies it as unknown execution', async () => {
  const f = rpaFixture({ execute: async () => ({ status: 'SUCCEEDED', executionCode: 'known' }) })
  f.harness.store.writeArtifact = () => { throw new Error('disk unavailable') }
  await assert.rejects(f.harness.start(f.session, 'run', { directTool: { name: 'run_current_dsl' }, executionConsent: true }), /disk unavailable/)
  assert.equal(f.session.runs[0].result.executionCode, 'known')
  assert.equal(f.session.turn.calls[0].phase, 'result_received')
  assert.equal(f.session.executionUncertain, undefined)
  assert.equal(f.harness.leases.quarantines.size, 0)
  const recovered = clone(f.writes.at(-1))
  f.harness.recover(recovered)
  assert.equal(recovered.runs[0].evidenceState, 'failed')
})

test('incomplete model envelopes never dispatch tools or complete the turn', async () => {
  let executed = 0
  const f = setup({ tools: { run: tool('run', 'execute', async () => { executed++ }) }, complete: async () => ({
    message: { role: 'assistant', content: 'partial', tool_calls: [modelCall('run', 'partial')] },
    finishReason: 'length', completionStatus: 'incomplete', usage: { total_tokens: 12 }
  }) })
  await assert.rejects(f.harness.start(f.session, 'run'), /截断/)
  assert.equal(executed, 0)
  assert.equal(f.session.state, 'failed')
  assert.ok(!f.events.some(event => event.type === 'turn/completed'))
  assert.equal(f.session.turn.modelOutcome.finishReason, 'length')
})

for (const name of ['run_current_dsl', 'run_proposed_dsl', 'run_selected_step', 'continue_failed_run']) {
  test(name + ' submits the exact approved immutable bundle and records its identity', async () => {
    const { digest } = require('../src/agent/store')
    let submitted
    const f = rpaFixture({ bundle: async (_, dsl) => ({ ...dsl, subflows: [{ flowCode: 'child', steps: [] }] }),
      execute: async (_, body) => { submitted = body.dsl; return { status: 'SUCCEEDED' } },
      continue: async (_, previous, bundle) => { assert.equal(previous.result.executionCode, 'failed-1'); submitted = bundle; return { status: 'SUCCEEDED' } } })
    f.session.proposal = { baseRevision: 0, baseline: digest(f.session.dsl), dsl: clone(f.session.dsl) }
    if (name === 'continue_failed_run') f.session.runs = [{ taskCode: 'original', result: {
      status: 'FAILED', resumable: true, executionCode: 'failed-1', failedStepCode: 's'
    } }]
    const running = f.harness.start(f.session, 'run', { directTool: { name, args: name === 'run_selected_step' ? { stepCode: 's' } : {} } })
    await tick()
    const approval = clone(f.session.pendingApproval)
    f.harness.resolveApproval(f.session.id, approval.id, true)
    await running
    assert.equal(digest(submitted), approval.execution.bundleFingerprint)
    assert.equal(Object.isFrozen(submitted.subflows[0]), true)
    assert.equal(f.session.runs[0].bundleFingerprint, digest(submitted))
    assert.equal(f.session.turn.calls[0].phase, 'finalized')
    const persisted = clone(f.writes.find(s => s.turn?.calls[0]?.phase === 'result_persisted'))
    const restarted = setup()
    restarted.harness.recover(persisted)
    assert.equal(persisted.runs[0].result.status, 'SUCCEEDED')
    assert.equal(persisted.runs[0].evidenceState, 'persisted')
    assert.equal(restarted.harness.leases.quarantines.size, 0)
  })
}

test('recovery closes a known tool call with its durable result rather than an interruption error', async () => {
  let samples = 0
  const f = rpaFixture({ execute: async () => ({ status: 'SUCCEEDED', executionCode: 'known' }) })
  f.harness.complete = async () => samples++ ? { role: 'assistant', content: 'done' } : {
    role: 'assistant', content: '', tool_calls: [modelCall('run_current_dsl', 'run')]
  }
  const running = f.harness.start(f.session, 'run')
  await tick(); f.harness.resolveApproval(f.session.id, f.session.pendingApproval.id, true)
  await running
  const persisted = clone(f.writes.find(s => s.turn?.calls[0]?.phase === 'result_received'))
  const restarted = setup()
  restarted.harness.recover(persisted)
  restarted.harness.recover(persisted)
  const output = JSON.parse(persisted.messages.find(message => message.tool_call_id === 'run').content)
  assert.equal(output.status, 'SUCCEEDED')
  assert.equal(output.executionCode, 'known')
  assert.equal(persisted.runs.length, 1)
  assert.equal(output.error, undefined)
})

test('a failed first receipt checkpoint can preserve the known outcome on a later write', async () => {
  const f = rpaFixture({ execute: async () => ({ status: 'SUCCEEDED', executionCode: 'known' }) })
  const save = f.harness.store.save
  let failed = false
  f.harness.store.save = session => {
    if (!failed && session.turn?.calls[0]?.phase === 'result_received') { failed = true; throw new Error('checkpoint unavailable') }
    save(session)
  }
  await assert.rejects(f.harness.start(f.session, 'run', { directTool: { name: 'run_current_dsl' }, executionConsent: true }), /checkpoint unavailable/)
  const receipt = f.writes.find(session => session.turn?.calls[0]?.resultRecord)
  assert.equal(receipt.turn.calls[0].resultRecord.result.executionCode, 'known')
  assert.equal(f.session.executionUncertain, undefined)
})

test('a received result releases the executor before evidence archival and skips business assertions', async () => {
  let releaseNext, archived = false
  const f = rpaFixture({ execute: async (_, request) => {
    assert.equal(request.capture.retainFailureContext, false)
    return { status: 'SUCCEEDED', snapshots: [{ phase: 'FINAL', snapshotId: 'final',
      dom: { status: 'AVAILABLE', content: 'ok', url: 'https://example.test' } }] }
  }, query: async () => assert.fail('debug must not evaluate a business assertion'),
  archiveExecution: () => {
    releaseNext = f.harness.leases.acquire(f.session.scope.executor, 'another-session')
    archived = true
  } })
  f.session.rules = [{ id: 'ok', type: 'textContains', expected: 'ok' }]
  const result = await f.harness.start(f.session, 'run', { directTool: { name: 'run_current_dsl' }, executionConsent: true })
  assert.equal(result.status, 'SUCCEEDED')
  assert.equal(archived, true)
  assert.equal(f.session.runs[0].verification, undefined)
  assert.equal(f.harness.leases.owners.size, 1)
  releaseNext()
})

test('legacy observed checkpoints without a durable result remain quarantined on recovery', () => {
  const f = setup()
  f.session.state = 'running'
  f.session.turn = { id: 'legacy', calls: [{ id: 'run', effect: 'execute', phase: 'observed' }] }
  f.harness.recover(f.session)
  assert.equal(f.session.executionUncertain.callId, 'run')
  assert.equal(f.harness.leases.quarantines.size, 1)
})

test('tool lifecycle events persist a specific purpose and fall back for older callers', async () => {
  const f = rpaFixture()
  const purpose = '读取当前流程，确认个人解除合同分支的位置'
  await f.harness.start(f.session, 'inspect', { directTool: { name: 'get_flow_context', args: { _purpose: purpose } } })
  assert.equal(f.events.find(event => event.type === 'item/started').data.purpose, purpose)
  assert.equal(f.session.turn.calls[0].purpose, purpose)
  await f.harness.start(f.session, 'inspect', { directTool: { name: 'get_flow_context' } })
  assert.match(f.events.filter(event => event.type === 'item/started').at(-1).data.purpose, /读取当前流程/)
})

test('the last budgeted model request produces advice without exposing tools or exceeding the budget', async () => {
  let requests = 0, reads = 0
  const f = setup({ budgets: { modelCalls: 2 }, tools: { read: tool('read', 'read', async () => { reads++; return { variable: 'socialNumber', observed: 'mismatch' } }) },
    complete: async input => {
      requests++
      if (!input.finalOnly) return { role: 'assistant', content: '', tool_calls: [modelCall('read', 'read')] }
      assert.deepEqual(input.tools, [])
      assert.match(JSON.stringify(input.messages), /socialNumber/)
      return { role: 'assistant', content: '修改建议：核对 socialNumber 的变量来源；确认不一致后调整对应赋值步骤。尚缺实际账户参数证据。' }
    } })
  const result = await f.harness.start(f.session, '诊断并给出修改建议')
  assert.equal(requests, 2); assert.equal(reads, 1)
  assert.match(result, /修改建议/)
  assert.equal(f.session.state, 'budget_exhausted')
  assert.equal(f.session.turn.conclusion.source, 'model')
  assert.equal(f.events.at(-1).type, 'turn/budget_exhausted')
  assert.equal(f.session.messages.at(-1).content, result)
})

test('tool-budget exhaustion closes the pending batch and still produces actionable advice', async () => {
  const f = setup({ budgets: { toolCalls: 0, modelCalls: 3 }, tools: { read: tool('read', 'read', async () => assert.fail('no tools allowed')) },
    complete: async input => input.finalOnly ? { role: 'assistant', content: '建议核对最早失败步骤的输入变量，缺少 DOM，暂不修改定位。' }
      : { role: 'assistant', content: '', tool_calls: [modelCall('read', 'read')] } })
  await assert.rejects(f.harness.start(f.session, '诊断'), /工具调用预算/)
  assert.equal(f.session.state, 'budget_exhausted')
  assert.match(f.session.messages.at(-1).content, /建议核对/)
  assert.equal(f.session.turn.modelCalls, 2)
})

test('a failed or tool-requesting conclusion falls back to advice without executing anything', async () => {
  for (const fail of [false, true]) {
    let dispatched = 0
    const f = setup({ budgets: { modelCalls: 1 }, tools: { run: tool('run', 'execute', async () => { dispatched++ }) },
      complete: async () => {
        if (fail) throw new Error('model unavailable')
        return { role: 'assistant', content: '', tool_calls: [modelCall('run', 'forbidden')] }
      } })
    f.session.readOnly = true
    await f.harness.start(f.session, '分析引用流程')
    assert.equal(dispatched, 0)
    assert.equal(f.session.turn.conclusion.source, 'fallback')
    assert.match(f.session.messages.at(-1).content, /修改建议/)
    assert.match(f.session.messages.at(-1).content, /引用流程建议/)
    assert.equal(f.session.turn.modelCalls, 1)
  }
})

test('user cancellation during conclusion does not publish a late answer', async () => {
  const gate = deferred(), f = setup({ budgets: { modelCalls: 1 }, complete: async () => gate.promise })
  const running = f.harness.start(f.session, '分析')
  await tick(); await f.harness.stop(f.session)
  await assert.rejects(running, /已停止/)
  gate.resolve({ role: 'assistant', content: 'late suggestion' }); await tick()
  assert.equal(f.session.state, 'cancelled')
  assert.equal(f.session.turn.conclusion, undefined)
})

test('a timed-out investigation publishes local advice without issuing another model request', async () => {
  const gate = deferred(); let requests = 0
  const f = setup({ budgets: { durationMs: 10 }, complete: async () => { requests++; return gate.promise } })
  await assert.rejects(f.harness.start(f.session, '诊断'), /已停止/)
  assert.equal(requests, 1)
  assert.equal(f.session.state, 'budget_exhausted')
  assert.equal(f.session.turn.conclusion.source, 'fallback')
  assert.match(f.session.messages.at(-1).content, /修改建议/)
  gate.resolve({ role: 'assistant', content: 'late' })
})
