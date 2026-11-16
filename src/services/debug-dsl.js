const {flowMetadata,dslMetadata}=require('./flow-metadata')
const { createHash } = require('node:crypto')
const INTEGER_FIELDS = [
  'failedRetry', 'failedStrategy', 'waitBefore', 'waitAfter',
  'timeout', 'maxExecuteNum', 'status'
]
const EXECUTION_FIELDS = [
  'failedRetry', 'failedStrategy', 'skipTo', 'failedSkipTo',
  'falseSkipTo', 'skipCondition', 'waitBefore', 'waitAfter',
  'timeout', 'maxExecuteNum', 'status'
]

function jsonObject (value, label) {
  if (value === undefined || value === null || value === '') return {}
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch (error) {
      throw new Error(label + '不是有效的 JSON 对象')
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(label + '必须是 JSON 对象')
  }
  return parsed
}

function stepArgs (source, kind) {
  const fields = source[kind + 'VOS']
  if (!Array.isArray(fields) || !fields.length) return jsonObject(source[kind], kind)
  const args = { ...jsonObject(source[kind], kind) }
  fields.forEach(field => {
    if (!field.fieldKey) return
    const hidden = field.isHideCust === true || field.isHideCust === 1 || field.isHideCust === '1'
    if (hidden) args[field.fieldKey] = ''
    else if (field.fieldValue !== undefined) args[field.fieldKey] = field.fieldValue
  })
  return args
}

function integerOrNull (value, label) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  if (!Number.isInteger(number)) throw new Error(label + '必须是整数')
  return number
}

function flattenSources (stepList) {
  const rows = []
  ;(stepList || []).forEach(parent => {
    rows.push(parent)
    ;(parent.list || []).forEach(child => rows.push(child))
  })
  return rows
}

function addIfPresent (target, field, value) {
  if (value !== undefined && value !== null && value !== '') target[field] = value
}

function enabledDebugSteps(steps, native = false) {
  return (steps || []).flatMap(step => {
    const block = step.actionCode === 'codeBlock'
    const field = native ? 'list' : block ? 'body' : 'children'
    const disabled = step.status === 0 || step.status === '0'
    if (disabled && block) return []
    const children = enabledDebugSteps(step[field], native)
    // Ordinary children are in the same executor list and keep their own status.
    if (disabled) return children
    const result = { ...step }
    if (children.length || (block && step[field])) result[field] = children
    else delete result[field]
    return [result]
  })
}

