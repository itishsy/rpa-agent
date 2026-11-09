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
