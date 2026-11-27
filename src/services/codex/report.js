'use strict'
const { z } = require('zod')
const fs = require('node:fs/promises')
const { redact } = require('../../agent-core/store')

const reportSchema = z.object({
  summary: z.string().min(1).max(12000),
  cause: z.string().max(4000).nullable(),
  executionStatus: z.enum(['NOT_RUN', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN']),
  evidenceIds: z.array(z.string().max(200)).max(10),
  candidateId: z.string().max(200).nullable(),
  validationStatus: z.literal('NOT_RUN'),
  remainingIssues: z.array(z.string().max(1000)).max(10)
}).strict()

function validateReport(value, session, turn) {
  const parsed = reportSchema.safeParse(value)
  if (!parsed.success) throw new Error('Codex 最终报告格式不符合约定，已保留执行证据与候选补丁')
  const report = parsed.data
  const run = session.runs.find(item => item.turnId === turn.id)
  const actualStatus = run ? ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.result.status) ? run.result.status : 'UNKNOWN' : 'NOT_RUN'
  if (report.executionStatus !== actualStatus) throw new Error('Codex 报告与本轮实际执行状态不一致，已保留执行证据')
  const evidence = new Map()
  for (const item of session.runs) if (item.evidenceState !== 'deleted') {
    evidence.set(item.artifactId, item.artifactId)
    if (item.result?.executionCode) evidence.set(String(item.result.executionCode), item.artifactId)
  }
  const referenced = report.evidenceIds, normalized = [...new Set(referenced.map(id => evidence.get(id)).filter(Boolean))]
  if (referenced.some(id => !evidence.has(id))) report.remainingIssues = [
    ...report.remainingIssues.slice(0, 9),
    'Codex 返回了无法核对的执行证据编号，已忽略无效引用；已保存的执行证据不受影响。'
  ]
  report.evidenceIds = normalized
  if (report.candidateId && (session.proposal?.id !== report.candidateId ||
      !session.turn.calls.some(call => call.name === 'propose_dsl_patch' && call.state === 'completed'))) {
    throw new Error('Codex 报告引用的候选补丁与本轮工作区不一致')
  }
  if (turn.mode === 'generate' && !turn.generationProduced) {
    if (!turn.toolBudgetExhausted) throw new Error('Codex 未生成候选步骤，请根据报告补充配置需求')
    report.remainingIssues = [...report.remainingIssues.slice(0, 9), '本轮尚未生成候选步骤，请根据上述分析补充缺失信息后继续配置。']
  }
  return redact(report)
}

function reportText(report) {
  return [report.summary, report.cause && '原因判断 · ' + report.cause,
    report.candidateId && '候选补丁已生成，请预览、审核并应用。',
    ...report.remainingIssues.map(issue => '待处理 · ' + issue)].filter(Boolean).join('\n\n')
}

async function readReport(file, session, turn) {
  let text
  try {
    const stat = await fs.stat(file)
    if (stat.size > 128000) throw new Error('Codex 最终报告超过大小限制')
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Codex 未生成最终报告，已保留本轮执行证据与候选补丁')
    throw error
  }
  let value
  try { value = JSON.parse(text) } catch (_) { throw new Error('Codex 最终报告不是有效的 JSON，已保留本轮执行证据') }
  return validateReport(value, session, turn)
}

module.exports = { reportSchema: z.toJSONSchema(reportSchema), validateReport, readReport, reportText }
