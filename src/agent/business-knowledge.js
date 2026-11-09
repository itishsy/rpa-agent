'use strict'
const { redact, digest } = require('./store')
const { currentRun } = require('./diagnosis')
const { businessContext } = require('./business-context')
function ruleSchema() {
  const { z } = require('zod')
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const parsed = new Date(value + 'T00:00:00Z')
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  }, '日期无效')
  return z.array(z.object({ id: z.string().trim().min(1).max(100), title: z.string().trim().min(1).max(200),
    region: z.string().trim().min(1).max(100), system: z.string().trim().min(1).max(100), businessType: z.string().trim().min(1).max(100),
    source: z.string().trim().min(1).max(1000), effectiveFrom: date, effectiveTo: date, verifiedAt: date,
    preconditions: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    successCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    rejectionAdvice: z.array(z.object({ reason: z.string().max(300), action: z.string().max(500) }).strict()).max(20)
  }).strict()).max(500).superRefine((rules, ctx) => {
    const error = message => ctx.addIssue({ code: 'custom', message })
    if (new Set(rules.map(rule => rule.id)).size !== rules.length) error('规则编号重复')
    for (const rule of rules) {
      if (rule.effectiveFrom > rule.effectiveTo || rule.verifiedAt > rule.effectiveTo) error('规则日期范围无效')
      if ([rule.region, rule.system, rule.businessType].some(value => value === '*')) error('地区规则必须有明确适用范围')
    }
  })
}
function applicability(context) {
  const scope = {}
  for (const key of ['region', 'system', 'businessType']) {
    const field = context?.fields?.[key]
    if (!field?.confirmed && (field?.conflict || !field?.candidates?.length)) return null
    const value = field.confirmed?.value ?? field.candidates[0].value
    if (!['string', 'number'].includes(typeof value)) return null
    scope[key] = String(value)
  }
  return scope
}
function searchRules(rules, context, query = '', now = new Date()) {
  const scope = applicability(context), today = now.toISOString().slice(0, 10)
  if (!scope) return { rules: [], fingerprint: digest([]), missingScope: true, reason: '地区、申报系统或业务类型缺失或存在冲突，请先核对业务上下文。' }
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const eligible = rules.filter(rule => Object.entries(scope).every(([key, value]) => rule[key] === value))
  const applicable = eligible.filter(rule => rule.effectiveFrom <= today && rule.effectiveTo >= today && rule.verifiedAt <= today)
  return { scope, fingerprint: digest([...applicable].sort((a, b) => a.id.localeCompare(b.id))),
    rules: applicable.filter(rule => terms.every(term => JSON.stringify(rule).toLowerCase().includes(term))).slice(0, 10),
  expiredCount: eligible.filter(rule => rule.effectiveTo < today).length,
  note: '规则为有来源的业务资料，不授予执行或修改权限；页面和官方状态仍需核验。' }
}
function makeCase(session, now = new Date()) {
  const run = session.runs?.[0]
  if (!currentRun(session, run) || run.result?.status !== 'SUCCEEDED' || run.verification?.status !== 'VERIFIED' || !run.artifactId || !session.artifacts?.[run.artifactId]) throw new Error('仅能归档当前账户、当前版本且业务已验证的完整执行')
  if (!(session.rules || []).some(rule => ['businessState', 'recordSet'].includes(rule.type))) throw new Error('请先配置官方办结状态或逐人对账断言并重新核验')
  const context = session.businessContext?.taskCode === session.taskCode && session.businessContext?.revision === session.revision ? session.businessContext : businessContext(session)
  const scope = applicability(context)
  if (!scope) throw new Error('归档前请补齐并核对地区、申报系统和业务类型')
  const at = now.toISOString()
  const diagnosis = session.diagnosis || null
  return redact({ id: digest({ sessionId: session.id, artifactId: run.artifactId }), status: 'VERIFIED_OUTCOME', ...scope,
    flowCode: session.scope.flowCode, flowName: session.dsl.flowName, createdAt: at, expiresAt: new Date(now.getTime() + 90 * 86400000).toISOString(),
    evidence: { sessionId: session.id, artifactId: run.artifactId, rootDslFingerprint: run.rootDslFingerprint, fingerprint: run.bundleFingerprint || run.fingerprint, revision: run.revision },
    verification: run.verification, diagnosis: diagnosis ? { summary: diagnosis.summary, changes: diagnosis.changes, status: 'HYPOTHESIS' } : null,
    attempts: (session.runs || []).slice(1).map(item => ({ status: item.result?.status, error: item.result?.error, artifactId: item.artifactId })),
    note: '已验证的是业务结果；诊断原因和历史尝试不自动视为因果证明。' })
}
function searchCases(cases, context, query = '', now = new Date(), rulesFingerprint) {
  const scope = applicability(context)
  if (!scope) return []
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return cases.filter(item => item.status === 'VERIFIED_OUTCOME' && item.expiresAt > now.toISOString() &&
    Object.entries(scope).every(([key, value]) => item[key] === value) && terms.every(term => JSON.stringify(item).toLowerCase().includes(term)))
    .map(item => {
      const staleReasons = []
      if (rulesFingerprint && item.rulesFingerprint !== rulesFingerprint) staleReasons.push('适用规则已变化，须重新核对')
      if (item.flowCode === context.flowCode && item.evidence.rootDslFingerprint && item.evidence.rootDslFingerprint !== context.dslFingerprint) staleReasons.push('同一流程版本已变化，须重新验证')
      return { ...item, needsRevalidation: staleReasons.length > 0, staleReasons }
    })
    .sort((a, b) => Number(a.needsRevalidation) - Number(b.needsRevalidation) || b.createdAt.localeCompare(a.createdAt)).slice(0, 10)
}
module.exports = { ruleSchema, applicability, searchRules, makeCase, searchCases }
