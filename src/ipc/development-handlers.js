'use strict'
const {prepareHtmlRequest,imageAttachments}=require('../services/html-attachments')
const {configuredModelNames}=require('../services/model-settings')
function registerDevelopmentHandlers({handle,takeovers,productionRuns,getState,requireSession,runSavedFlow,readAccounts,attachHtml,attachFile,harness,connection,control,sessionSnapshot,startCodex}) {
  handle('agent:start', async (id, input) => {
    const {settings,businessWriting}=getState()
    if(takeovers.size)throw Error('正在切换远程执行器调试模式，请稍候')
    if(productionRuns.has(id))throw new Error('请等待执行器本次运行结束，再使用Agent调试')
    if (businessWriting) throw new Error('正在保存业务配置，请稍后重试')
    const current = requireSession(id)
    const mode = input.mode || 'develop'
    if (mode !== 'generate' || input.directTool) {
      const taskCode = current.taskCode
      if (!taskCode) throw new Error('请先选择申报账户')
      const expected = input.taskCode ?? input.directTool?.args?.taskCode
      if (expected != null && expected !== taskCode) throw new Error('申报账户已变化，请重新选择后发送')
      const accounts = await readAccounts(current)
      if (requireSession(id) !== current || current.taskCode !== taskCode) throw new Error('申报账户已变化，请重新选择后发送')
      if (accounts.filter(account => account.taskCode === taskCode).length !== 1) {
        throw new Error('所选申报账户在当前执行器上已失效，请重新读取并选择账户')
      }
      if (takeovers.size || getState().businessWriting) throw new Error('工作区状态已变化，请稍后重试')
    }
    if(input.mode==='run'){
      if(input.directTool||input.writeToEditor||input.attachmentIds?.length)throw new Error('仅运行不接受步骤补丁、HTML附件或调试工具')
      return runSavedFlow(id)
    }
    if(input.mode==='dslRun'){
      return harness.start(current, String(input.request || '').trim(), {
        mode: 'dslRun', executionConsent: true, directTool: { name: 'run_current_dsl' }
      })
    }
    const engine=input.engine||settings.agentEngine?.engine||'model-api'
    if(!['model-api','codex-cli'].includes(engine))throw new Error('未知 Agent 引擎')
    const modelName=input.modelName||settings.modelName||configuredModelNames(settings)[0]
    if (!input.directTool && engine==='model-api' && (!settings.modelBaseUrl || !modelName)) throw new Error('请先配置模型 API')
    if (!input.directTool && engine==='model-api' && !configuredModelNames(settings).includes(modelName)) throw new Error('请选择已配置的模型')
    if (!['develop', 'generate'].includes(input.mode || 'develop')) throw new Error('未知模式')
    if (input.directTool && !['run_current_dsl', 'run_proposed_dsl', 'run_selected_step', 'continue_failed_run'].includes(input.directTool.name)) throw new Error('无效执行工具')
    if(harness.active.has(id))throw new Error('当前会话仍在运行，请使用运行中补充')
    const request = input.directTool ? String(input.request || '运行流程') : prepareHtmlRequest(current,input.request,input.attachmentIds,harness)
    const imageIds=input.directTool?[]:imageAttachments(current,input.attachmentIds)
    if(engine==='codex-cli'&&!input.directTool){
      if(!startCodex)throw new Error('Codex 引擎尚未初始化')
      return startCodex(current,request,{mode:input.mode||'develop',executionConsent:true,imageIds})
    }
    return harness.start(current, request, { mode: input.mode || 'develop', writeToEditor:input.writeToEditor===true,executionConsent: true, directTool: input.directTool,modelName,imageIds })
  })
  handle('workspace:attach-html',(id,input)=>{
    const current=requireSession(id)
    if(productionRuns.has(id))throw new Error('请等待当前流程运行结束后添加HTML附件')
    return attachHtml(current,input?.content,harness,input?.name)
  })
  handle('workspace:attach-file',(id,input)=>{
    const current=requireSession(id)
    if(productionRuns.has(id))throw new Error('请等待当前流程运行结束后添加附件')
    return attachFile(current,input)
  })
  handle('agent:stop', id => harness.stop(requireSession(id)))
  handle('agent:steer', (id, request, expectedTurnId, attachmentIds) => {
    if (typeof expectedTurnId !== 'string') throw new Error('请提供当前轮次编号')
    const current=requireSession(id)
    if(!harness.active.has(id)||current.turn?.id!==expectedTurnId)throw new Error('当前轮次已变化，请重新发送需求')
    const prepared=prepareHtmlRequest(current,request,attachmentIds,harness)
    return harness.steer(current,prepared,expectedTurnId,imageAttachments(current,attachmentIds))
  })
  handle('agent:reconcile', async id => {
    const current = requireSession(id), baseUrl = connection(current).baseUrl
    const status = await control.disconnectedStatus(baseUrl)
    if (status.status !== -1 || status.text !== '已停止') throw new Error('无法确认执行器已停止；请先在本机或远端停止执行器再核对，连接失败不能作为停止证据')
    return harness.reconcileExecutor(baseUrl, { executor: baseUrl, status: 'STOPPED' })
  })
  handle('agent:approve', (id, approvalId, allowed) => harness.resolveApproval(requireSession(id).id, approvalId, allowed))
  handle('agent:snapshot', id => sessionSnapshot(requireSession(id)))
  handle('agent:events', (id, after = 0) => requireSession(id).events.filter(event => event.sequence > after))
  handle('agent:artifact', (id, artifactId) => {
    const current = requireSession(id)
    if (!Object.hasOwn(current.artifacts, artifactId)) throw new Error('证据不存在')
    return harness.readArtifact(current, artifactId)
  })
}
module.exports={registerDevelopmentHandlers}
