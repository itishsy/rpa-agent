'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { importRecordedSteps } = require('../src/services/step-edit')
test('recording import assigns fresh identifiers and redirects renamed jump targets', () => {
  const source = { steps: [{ stepCode: 'existing', stepName: '打开', actionCode: 'page' }] }
  const recording = { steps: [{ stepCode: 'one', stepName: '打开', actionCode: 'page', skipTo: '点击' }, { stepCode: 'two', stepName: '点击', actionCode: 'click', failedSkipTo: 'missing' }] }
  const result = importRecordedSteps(source, recording)
  assert.equal(result.dsl.steps.length, 3)
  assert.equal(result.dsl.steps[1].stepName, '打开 (2)')
  assert.equal(result.dsl.steps[1].skipTo, '点击')
  assert.notEqual(result.dsl.steps[1].stepCode, 'one')
  assert.equal(result.warnings.length, 1)
  assert.equal(source.steps.length, 1)
})
test('recordings cannot exceed the server two-level nesting limit', () => {
  const source = { steps: [{ stepCode: 'parent', stepName: '块', actionCode: 'codeBlock', body: [] }] }
  const recording = { steps: [{ stepCode: 'one', stepName: 'one', actionCode: 'codeBlock', body: [{ stepCode: 'two', stepName: 'two', actionCode: 'page' }] }] }
  assert.throws(() => importRecordedSteps(source, recording, { parentStepCode: 'parent' }), /只能插入到主层级/)
})
test('paste into the child level keeps ordinary branch steps and rewrites internal jumps', () => {
  const child = { stepCode: 'destination', stepName: '关闭', actionCode: 'click' }
  const source = { steps: [{ stepCode: 'parent', stepName: '父步骤', actionCode: 'page', children: [child] }] }
  const branch = { steps: [{ stepCode: 'copy', stepName: '打印', actionCode: 'click', skipTo: '关闭',
    children: [{ stepCode: 'copy-child', stepName: '关闭', actionCode: 'click', actionArgs: { text: '确认' } }] }] }
  const result = importRecordedSteps(source, branch, { parentStepCode: 'parent', index: 1, flattenOrdinaryChildren: true })
  const steps = result.dsl.steps[0].children
  assert.deepEqual(steps.map(step => step.stepName), ['关闭', '打印', '关闭 (2)'])
  assert.equal(steps[1].skipTo, '关闭 (2)')
  assert.equal(steps[1].children, undefined)
  assert.deepEqual(steps[2].actionArgs, { text: '确认' })
  assert.notEqual(steps[2].stepCode, 'copy-child')
})
