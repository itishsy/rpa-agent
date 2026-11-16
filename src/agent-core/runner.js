'use strict'
const { randomUUID } = require('node:crypto')
const { clone, digest, redact } = require('./store')
const { closePendingTail, validateModelMessage } = require('./history')
const { checkpoint, abortable, executorKey, authority, freeze } = require('./control')

const { ExecutorLeases } = require('./executor-leases')

class AgentRunner {
  constructor({ store, registry, complete, emit = () => {}, leases = new ExecutorLeases(), cancelExecution, budgets = {}, nativeRuns=new Set(), profile }) {
    Object.assign(this, { store, registry, complete, emit, leases, cancelExecution })
    this.budgets = { modelCalls: 24, toolCalls: 80, executions: 1, durationMs: 15 * 60 * 1000, contextChars: 90000, parallelReads: 4, ...budgets }
    this.active = new Map(); this.approvals = new Map(); this.recoveries = new Map()
    if (!profile) throw new Error('AgentRunner requires an explicit agent profile')
    this.profile = profile
    this.nativeRuns=nativeRuns
  }
  async runOnly(session,execute){
    if(this.active.has(session.id)||this.nativeRuns.has(session.id))throw new Error('当前会话仍在运行')
    this.nativeRuns.add(session.id)
    session.operation={mode:'run',state:'running',startedAt:new Date().toISOString()}
    try{
      this.event(session,'operation/started',{mode:'run'})
      const result=await execute()
      session.operation.state='completed'
      return result
    }catch(error){
      session.operation.state=session.executionUncertain?'unknown':'failed'
      session.operation.error=error.message
      throw error
    }finally{
      session.operation.finishedAt=new Date().toISOString()
      this.nativeRuns.delete(session.id)
      this.event(session,'operation/settled',{...session.operation})
    }
  }
  event(session, type, data = {}) {
    const event = { sequence: ++session.sequence, sessionId: session.id, turnId: session.turn?.id,
      type, data: redact(data), at: new Date().toISOString() }
    session.events.push(event); session.events = session.events.slice(-1000); session.updatedAt = event.at
    this.store.save(session)
    // A broken view must never convert a committed operation into a failed run.
    try { this.emit(clone(event)) } catch (_) {}
    return event
  }
  artifact(session, value, id = randomUUID(), {binaryContent=false}={}) {
    const safe = binaryContent ? {...redact({...value,content:undefined}),content:value.content} : redact(value)
    session.artifacts[id] = this.store.writeArtifact ? this.store.writeArtifact(session.id, id, safe) : safe
    const keys = Object.keys(session.artifacts)
    // Preserve evidence referenced by the five retained runs.
    const pinned = new Set([id, ...(session.attachments || []).map(file=>file.artifactId), ...session.runs.map(run => run.artifactId),
      ...(session.turn?.calls || []).filter(call => ['result_received', 'result_persisted'].includes(call.phase)).map(call => call.resultRecord?.artifactId)])
    for (const key of keys) if (Object.keys(session.artifacts).length > 60 && !pinned.has(key)) {
      if (this.store.deleteArtifact) this.store.deleteArtifact(session.id, key)
      delete session.artifacts[key]
    }
    this.store.save(session); return id
  }
  readArtifact(session, id) {
    if (!Object.hasOwn(session.artifacts, id)) throw new Error('证据不存在或已清理')
    const artifact = session.artifacts[id]
    return artifact.external && this.store.readArtifact ? this.store.readArtifact(session.id, id) : artifact
  }
  bounded(session, value) {
    const safe = redact(value === undefined ? null : value), text = JSON.stringify(safe)
    return text.length <= 16000 ? safe : { artifactId: this.artifact(session, safe), totalLength: text.length, preview: text.slice(0, 12000), truncated: true }
  }
  async approve(session, tool, args, turn, call, executionRequest) {
    checkpoint(turn.controller.signal)
    const id = randomUUID(), binding = digest(authority(session, tool, args))
    let cleanup
    const decision = new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('本轮已停止'), { code: 'CANCELLED' }))
      cleanup = () => { turn.controller.signal.removeEventListener('abort', abort); this.approvals.delete(id) }
      turn.controller.signal.addEventListener('abort', abort, { once: true })
      this.approvals.set(id, { sessionId: session.id, resolve, reject })
    })
    session.state = 'waiting_approval'; call.state = 'waiting_approval'
    session.pendingApproval = { id, turnId: turn.id, callId: call.id, tool: tool.name, args: redact(args), revision: session.revision }
    if (executionRequest) session.pendingApproval.execution = {
      taskCode: executionRequest.taskCode, flowCode: executionRequest.flowCode,
      executor: executionRequest.scope.executor, bundleFingerprint: executionRequest.bundleFingerprint,
      rootDslFingerprint: executionRequest.rootDslFingerprint,
      subflows: (executionRequest.bundle.subflows || []).map(flow => flow.flowCode),
      executionCode: executionRequest.previous?.result.executionCode
    }
    try {
      this.event(session, 'approval/requested', session.pendingApproval)
      if (!await decision) throw new Error('用户拒绝本次执行')
      checkpoint(turn.controller.signal)
      if (binding !== digest(authority(session, tool, args))) throw new Error('执行上下文已变化，授权失效')
    } finally {
      cleanup(); session.pendingApproval = null
      if (!turn.controller.signal.aborted) session.state = 'running'
      this.event(session, 'approval/resolved', { id, callId: call.id })
    }
  }
  resolveApproval(sessionId, id, allowed) {
    const pending = this.approvals.get(id)
    if (!pending || pending.sessionId !== sessionId) throw new Error('审批已过期或不属于当前会话')
    this.approvals.delete(id); pending.resolve(allowed === true)
  }
  steer(session, request, expectedTurnId, imageIds=[]) {
    const turn = this.active.get(session.id)
    if (!turn || turn.controller.signal.aborted) throw new Error('当前没有可接收补充指令的轮次')
    if (expectedTurnId && turn.id !== expectedTurnId) throw new Error('轮次已变化，补充指令未投递')
    if (turn.direct) throw new Error('直接运行期间请使用停止；补充指令适用于 Agent 对话轮次')
    if (!String(request).trim() || String(request).length > 32000) throw new Error('补充指令须为1至32000字符')
    const input = { id: randomUUID(), content: String(request), acceptedAt: new Date().toISOString() }
    session.pendingInputs ||= []
    if (session.pendingInputs.length >= 20) throw new Error('待处理补充指令过多，请等待本轮处理')
    session.pendingInputs.push(input); turn.executionConsent = false
    if(imageIds.length)turn.imageIds=[...new Set([...imageIds,...turn.imageIds])].slice(0,3)
    this.event(session, 'input/queued', { id: input.id, content: input.content })
    for (const [id, pending] of this.approvals) if (pending.sessionId === session.id) {
      this.approvals.delete(id); pending.reject(Object.assign(new Error('用户已补充指令，旧执行请求已撤销'), { code: 'STEERED' }))
    }
    return { inputId: input.id, turnId: turn.id, queued: true }
  }
  drainInputs(session) {
    for (const input of session.pendingInputs || []) session.messages.push({ role: 'user', content: input.content, inputId: input.id })
    const count = session.pendingInputs?.length || 0
    session.pendingInputs = []
    if (count) this.event(session, 'input/consumed', { count })
    return count
  }
  recordExecutionResult(session, turn, call, result, record) {
    if (call.resultRecord) return call.resultRecord
    // Persist a known outcome before evidence I/O or asynchronous verification.
    // An interrupted receipt is recoverable without replaying the external operation.
    const run = { ...clone(record), callId: call.id, turnId: turn.id,
      artifactId: randomUUID(), evidenceState: 'pending' }
    call.resultRecord = run; call.phase = 'result_received'; turn.executionStarted = false
    session.runs.unshift(run); session.runs = session.runs.slice(0, 5)
    try {
      this.event(session, 'execution/result_received', { callId: call.id, status: run.result.status })
      this.artifact(session, result, run.artifactId)
      run.evidenceState = 'persisted'; call.phase = 'result_persisted'
      this.event(session, 'execution/observed', { callId: call.id, artifactId: run.artifactId })
    } catch (error) {
      run.evidenceState = 'failed'; run.evidenceError = error.message
      call.phase = 'result_received'
      try { this.store.save(session) } catch (_) {}
      throw Object.assign(new Error('执行结果已收到，结果或证据保存失败：' + error.message), { code: 'RESULT_PERSISTENCE' })
    }
    return run
  }
  async invoke(session, name, args, turn, callId = randomUUID()) {
    checkpoint(turn.controller.signal)
    if (++turn.tools > this.budgets.toolCalls) throw Object.assign(new Error('工具调用预算已耗尽'), { code: 'TOOL_BUDGET' })
    const tool = this.registry.get(name)
    const purpose = redact((typeof args?._purpose === 'string' ? args._purpose.trim().slice(0, 300) : '') ||
      tool?.description || '执行请求的工具操作')
    const call = { id: callId, name, purpose, effect: tool?.effect || 'unknown', state: 'admitted', phase: 'preflight' }
    session.turn.calls.push(call)
    this.event(session, 'item/started', { callId, tool: name, purpose })
    let release, executionRequest
    try {
      if (!tool) throw new Error('未注册的工具：' + name)
      if(!this.profile.modePolicy(turn.mode).effects.includes(tool.effect))throw new Error(turn.mode==='generate'?'生成模式禁止真实执行':'当前模式不允许该工具操作')
      args = tool.validate(args) || args
      const admittedAuthority = digest(authority(session, tool, args))
      const context = { session, signal: turn.controller.signal, harness: this, turn }
      if (tool.effect === 'execute') {
        if (turn.mode === 'generate') throw new Error('生成模式禁止真实执行')
        if (turn.executions >= this.budgets.executions) throw Object.assign(new Error('本轮执行预算已耗尽'), { code: 'EXECUTION_BUDGET' })
        if (tool.prepareExecution) {
          executionRequest = freeze(clone(await tool.prepareExecution(args, context)))
          checkpoint(turn.controller.signal)
          if (digest(authority(session, tool, args)) !== admittedAuthority) throw new Error('执行预检期间上下文已变化，授权失效')
          call.executionRequest = clone(executionRequest); call.phase = 'prepared'
          this.store.save(session)
        }
        if (session.pendingInputs?.length) throw Object.assign(new Error('用户已补充指令，旧执行请求已撤销'), { code: 'STEERED' })
        if (!turn.executionConsent) await this.approve(session, tool, args, turn, call, executionRequest)
        checkpoint(turn.controller.signal)
        if (executionRequest) {
          const currentRequest = await tool.prepareExecution(args, context)
          checkpoint(turn.controller.signal)
          if (digest(currentRequest) !== digest(executionRequest)) throw new Error('执行包或依赖已变化，授权失效，请重新发起执行')
        }
        if (digest(authority(session, tool, args)) !== admittedAuthority) throw new Error('执行上下文已变化，授权失效')
        release = this.leases.acquire(session.scope.executor, session.id)
        turn.executions++; turn.executing = true
      }
      const beginExecution = context => {
        checkpoint(turn.controller.signal)
        if (session.pendingInputs?.length) throw Object.assign(new Error('用户已补充指令，旧执行请求已撤销'), { code: 'STEERED' })
        if (digest(authority(session, tool, args)) !== admittedAuthority) throw new Error('执行预检期间上下文已变化，授权失效')
        if (executionRequest && tool.executionDependencies(session) !== executionRequest.dependencyFingerprint) throw new Error('执行依赖已变化，授权失效')
        call.phase = 'submitted'; turn.executionStarted = true; turn.executionContext = clone(context || {})
        this.event(session, 'execution/started', { callId, context: turn.executionContext })
      }
      const executionObserved = ({ result, record } = {}) => {
        if (call.resultRecord) return call.resultRecord
        if (!record) record = { result: { status: result?.status || 'UNKNOWN', executionCode: result?.executionCode },
          taskCode: turn.executionContext?.taskCode, revision: session.revision,
          verification: { status: 'UNKNOWN', reason: '未完成业务核验' }, at: new Date().toISOString() }
        return this.recordExecutionResult(session, turn, call, result, record)
      }
      call.state = 'running'
      this.store.save(session)
      // Built-in RPA tools commit only after asynchronous task/DSL preflight.
      if (tool.effect === 'execute' && !tool.commitExecution) beginExecution({ taskCode: args.taskCode || session.taskCode })
      const work = tool.run(args, { session, signal: turn.controller.signal, harness: this, turn,
        beginExecution, executionObserved, executionRequest })
      // Only explicitly audited pure readers may outlive cancellation.
      const result = await (tool.effect === 'read' && tool.parallelSafe ? abortable(work, turn.controller.signal) : work)
      if (tool.effect === 'execute') { executionObserved({ result }); call.phase = 'finalized' }
      checkpoint(turn.controller.signal)
      call.state = 'completed'
      const output = this.bounded(session, result)
      this.event(session, 'item/completed', { callId, tool: name })
      return output
    } catch (error) {
      if (tool?.commitExecution && error.code === 'EXECUTOR_DEBUG_AUTH') {
        if (call.phase === 'submitted') {
          turn.executions--
          turn.executionStarted = false
        }
        call.phase = 'rejected'
      }
      if (['executing', 'submitted'].includes(call.phase)) {
        session.executionUncertain = { executor: session.scope.executor, turnId: turn.id, callId, reason: '执行请求未收到确定结果' }
        this.leases.quarantine(session.scope.executor, session.id); this.recoveries.set(session.id, session)
      }
      call.state = turn.controller.signal.aborted ? 'cancelled' : error.code === 'STEERED' ? 'skipped' : 'failed'
      this.event(session, 'item/' + call.state, { callId, tool: name, error: error.message })
      if (tool?.commitExecution && (!call.resultRecord || call.resultRecord.evidenceState === 'failed')) {
        const recorded = call.resultRecord?.conclusion
        const submitted = call.phase === 'submitted'
        const status = recorded?.status || (submitted ? 'UNKNOWN' : call.state === 'cancelled' ? 'CANCELLED' : 'FAILED')
        const summary = recorded?.content || (submitted ? '调试结果待确认，未收到执行器的最终结果'
          : call.state === 'cancelled' ? '调试已取消' : '调试未能启动')
        this.event(session, 'execution/completed', { callId, status, content: summary + ' · ' + error.message })
      }
      throw error
    } finally {
      if (release && turn.stopPromise) await turn.stopPromise.catch(() => {})
      if (tool?.effect === 'execute') turn.executing = false
      if (release) release()
    }
  }
  async conclude(session, turn, reason) {
    if (session.turn.conclusion) return session.turn.conclusion.content
    this.drainInputs(session)
    let content, source = 'fallback'
    try {
      checkpoint(turn.controller.signal)
      if (turn.modelCalls >= this.budgets.modelCalls) throw new Error('模型预算已耗尽')
      const goal = session.messages.filter(message => message.role === 'user').slice(-3).map(message => message.content).join('\n')
      const messages = this.profile.closingMessages(session, goal, reason, this.budgets.contextChars)
      turn.modelCalls++
      this.event(session, 'model/started', { step: turn.modelCalls, finalization: true })
      const response = await abortable(this.complete({ messages, tools: [], finalOnly: true }, turn.controller.signal,
        {session,modelName:turn.modelName,imageIds:turn.imageIds}), turn.controller.signal)
      checkpoint(turn.controller.signal)
      if (session.pendingInputs?.length) throw new Error('收尾期间收到新指令，旧结论已弃用')
      const message = response?.message || response
      if (response?.completionStatus === 'incomplete' || response?.refusal ||
          response?.finishReason != null && response.finishReason !== 'stop') throw new Error('结论响应未正常完成')
      if (validateModelMessage(message, new Set()).length || !message.content?.trim()) throw new Error('收尾只允许文本建议')
      content = message.content.slice(0, 16000); source = 'model'
    } catch (error) {
      if (turn.controller.signal.aborted && turn.stopReason !== 'timeout') throw error
      this.drainInputs(session)
      session.turn.conclusionError = error.message
      content = this.profile.fallbackConclusion(session, reason)
    }
    session.turn.conclusion = { content, source, reason }
    session.messages.push({ role: 'assistant', content })
    this.event(session, 'message/assistant', { content, finalization: true })
    return content
  }
  async start(session, request, { mode = this.profile.defaultMode, executionConsent = false, directTool, signal, writeToEditor = false, modelName, imageIds=[] } = {}) {
    if (typeof request !== 'string' || !request.trim() || request.length > 32000) throw new Error('需求须为1至32000字符')
    if(session.agentType&&session.agentType!==this.profile.agentType)throw new Error('会话不属于当前Agent类型')
    session.agentType=this.profile.agentType
    if (this.active.has(session.id)) throw new Error('当前会话仍在运行')
    if(this.nativeRuns.has(session.id))throw new Error('请等待执行器本次运行结束')
    const policy=this.profile.modePolicy(mode)
    if(!policy.model && (!policy.directTool || directTool?.name !== policy.directTool)) {
      throw new Error('仅运行不能启动模型轮次或调用其他工具')
    }
    const turn = { id: randomUUID(), controller: new AbortController(), tools: 0, executions: 0, modelCalls: 0, mode, modelName, imageIds, executionConsent, direct: !!directTool, ids: new Set() }
    turn.writeToEditor=policy.writeToEditor&&writeToEditor===true
    this.profile.initializeTurn?.({ session, turn, registry: this.registry })
    this.active.set(session.id, turn)
    if (session.executionUncertain) this.recoveries.set(session.id, session)
    const externalAbort = () => { this.stop(session, 'transport').catch(() => {}) }
    if (signal?.aborted) turn.controller.abort()
    else signal?.addEventListener('abort', externalAbort, { once: true })
    session.turn = { id: turn.id, mode, writeToEditor:turn.writeToEditor,state: 'running', calls: [], startedAt: new Date().toISOString() }
    session.state = 'running'; session.title = request.slice(0, 80)
    const timer = setTimeout(() => { this.stop(session, 'timeout').catch(() => {}) }, this.budgets.durationMs)
    try {
      this.drainInputs(session)
      session.messages.push({ role: 'user', content: request })
      this.event(session, 'turn/started', { turnId: turn.id, mode })
      if (directTool) {
        const result = await this.invoke(session, directTool.name, directTool.args || {}, turn)
        if (!session.turn.calls.at(-1)?.resultRecord?.conclusion) {
          session.messages.push({ role: 'assistant', content: '工具调用已完成：' + directTool.name })
        }
        session.state = 'completed'; this.event(session, 'turn/completed', { result }); return result
      }
      const schemas = this.registry.schemas(mode).filter(schema => policy.effects.includes(this.registry.get(schema.function.name)?.effect))
      for (let count = 0; count < this.budgets.modelCalls; count++) {
        checkpoint(turn.controller.signal); this.drainInputs(session)
        // Reserve the last permitted request for a text-only, evidence-based conclusion.
        if (turn.modelCalls >= this.budgets.modelCalls - 1) { await this.conclude(session, turn, '模型调查预算已到上限'); break }
        const selection = this.profile.selectTools?.({ session, turn, schemas, budgets: this.budgets }) || { schemas }
        const availableSchemas = selection.schemas
        const messages = this.profile.prepareContext(session, this.budgets.contextChars - JSON.stringify(availableSchemas).length - 1200)
        this.profile.decorateContext?.({ messages, selection })
        this.event(session, 'model/started', { step: count + 1, projectedChars: JSON.stringify(messages).length })
        turn.modelCalls++
        const response = await abortable(this.complete({ messages, tools: availableSchemas,
          ...(selection.toolChoice ? { toolChoice: selection.toolChoice } : {}) }, turn.controller.signal,
        {session,modelName:turn.modelName,imageIds:turn.imageIds}), turn.controller.signal)
        checkpoint(turn.controller.signal)
        // A sample made before accepted steering has no authority to execute tools.
        if (session.pendingInputs?.length) { this.event(session, 'model/superseded', { step: count + 1 }); continue }
        const message = response?.message || response
        const finishReason = response?.finishReason ?? null
        session.turn.modelOutcome = { finishReason, completionStatus: response?.completionStatus || 'legacy', usage: response?.usage || null }
        this.event(session, 'model/finished', { step: count + 1, ...session.turn.modelOutcome })
        if (response?.completionStatus === 'incomplete' || response?.refusal ||
            (finishReason !== null && !['stop', 'tool_calls'].includes(finishReason))) {
          throw Object.assign(new Error(finishReason === 'length' ? '模型回答因长度限制被截断，已保存进度；请继续或调整模型输出限制'
            : '模型响应未正常完成（' + (finishReason || 'refusal') + '），本轮未执行该响应中的工具'), { code: 'MODEL_INCOMPLETE' })
        }
        if (finishReason === 'tool_calls' && !message?.tool_calls?.length) throw Object.assign(new Error('模型声明了工具调用但未返回完整调用'), { code: 'MODEL_INCOMPLETE' })
        const calls = validateModelMessage(message, turn.ids)
        session.messages.push(message)
        if (!calls.length) {
          if (this.profile.acceptConclusion?.({ session, turn, message, runner: this }) === false) continue
          this.event(session, 'message/assistant', { content: message.content || '', finalization: true })
          session.state = 'completed'; this.event(session, 'turn/completed'); return message.content
        }
        this.event(session, 'message/assistant', { content: message.content || '' })
        const perform = async call => {
          if (session.pendingInputs?.length) return { error: '用户已补充指令，本批剩余工具未执行', code: 'STEERED' }
          const scopeError = this.profile.modelToolError?.(call.function.name)
          if (scopeError) return scopeError
          if (selection.allowed && !selection.allowed.has(call.function.name)) return {error:'当前阶段不允许扩展调用',code:'GENERATION_PHASE'}
          try { return await this.invoke(session, call.function.name, JSON.parse(call.function.arguments || '{}'), turn, call.id) }
          catch (error) {
            if (['TOOL_BUDGET', 'EXECUTION_BUDGET', 'RESULT_PERSISTENCE', 'EXECUTOR_DEBUG_AUTH'].includes(error.code)) throw error
            return { error: error.message, ...(error.code ? { code: error.code } : {}) }
          }
        }
        for (let index = 0; index < calls.length;) {
          checkpoint(turn.controller.signal)
          const group = [calls[index++]]
          const parallel = call => { const tool = this.registry.get(call.function.name); return tool?.effect === 'read' && tool.parallelSafe }
          if (parallel(group[0])) while (index < calls.length && parallel(calls[index]) && group.length < this.budgets.parallelReads) group.push(calls[index++])
          const results = await Promise.allSettled(group.map(perform))
          let fatal
          results.forEach((result, position) => {
            if (result.status === 'rejected') fatal ||= result.reason
            session.messages.push({ role: 'tool', tool_call_id: group[position].id,
              content: JSON.stringify(result.status === 'fulfilled' ? result.value : { error: result.reason.message, code: result.reason.code }) })
          })
          this.store.save(session)
          if (fatal) throw fatal
        }
      }
      if (!session.turn.conclusion) await this.conclude(session, turn, '模型调用预算已耗尽')
      session.state = 'budget_exhausted'; this.event(session, 'turn/budget_exhausted', { message: '已保存进度并给出修改建议，可在下一轮继续' })
      return session.turn.conclusion.content
    } catch (error) {
      // Repair only the unfinished tail; never match outputs from a prior turn.
      closePendingTail(session.messages)
      if (!directTool && (/_BUDGET$/.test(error.code || '') || turn.stopReason === 'timeout') &&
          (!turn.controller.signal.aborted || turn.stopReason === 'timeout')) {
        try { await this.conclude(session, turn, error.message) } catch (closingError) { error = closingError }
      }
      session.state = turn.controller.signal.aborted ? (turn.stopReason === 'timeout' ? 'budget_exhausted' : 'cancelled') : /_BUDGET$/.test(error.code || '') ? 'budget_exhausted' : 'failed'
      this.event(session, 'turn/' + session.state, { error: error.message, reason: turn.stopReason })
      throw error
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', externalAbort)
      session.turn.state = session.state; session.turn.tools = turn.tools; session.turn.executions = turn.executions; session.turn.modelCalls = turn.modelCalls
      session.turn.finishedAt = new Date().toISOString(); session.pendingApproval = null
      this.active.delete(session.id)
      for (const [id, pending] of this.approvals) if (pending.sessionId === session.id) { this.approvals.delete(id); pending.resolve(false) }
      this.store.save(session)
    }
  }
  stop(session, reason = 'user') {
    const turn = this.active.get(session.id)
    if (!turn) return Promise.resolve({ stopped: false })
    if (turn.stopPromise) return turn.stopPromise
    turn.stopReason = reason; session.state = 'stopping'
    const running = turn.executionStarted, context = turn.executionContext
    let persistenceError
    try { this.event(session, 'turn/interrupt_requested', { reason }) } catch (error) { persistenceError = error }
    turn.controller.abort()
    turn.stopPromise = (async () => {
      if (running && this.cancelExecution) {
        try { await this.cancelExecution(session, context) }
        catch (error) { this.event(session, 'execution/cancel_failed', { error: error.message }); throw error }
      }
      if (persistenceError) throw persistenceError
      return { stopped: true }
    })()
    return turn.stopPromise
  }
  recover(session) {
    this.recoveries.set(session.id, session)
    for (const call of session.turn?.calls || []) if (call.resultRecord) {
      if (call.resultRecord.evidenceState === 'deleted') continue
      let run = session.runs.find(run => run.callId === call.id && run.turnId === session.turn.id)
      if (!run) { run = clone(call.resultRecord); session.runs.unshift(run) }
      call.resultRecord = run
      if (session.artifacts[run.artifactId]) {
        run.evidenceState = 'persisted'
        if (call.phase === 'result_received') call.phase = 'result_persisted'
      } else if (run.evidenceState !== 'failed') {
        run.evidenceState = 'missing'; run.verification = { status: 'UNKNOWN', reason: '进程中断，执行结果已知但完整证据未保存' }
      }
    }
    session.runs.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    session.runs = session.runs.slice(0, 5)
    const unfinished = ['running', 'waiting_approval', 'stopping'].includes(session.state)
    if (unfinished && !this.active.has(session.id)) {
      const uncertain = session.turn?.calls?.find(call => call.effect === 'execute' &&
        (['executing', 'submitted'].includes(call.phase) || (call.phase === 'observed' && !call.resultRecord)))
      if (uncertain || !session.turn) session.executionUncertain ||= { executor: session.scope.executor, turnId: session.turn?.id,
        callId: uncertain?.id, reason: '进程中断时执行结果未知' }
      session.state = 'interrupted'
      const tail = session.messages.findLastIndex(message => message.role === 'assistant')
      const outputs = new Set(session.messages.slice(tail + 1).filter(message => message.role === 'tool').map(message => message.tool_call_id))
      for (const toolCall of session.messages[tail]?.tool_calls || []) {
        const record = session.turn?.calls?.find(call => call.id === toolCall.id)?.resultRecord
        if (record && !outputs.has(toolCall.id)) session.messages.push({ role: 'tool', tool_call_id: toolCall.id,
          content: JSON.stringify({ ...record.result, businessVerification: record.verification,
            artifactId: record.artifactId, evidenceState: record.evidenceState, recovered: true }) })
      }
      closePendingTail(session.messages); session.pendingApproval = null
      if (session.turn) session.turn.state = 'interrupted'
      for (const call of session.turn?.calls || []) {
        const run = call.resultRecord
        if (!run?.conclusion && (call !== uncertain || !this.registry.get(call.name)?.commitExecution)) continue
        if (session.events.some(event => event.type === 'execution/completed' && event.turnId === session.turn.id && event.data.callId === call.id)) continue
        this.event(session, 'execution/completed', { callId: call.id, ...(run?.conclusion || {
          status: 'UNKNOWN', content: '调试结果待确认，应用中断时尚未收到执行器的最终结果'
        }), artifactId: run?.evidenceState === 'persisted' ? run.artifactId : undefined })
      }
      this.event(session, 'session/interrupted', { message: '恢复记录，不自动重放真实执行；执行结果未知的记录不阻止手动发起新任务' })
    }
    if (session.executionUncertain) this.leases.quarantine(session.scope.executor, session.id)
    return session
  }
  reconcileExecutor(executor, evidence) {
    const key = executorKey(executor)
    if (evidence?.status !== 'STOPPED' || executorKey(evidence.executor) !== key) throw new Error('需要同一执行器的明确停止证据')
    if (this.leases.owners.has(key)) throw new Error('执行请求尚未结束，不能解除占用')
    for (const id of this.leases.quarantines.get(key) || []) {
      const session = this.recoveries.get(id)
      if (!session) throw new Error('无法定位待核对会话')
      session.executionUncertain = null
      for (const call of session.turn?.calls || []) if (['executing', 'submitted', 'observed'].includes(call.phase)) call.phase = 'reconciled'
      this.event(session, 'execution/reconciled', { executor, status: 'STOPPED' })
    }
    this.leases.quarantines.delete(key)
    return { reconciled: true }
  }
}
module.exports = { AgentRunner, ExecutorLeases }
