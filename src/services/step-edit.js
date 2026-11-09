'use strict'
const { randomUUID } = require('node:crypto')
const { clone } = require('../agent/store')

function importRecordedSteps(current, recorded, { parentStepCode, index } = {}) {
  const dsl = clone(current), incoming = clone(recorded.steps), used = new Set(), warnings = []
  const { scopes, cleanJumps } = require('../shared/step-structure')
  const visit = (steps, fn) => steps.forEach(step => { fn(step); visit(step.body || step.children || [], fn) })
  visit(dsl.steps, step => used.add(step.stepName))
  for (const scope of scopes(incoming)) {
    const renamed = new Map()
    for (const step of scope) {
      const original = step.stepName
      let name = original, suffix = 2
      while (used.has(name)) name = original + ' (' + suffix++ + ')'
      used.add(name); renamed.set(original, name); step.stepName = name; step.stepCode = randomUUID()
    }
    for (const step of scope) for (const field of ['skipTo', 'failedSkipTo', 'falseSkipTo']) if (renamed.has(step[field])) step[field] = renamed.get(step[field])
  }
  let list = dsl.steps
  if (parentStepCode) {
    const parent = list.find(step => step.stepCode === parentStepCode)
    if (!parent) throw new Error('父步骤不存在')
    if (incoming.some(step => (step.body || step.children || []).length)) throw new Error('两级录制步骤只能插入到主层级')
    const field = parent.actionCode === 'codeBlock' ? 'body' : 'children'
    list = parent[field] || (parent[field] = [])
  }
  const position = index === undefined ? list.length : Number(index)
  if (!Number.isInteger(position) || position < 0 || position > list.length) throw new Error('插入位置无效')
  list.splice(position, 0, ...incoming)
  warnings.push(...cleanJumps(dsl))
  return { dsl, warnings }
}
module.exports = { importRecordedSteps }
