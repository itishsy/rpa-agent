'use strict'
const CATEGORIES=Object.freeze(['流程配置','业务数据','等待操作','外部系统','执行环境','任务调度','证据不足'])
function classifyDiagnosis(reason,state) {
  const categories=[...String(reason).matchAll(/^\s*原因分类[：:]\s*(流程配置|业务数据|等待操作|外部系统|执行环境|任务调度|证据不足)\s*[。.]?\s*$/gm)].map(match=>match[1])
  return state==='completed'&&categories.length===1?categories[0]:'证据不足'
}
function canHandoff(analysis) {
  return analysis?.state==='completed'&&analysis.category==='流程配置'&&analysis.flowConfigurationIssue===true
}
module.exports={CATEGORIES,classifyDiagnosis,canHandoff}
