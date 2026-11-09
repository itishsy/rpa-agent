'use strict'
const { redact, digest } = require('./store')
const CATEGORIES = [
  { category: 'subject', pattern: /单位.*(?:不匹配|不一致|错误)|账户.*(?:拒绝|不匹配)|申报户|串户/, next: '核对任务账户与页面单位，并追踪 socialNumber、accountNumber 的来源及子流程传参。', suggestion: '先区分登录错户和参数覆盖；确认覆盖位置后只修改对应赋值，保留主体校验。' },
  { category: 'manual', pattern: /验证码|扫码|UKey|证书授权|人工/, next: '确认原执行是否仍在等待，以及需要人工完成的具体操作。', suggestion: '保留原执行编号；人工完成后查询原执行状态，再核对账户和页面，避免重新启动流程。' },
  { category: 'pending', pattern: /审核中|待审核|处理中|银行受理|待入账/, next: '查询原业务记录、交易流水和官方状态，确认是否仍在处理中。', suggestion: '记录为待处理并保留流水；依据官方状态安排后续查询，不重复提交或扣款。' },
  { category: 'data', pattern: /已参保|不在册|重复申报|基数|金额.*(?:不符|不一致)|所属期|退回/, next: '比对官方记录与任务的人员、所属期、基数及金额，读取完整退回原因。', suggestion: '定位到具体人员和不一致字段后修正源数据或明确适用的业务分支，不通过绕过核验消除报错。' },
  { category: 'page', pattern: /NoSuchElement|找不到元素|未找到元素|XPath|selector|stale element|元素不可见/i, next: '先确认实际页面、弹窗和 iframe，再定向检查失败定位的命中数量与可见性。', suggestion: '只有现场证明定位失效时才修改该步骤选择器或等待条件，并单步复核。' },
  { category: 'environment', pattern: /ECONN|连接超时|连接拒绝|执行器.*离线|网络异常/i, next: '检查当前执行器和目标系统连通性，区分尚未提交与提交后响应丢失。', suggestion: '恢复连接后先查询原业务结果；未知结果不直接重放提交。' }
]
function currentRun(session, run) {
  return !!run && run.revision === session.revision && run.taskCode === session.taskCode &&
    (!run.rootDslFingerprint || run.rootDslFingerprint === digest(session.dsl))
}
function diagnosisCard(session) {
  const run = session.runs?.[0], current = currentRun(session, run)
  const error = String(run?.result?.error || run?.result?.message || '')
  const rule = CATEGORIES.find(item => item.pattern.test(error))
  const repeated = error ? (session.runs || []).filter(item => item.taskCode === run.taskCode && String(item.result?.error || item.result?.message || '') === error).length : 0
  const recorded = session.diagnosis && session.diagnosis.binding === digest({ revision: session.revision, taskCode: session.taskCode, dsl: session.dsl, artifactId: run?.artifactId || null }) ? session.diagnosis : null
  return redact({ category: rule?.category || 'undetermined', current, artifactId: run?.artifactId,
    failedStepCode: run?.result?.failedStepCode, failedFlowCode: run?.result?.failedFlowCode,
    facts: run ? [{ status: run.result?.status, error, evidence: run.artifactId, current }] : [],
    hypothesisOnly: true, repeated, needsNewEvidence: repeated >= 2,
    next: !current && run ? '已有执行属于其他账户或版本，仅作历史线索；先读取当前上下文和相应现场。' : rule?.next || '定位最早异常，补齐失败步骤的实际参数、变量来源和页面证据。',
    suggestion: rule?.suggestion || '证据确认前保留配置；定位具体不一致后给出流程、步骤、字段、修改理由和复核方式。',
    missingEvidence: current ? ['根因仍需定向证据验证；错误分类不是根因结论'] : ['当前账户及版本的执行证据'], recorded })
}
function recordDiagnosis(session, value) {
  const run = session.runs?.[0]
  for (const id of value.evidenceIds) if (!Object.hasOwn(session.artifacts || {}, id)) throw new Error('诊断引用的证据不存在')
  session.diagnosis = { ...redact(value), status: 'HYPOTHESIS',
    binding: digest({ revision: session.revision, taskCode: session.taskCode, dsl: session.dsl, artifactId: run?.artifactId || null }) }
  return session.diagnosis
}
module.exports = { diagnosisCard, recordDiagnosis, currentRun }