function buildDebugDsl (appCode, flowCode, appDetail, stepList, selectedStep, options = {}) {
  if (!appCode || !flowCode) throw new Error('应用编码或流程编码为空')
  const detail = appDetail || {}
  const allSources = flattenSources(stepList)
  if (!allSources.length && !options.draft) throw new Error('流程没有启用的步骤')
  if (selectedStep && !allSources.includes(selectedStep)) throw new Error('未找到要运行的步骤')
  const usedCodes = new Set(allSources.map(source => source.stepCode).filter(Boolean))
  if (usedCodes.size !== allSources.filter(source => source.stepCode).length) throw new Error('步骤编码重复，不能生成完整 DSL')
  const usedNames = new Set()

  function convertStep (source, position, listKey) {
    if (!source.stepName || !String(source.stepName).trim()) throw new Error('第' + position + '个步骤缺少步骤名称')
    if (!source.actionCode) throw new Error('步骤“' + source.stepName + '”缺少指令')
    const nameKey = listKey + '/' + source.stepName
    if (usedNames.has(nameKey)) throw new Error('步骤名称重复：' + source.stepName)
    usedNames.add(nameKey)
    let stepCode = source.stepCode
    if (!stepCode) {
      let suffix = allSources.indexOf(source) + 1
      stepCode = 'debug-step-' + suffix
      while (usedCodes.has(stepCode)) stepCode = 'debug-step-' + ++suffix
      usedCodes.add(stepCode)
    }
    const step = {
      stepCode,
      stepName: source.stepName,
      actionCode: source.actionCode
    }
    const actionArgs = stepArgs(source, 'actionArgs')
    const targetArgs = stepArgs(source, 'targetArgs')
    if (Object.keys(actionArgs).length) step.actionArgs = actionArgs
    if (Object.keys(targetArgs).length) step.targetArgs = targetArgs
    EXECUTION_FIELDS.forEach(field => {
      let value = source[field]
      if (INTEGER_FIELDS.includes(field)) value = integerOrNull(value, source.stepName + '的' + field)
      if (field === 'status' && (value === null || value === 1)) return
      if (field === 'failedRetry' && (value === null || value === 1)) return
      if (field === 'failedStrategy' && (value === null || value === 0)) return
      if (['waitBefore', 'waitAfter', 'timeout'].includes(field) && value === 0) return
      addIfPresent(step, field, value)
    })
    return step
  }

  function convertParent (source, position) {
    const step = convertStep(source, position, 'main')
    const children = source.list || []
    if (source.actionCode === 'codeBlock' && !children.length && !options.draft) throw new Error('代码块“' + source.stepName + '”没有步骤或块内步骤均已禁用')
    if (children.length) {
      const field = source.actionCode === 'codeBlock' ? 'body' : 'children'
      const listKey = field === 'body' ? step.stepCode : 'main'
      step[field] = children.map((child, index) => convertStep(child, position + '.' + (index + 1), listKey))
    }
    return step
  }

  let steps
  if (selectedStep) {
    const parent = (stepList || []).find(item => item === selectedStep || (item.list || []).includes(selectedStep))
    steps = [parent === selectedStep
      ? convertParent(selectedStep, allSources.indexOf(selectedStep) + 1)
      : convertStep(selectedStep, allSources.indexOf(selectedStep) + 1, 'main')]
    try { require('../shared/step-structure').cleanJumps({ steps }, true) }
    catch (error) { throw new Error('选中步骤的跳转超出单步范围，请运行当前完整流程。' + error.message) }
  } else {
    steps = (stepList || []).map((source, index) => convertParent(source, index + 1))
  }
  const dsl = {
    appCode,
    appName: detail.appName || appCode,
    flowCode,
    flowName: detail.flowName || flowCode,
    steps
  }
  const appArgs = flowMetadata(jsonObject(detail.appArgs, '应用参数'),{appArgs:true})
  if (Object.keys(appArgs).length) dsl.appArgs = appArgs
  addIfPresent(dsl, 'declareSystem', detail.declareSystem)
  addIfPresent(dsl, 'serviceItem', integerOrNull(detail.serviceItem, '业务事项'))
  addIfPresent(dsl, 'tagCode', detail.tagCode)
  addIfPresent(dsl, 'runSupport', detail.runSupport)
  addIfPresent(dsl, 'sessionKeep', integerOrNull(detail.sessionKeep, '会话维持'))
  return dsl
}

function nestDebugSteps (flatSteps) {
  if (!Array.isArray(flatSteps)) throw new Error('流程步骤必须为数组')
  const nested = []
  const nestedParents = new WeakSet()
  let parent = null
  flatSteps.forEach(source => {
    if (!source || typeof source !== 'object') throw new Error('流程步骤格式无效')
    const level = source.level === undefined || source.level === null || source.level === '' ? 0 : Number(source.level)
    if (![0, 1].includes(level)) throw new Error('流程步骤层级仅支持0和1')
    if (source.list !== undefined && !Array.isArray(source.list)) throw new Error('子步骤必须为数组')
    const children = source.list || []
    if (level === 1 && children.length) throw new Error('子步骤不能再包含下一级步骤')
    const step = Object.assign({}, source, { level, list: children.map(child => {
      if (!child || (child.list !== undefined && !Array.isArray(child.list)) || (child.list || []).length ||
          (child.level !== undefined && Number(child.level) !== 1)) throw new Error('子步骤层级无效')
      return { ...child, level: 1, list: [] }
    }) })
    if (level === 1) {
      if (!parent) throw new Error('子步骤缺少所属父步骤')
      if (nestedParents.has(parent)) throw new Error('流程步骤混用嵌套和扁平层级，无法确定完整顺序')
      parent.list.push(step)
    }
    else {
      parent = step
      if (children.length) nestedParents.add(parent)
      nested.push(step)
    }
  })
  // Native/platform rows may reuse codes after copying steps. Preserve every
  // occurrence, but give editor maps and debug traces an unambiguous identity.
  // Do this only on native input; authored DSL must still pass strict validation.
  const rows = flattenSources(nested)
  const reserved = new Set(rows.map(row => row.stepCode).filter(Boolean))
  const seen = new Set(), seenIds = new Set()
  rows.forEach((row, index) => {
    const original = row.stepCode
    if (!original || seen.has(original)) {
      let salt = 0, code
      do {
        const identity = JSON.stringify([row.flowCode || '', original || null, row.id ?? null, index, salt++])
        code = 'debug-step-' + createHash('sha256').update(identity).digest('hex').slice(0, 24)
      } while (reserved.has(code))
      row.sourceStepCode = original || null
      row.stepCode = code
      reserved.add(code)
      // A repeated database row cannot be saved twice with the same primary key.
      if (row.id !== undefined && seenIds.has(row.id)) delete row.id
      for (const child of row.list || []) if (original && child.groupCode === original) child.groupCode = code
    }
    seen.add(row.stepCode)
    if (row.id !== undefined) seenIds.add(row.id)
  })
  return nested
}

