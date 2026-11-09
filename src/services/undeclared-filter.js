const FIELDS = { appName: '应用', customerName: '客户名称', taskStatus: '任务状态' }

function splitKeywords(value) {
  return String(value || '').split(/[,，]/).map(keyword => keyword.trim().toLocaleLowerCase()).filter(Boolean)
}

function normalizeFilter(filter = {}) {
  const source = Array.isArray(filter.rules) ? filter.rules : Object.keys(FIELDS).map(field => ({
    field, operator: 'contains', keyword: filter[field]
  }))
  const rules = source.filter(rule => rule && Object.prototype.hasOwnProperty.call(FIELDS, rule.field))
    .map(rule => ({
      field: rule.field,
      operator: rule.operator === 'notContains' ? 'notContains' : 'contains',
      keyword: String(rule.keyword || '').trim()
    }))
    .filter(rule => splitKeywords(rule.keyword).length)
  return { rules, includePayFee: filter.includePayFee !== false }
}

function filterRows(rows, filter) {
  const selected = normalizeFilter(filter)
  return rows.filter(row => selected.rules.every(rule => {
    const value = String(row[rule.field] || '').toLocaleLowerCase()
    const matches = splitKeywords(rule.keyword).some(keyword => value.includes(keyword))
    return rule.operator === 'notContains' ? !matches : matches
  }) && (selected.includePayFee || row.isPayFeeTask !== true))
}

function filterLabels(filter) {
  const selected = normalizeFilter(filter)
  const labels = selected.rules.map(rule =>
    `${FIELDS[rule.field]}${rule.operator === 'notContains' ? '不包含' : '包含'}${rule.keyword}`)
  if (!selected.includePayFee) labels.push('不包含缴费任务')
  return labels
}

module.exports = { normalizeFilter, filterRows, filterLabels }
