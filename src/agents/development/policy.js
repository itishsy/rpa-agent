'use strict'
const {modePolicy} = require('./mode-policy')
const {prepareContext} = require('./context')
const {closingMessages,fallbackConclusion,formatDebugConclusion} = require('./conclusion')
const {evidenceBaseline} = require('./tools')
const {requestedRecording} = require('../../services/recording-evidence')
const allowed = new Set(['propose_dsl_patch','get_action_detail','search_actions','inspect_html_attachment','read_artifact','get_flow_context','update_plan'])
const explicitRunTools = new Set(['run_selected_step', 'run_proposed_dsl', 'continue_failed_run'])
const developmentProfile = {
  agentType:'development',defaultMode:'develop',modePolicy,prepareContext,closingMessages,fallbackConclusion,
  formatConclusion:formatDebugConclusion,
  initializeTurn({turn,registry,request}) {
    if (turn.mode !== 'generate') turn.recording = requestedRecording(request)
    turn.generationRequired=turn.mode==='generate'&&!turn.direct&&!!registry.get('propose_dsl_patch')
  },
  selectTools({session,turn,schemas,budgets}) {
    const generating=turn.generationRequired&&!turn.generationProduced&&(turn.generationReminder||turn.modelCalls>=8||turn.tools>=20)
    const definitionsRead=session.turn.calls.some(call=>call.name==='get_action_detail'&&call.state==='completed')
    const force=generating&&(turn.generationReminder&&definitionsRead||turn.modelCalls>=budgets.modelCalls-2)
    const canCollect = turn.mode === 'develop' && !turn.evidenceRerunDenied &&
      (turn.evidenceRerunRequests || 0) < budgets.evidenceReruns && evidenceBaseline(session)
    return {schemas:schemas.filter(item => !explicitRunTools.has(item.function.name) &&
        !(turn.executions && item.function.name === 'run_current_dsl') &&
        (item.function.name !== 'collect_dsl_evidence' || canCollect) &&
        (!generating || allowed.has(item.function.name))),
      allowed:generating?allowed:null,generating,
      ...(force?{toolChoice:{type:'function',function:{name:'propose_dsl_patch'}}}:{})}
  },
  modelToolError(name, { turn } = {}) {
    if (name === 'run_current_dsl' && turn?.executions) return {
      code: 'ALREADY_EXECUTED',
      error: '本轮已提交普通调试。请先读现场证据，若仍缺关键事实且可安全重跑，请用 collect_dsl_evidence 申请补充采证。'
    }
    if (explicitRunTools.has(name)) return {
      code: 'EXPLICIT_RUN_SCOPE_REQUIRED',
      error: '请在「会话与工具」中明确选择单步、候选或续跑。对话调试只允许运行当前完整 DSL。'
    }
  },
  decorateContext({messages,selection}) {
    if(selection.generating)messages[0]={...messages[0],content:messages[0].content+'\n当前必须收敛交付：停止扩展调查，使用已有HTML和已读指令定义调用propose_dsl_patch生成步骤。缺少参数的步骤禁用并注明待补充；已有证据的步骤先生成。只有真实指令或明确操作目标缺失时才说明无法生成的具体原因。'}
  },
  acceptConclusion({session,turn,message,runner}) {
    if(!turn.generationRequired||turn.generationProduced)return true
    if(!turn.generationReminder){turn.generationReminder=true;runner.event(session,'generation/required',{message:'正在将分析转为实际步骤'});return false}
    throw Object.assign(new Error('本轮未生成步骤。'+String(message.content||'请补充具体操作目标或所需指令定义').slice(0,1200)),{code:'GENERATION_INCOMPLETE'})
  }
}
module.exports={developmentProfile}