function referencedDebugFlows (dsl, options = {}) {
  const names = new Set()
  function visit (steps, parentActive = true) {
    ;(steps || []).forEach(step => {
      const active = parentActive && step.status !== 0
      if (active && (step.actionCode === 'subFlow' || step.actionCode === 'finalFlow')) {
        const flowName = (step.actionArgs || {}).flowName
        if (!flowName) {
          if(options.onMissing)options.onMissing(step)
          else if (active) throw new Error('步骤“' + step.stepName + '”缺少调用流程名称')
        }else names.add(flowName)
      }
      // 普通子步骤仍会执行，即使父步骤被禁用；代码块 body 则只在调用步骤启用时执行。
      visit(step.children, parentActive)
      if (active) visit(step.body, active)
    })
  }
  visit(dsl.steps)
  return Array.from(names)
}
function assertCompleteDebugDsl(dsl) {
  if (!dsl || typeof dsl !== 'object') throw new Error('DSL 必须为流程对象')
  if (dsl.subflows !== undefined && !Array.isArray(dsl.subflows)) throw new Error('subflows 必须为数组')
  const flows = [dsl, ...(dsl.subflows || [])], codes = new Set(), names = new Set()
  let count = 0
  for (const flow of flows) {
    if (!flow?.flowCode || !flow.flowName || !Array.isArray(flow.steps) || !flow.steps.length) throw new Error('流程编码、名称和非空步骤不可缺失')
    if (codes.has(flow.flowCode) || names.has(flow.flowName)) throw new Error('打包流程编码或名称重复：' + flow.flowName)
    codes.add(flow.flowCode); names.add(flow.flowName)
    const stepCodes = new Set()
    const visit = (steps, depth = 0) => {
      for (const step of steps) {
        if (!step?.stepCode || !step.stepName || !step.actionCode || stepCodes.has(step.stepCode)) throw new Error('步骤标识缺失或重复：' + flow.flowName)
        stepCodes.add(step.stepCode); count++
        for (const field of ['actionArgs', 'targetArgs']) if (step[field] !== undefined) jsonObject(step[field], field)
        if (step.body && step.children) throw new Error('步骤不能同时含有 body 和 children')
        if (step.body && step.actionCode !== 'codeBlock') throw new Error('body 只能用于代码块')
        if (step.actionCode === 'codeBlock' && (!Array.isArray(step.body) || !step.body.length)) throw new Error('代码块缺少 body')
        const children = step.body || step.children || []
        if (!Array.isArray(children) || (depth && children.length)) throw new Error('步骤嵌套超过执行器支持的层级')
        visit(children, depth + 1)
      }
    }
    visit(flow.steps)
    require('../shared/step-structure').cleanJumps(flow, true)
  }
  if (count > 5000) throw new Error('流程步骤总数不能超过5000')
  for (const flow of flows) for (const name of referencedDebugFlows(flow)) if (!names.has(name)) {
    throw new Error('DSL 调用闭包不完整：' + flow.flowName + ' → ' + name)
  }
  return dsl
}
/** 按主流程引用关系，递归加载被调用流程及其子流程。 */
async function loadReferencedDebugFlows (dsl, appCode, api, options = {}) {
  // Current executor: resolve calls only from the current application's rows.
  const cleaned=dslMetadata(dsl)
  cleaned.steps = enabledDebugSteps(cleaned.steps)
  for(const key of Object.keys(dsl))delete dsl[key]
  Object.assign(dsl,cleaned)
  const rawFlows=await api.listFlows(appCode)
  if(!Array.isArray(rawFlows))throw new Error('无法获取当前应用流程列表')
  const currentFlows=rawFlows.map(flowMetadata)
  const inspectionDiagnostics=[]
  const references=definition=>referencedDebugFlows(definition,{
    ...(options.inspect?{onMissing:step=>inspectionDiagnostics.push({flowCode:definition.flowCode,flowName:definition.flowName,
      stepCode:step.stepCode,message:'步骤“'+step.stepName+'”缺少调用流程名称'})}:{})})
  const pending = references(dsl).map(flowName => ({ flowName, path: [dsl.flowName, flowName] }))
  // Reading one called flow must not depend on executable validation of its
  // siblings or descendants. Reachability and ownership resolution still apply.
  const preferred=currentFlows.find(flow=>flow.flowCode===options.targetFlowCode)?.flowName
  if(options.inspect&&preferred)pending.sort((a,b)=>Number(b.flowName===preferred)-Number(a.flowName===preferred))
  const loaded = new Map([[dsl.flowName, dsl.flowCode]])
  dsl.subflows = []
  function unique(flows, name, where) {
    const matches = flows.filter(flow => flow.flowName === name)
    const identities = new Set(matches.map(flow => flow.flowCode))
    if (identities.size > 1) throw new Error('调用流程同名不唯一：' + name + '（' + where + '）')
    return matches[0]
  }
  async function resolve(name,path) {
    const flow=unique(currentFlows,name,'当前应用'+appCode)
    if(flow)return {flow,foundInApp:appCode}
    throw new Error('未找到当前应用的调用流程：'+name+'（调用路径：'+path.join(' → ')+'）')
  }
  while (pending.length) {
    const { flowName, path } = pending.shift()
    try {
    const { flow, foundInApp } = await resolve(flowName,path)
    if (loaded.has(flowName)) {
      if (loaded.get(flowName) !== flow.flowCode) throw new Error('打包存在同名流程来源冲突：' + path.join(' → '))
      continue
    }
    if (loaded.size >= 5000) throw new Error('调用流程数量超过完整打包限制')
    // Apply local drafts and candidates before discovering their descendants.
    const draft = api.overrideFlow ? await api.overrideFlow(flow, foundInApp) : null
    const rawSteps=draft?null:await api.listSteps(flow)
    if(!draft&&!Array.isArray(rawSteps))throw new Error('流程步骤必须为数组：'+flowName)
    if (!draft && (!rawSteps || !rawSteps.length)) {
      throw new Error('无法获取调用流程步骤：' + flowName)
    }
    let definition = draft ? { ...flow, appCode: foundInApp, steps: enabledDebugSteps(draft.steps) }
      : buildDebugDsl(foundInApp, flow.flowCode, flow, enabledDebugSteps(nestDebugSteps(rawSteps), true), undefined, { draft: !!options.inspect })
    if (api.prepareFlow&&!options.inspect) definition = await api.prepareFlow(definition, flow, foundInApp)
    if (definition.flowCode !== flow.flowCode || definition.flowName !== flowName) throw new Error('子流程转换改变了调用身份：' + path.join(' → '))
    dsl.subflows.push({
      flowCode: definition.flowCode,
      flowName: definition.flowName,
      steps: definition.steps,
    })
    loaded.set(flowName, flow.flowCode)
    if(options.inspect&&flow.flowCode===options.targetFlowCode)break
    references(definition).forEach(name => {
      pending.push({ flowName: name, path: [...path, name] })
    })
    }catch(error){
      if(!options.inspect)throw error
      inspectionDiagnostics.push({flowName,path,message:error.message})
    }
  }
  if(options.inspect)return {...dsl,inspectionDiagnostics}
  return assertCompleteDebugDsl(dsl)
}

module.exports = { buildDebugDsl, enabledDebugSteps, nestDebugSteps, referencedDebugFlows, loadReferencedDebugFlows, assertCompleteDebugDsl }
