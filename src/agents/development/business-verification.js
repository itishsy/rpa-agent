'use strict'
function assertionSchema() {
  const { z } = require('zod')
  const states = z.array(z.string().trim().min(1).max(200)).max(30)
  return z.array(z.object({
    id: z.string().min(1).max(100), type: z.enum(['textContains', 'textAbsent', 'urlContains', 'elementExists', 'receipt', 'numberEquals', 'textEquals', 'businessState', 'recordSet']),
    expected: z.union([z.string(), z.number()]).optional(), selector: z.string().optional(), url: z.string().optional(), framePath: z.string().optional(),
    businessField: z.enum(['subject', 'account', 'period', 'personCount', 'amount']).optional(),
    acceptedValues: states.optional(), pendingValues: states.optional(), failedValues: states.optional(),
    keySelector: z.string().optional(), valueSelector: z.string().optional(),
    records: z.array(z.object({ key: z.string().trim().min(1).max(200), value: z.string().trim().min(1).max(200) }).strict()).min(1).max(500).optional()
  }).strict()).max(30).superRefine((rules, ctx) => {
    const error = message => ctx.addIssue({ code: 'custom', message })
    if (new Set(rules.map(rule => rule.id)).size !== rules.length) error('断言编号重复')
    for (const rule of rules) {
      if (rule.businessField && !['numberEquals', 'textEquals'].includes(rule.type)) error('业务字段须使用精确文字或数字核对')
      if (['personCount', 'amount'].includes(rule.businessField) && rule.type !== 'numberEquals') error('人数金额须使用数字核对')
      if (['subject', 'account', 'period'].includes(rule.businessField) && rule.type !== 'textEquals') error('主体、账户和所属期须使用精确文字核对')
      if (['elementExists', 'receipt', 'numberEquals', 'textEquals', 'businessState', 'recordSet'].includes(rule.type) && !rule.selector?.trim()) error('请填写选择器')
      if (!['elementExists', 'receipt', 'businessState', 'recordSet'].includes(rule.type) && String(rule.expected ?? '').trim() === '') error('请填写预期值')
      if (rule.type === 'numberEquals' && !Number.isFinite(Number(rule.expected))) error('预期值必须是数字')
      if (rule.type === 'businessState' && !rule.acceptedValues?.length) error('请明确办结状态')
      const groups = [...(rule.acceptedValues || []), ...(rule.pendingValues || []), ...(rule.failedValues || [])]
      if (new Set(groups).size !== groups.length) error('成功、待处理与失败状态不能重叠或重复')
      if (rule.type === 'recordSet') {
        if (!rule.keySelector?.trim() || !rule.valueSelector?.trim() || !rule.records?.length) error('逐人对账须填写行内人员标识、状态选择器和预期记录')
        if (rule.records && new Set(rule.records.map(item => item.key)).size !== rule.records.length) error('预期人员标识重复')
        if (rule.records?.some(item => [...(rule.pendingValues || []), ...(rule.failedValues || [])].includes(item.value))) error('预期办结值不能属于待处理或失败状态')
      }
    }
    const count = rules.find(rule => rule.businessField === 'personCount')
    if (count && rules.some(rule => rule.type === 'recordSet' && rule.records?.length !== Number(count.expected))) error('完整批次的人员记录数须与预期人数一致')
  })
}
const clean = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : null
function classify(value, expected, rule) {
  if (value === null) return 'UNKNOWN'
  if (rule.pendingValues?.includes(value)) return 'PENDING'
  if (rule.failedValues?.includes(value)) return 'FAILED'
  return value === expected ? 'PASSED' : 'FAILED'
}
async function verifyStructured(rule, content, query) {
  if (rule.type === 'recordSet') {
    const rows = await query(content, rule.selector, { key: rule.keySelector, value: rule.valueSelector })
    if (!Array.isArray(rows)) return { state: 'UNKNOWN', reason: '人员表格不可读取' }
    const actual = new Map(), duplicates = new Set()
    let incomplete = false
    for (const row of rows) {
      const key = clean(row?.key), value = clean(row?.value)
      if (!key) { incomplete = true; continue }
      if (actual.has(key)) duplicates.add(key)
      actual.set(key, value)
    }
    const expectedKeys = new Set(rule.records.map(item => item.key))
    const items = rule.records.map(item => ({ key: item.key, expected: item.value, actual: actual.get(item.key) ?? null,
      state: !actual.has(item.key) || duplicates.has(item.key) ? 'UNKNOWN' : classify(actual.get(item.key), item.value, rule) }))
    const unexpected = [...actual.keys()].filter(key => !expectedKeys.has(key))
    const counts = Object.fromEntries(['PASSED', 'FAILED', 'PENDING', 'UNKNOWN'].map(state => [state, items.filter(item => item.state === state).length]))
    const state = counts.FAILED || unexpected.length ? 'FAILED' : incomplete || duplicates.size || counts.UNKNOWN ? 'UNKNOWN' : counts.PENDING ? 'PENDING' : 'PASSED'
    return { state, items, counts, unexpected, duplicateKeys: [...duplicates], incomplete }
  }
  const values = await query(content, rule.selector)
  if (!Array.isArray(values) || values.length !== 1 || clean(values[0]) === null) return { state: 'UNKNOWN' }
  const value = clean(values[0])
  if (rule.type === 'textEquals') return { state: value === clean(rule.expected) ? 'PASSED' : 'FAILED', actual: value, expected: rule.expected }
  return { state: rule.pendingValues?.includes(value) ? 'PENDING' : rule.failedValues?.includes(value) ? 'FAILED'
    : rule.acceptedValues?.includes(value) ? 'PASSED' : 'UNKNOWN', actual: value }
}
module.exports = { assertionSchema, verifyStructured }
