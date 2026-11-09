// Shared by the IDE renderer and the MCP bridge. No model or transport dependency.
const STEP_FIELDS = new Set([
  'stepName', 'status', 'failedRetry', 'failedStrategy', 'skipTo', 'failedSkipTo',
  'falseSkipTo', 'skipCondition', 'waitBefore', 'waitAfter', 'timeout', 'maxExecuteNum'
])
const ARG_FIELDS = new Set(['actionArgs', 'targetArgs'])

const INSERT_FIELDS = new Set(['stepCode', 'actionCode', ...STEP_FIELDS, ...ARG_FIELDS])

function copy (value) { return JSON.parse(JSON.stringify(value)) }

function locations (steps) {
  const found = new Map()
  function visit (list, parent) {
    list.forEach((step, index) => {
      if (!step.stepCode || found.has(step.stepCode)) throw new Error('步骤 stepCode 不能为空且必须唯一')
      found.set(step.stepCode, { step, list, index, parent })
      const nested = step.body || step.children || []
      visit(nested, step)
    })
  }
  visit(steps, null)
  return found
}

function validateDsl (dsl) {
  if (!dsl || !Array.isArray(dsl.steps) || !dsl.steps.length) throw new Error('DSL 必须包含步骤')
  const found = locations(dsl.steps)
  found.forEach(({ step }) => {
    if (!step.stepName || !step.actionCode) throw new Error('步骤名称和指令不能为空')
    if (step.body && step.children) throw new Error('步骤不能同时包含 body 和 children')
    for (const field of ARG_FIELDS) {
      if (step[field] !== undefined && (!step[field] || typeof step[field] !== 'object' || Array.isArray(step[field]))) {
        throw new Error(field + ' 必须是对象')
      }
    }
  })
  return found
}

function applyOperations (source, operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 30) throw new Error('每次提交 1 至 30 个修改')
  const dsl = copy(source)
  for (const operation of operations) {
    const found = dsl.steps.length ? validateDsl(dsl) : new Map()
    const current = found.get(operation.stepCode)
    if (operation.op === 'set') {
      if (!current) throw new Error('未找到步骤: ' + operation.stepCode)
      if (STEP_FIELDS.has(operation.field)) {
        if (operation.field === 'stepName' && !String(operation.value || '').trim()) throw new Error('步骤名称不能为空')
        current.step[operation.field] = operation.value
      } else if (ARG_FIELDS.has(operation.field)) {
        if (!operation.key || typeof operation.key !== 'string') throw new Error('参数 key 不能为空')
        if (!current.step[operation.field]) current.step[operation.field] = {}
        current.step[operation.field][operation.key] = operation.value
      } else throw new Error('不允许修改字段: ' + operation.field)
    } else if (operation.op === 'insert') {
      const step = copy(operation.step || {})
      if (!step.stepCode || !step.stepName || !step.actionCode || found.has(step.stepCode)) throw new Error('新步骤需要唯一的 stepCode、stepName 和 actionCode')
      if (step.body || step.children) throw new Error('一次只能插入一个步骤')
      for (const field of Object.keys(step)) {
        if (!INSERT_FIELDS.has(field)) throw new Error('新步骤不支持字段: ' + field)
      }
      if (operation.parentStepCode) {
        const parent = found.get(operation.parentStepCode)
        if (!parent) throw new Error('未找到父步骤')
        const field = parent.step.actionCode === 'codeBlock' ? 'body' : 'children'
        if (!parent.step[field]) parent.step[field] = []
        parent.step[field].splice(operation.index === undefined ? parent.step[field].length : operation.index, 0, step)
      } else {
        dsl.steps.splice(operation.index === undefined ? dsl.steps.length : operation.index, 0, step)
      }
    } else if (operation.op === 'remove') {
      if (!current) throw new Error('未找到步骤: ' + operation.stepCode)
      current.list.splice(current.index, 1)
    } else if (operation.op === 'move') {
      if (!current) throw new Error('未找到步骤: ' + operation.stepCode)
      current.list.splice(current.index, 1)
      const next = validateDsl(dsl)
      const parent = operation.parentStepCode ? next.get(operation.parentStepCode) : null
      if (operation.parentStepCode && !parent) throw new Error('未找到目标父步骤')
      let list = dsl.steps
      if (parent) {
        const field = parent.step.actionCode === 'codeBlock' ? 'body' : 'children'
        if (!parent.step[field]) parent.step[field] = []
        list = parent.step[field]
      }
      list.splice(operation.index === undefined ? list.length : operation.index, 0, current.step)
    } else throw new Error('未知修改操作: ' + operation.op)
  }
  validateDsl(dsl)
  return dsl
}


module.exports = { applyOperations, validateDsl }
