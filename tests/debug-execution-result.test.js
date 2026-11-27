'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { displaySteps, executionSteps, conclusion, statusLabel } = require('../src/shared/debug-execution-result')

test('ignored failures use the recorded DSL strategy and hide errors without changing evidence', () => {
  const result = { status: 'SUCCEEDED', trace: [
    { flowCode: 'main', stepCode: 'close', status: 'FAILED', message: 'selenium exception', error: 'error', errorStack: 'stack' },
    { flowCode: 'child', stepCode: 'close', status: 'FAILED', message: 'real error' },
    { flowCode: 'child', stepCode: 'nested', status: 'FAILED', message: 'nested exception' },
    { flowCode: 'main', stepCode: 'success', status: 'SUCCEEDED' }
  ] }
  const dsl = { flowCode: 'main', steps: [{ stepCode: 'close', failedStrategy: 1 }], subflows: [
    { flowCode: 'child', steps: [{ stepCode: 'close', failedStrategy: 0 }, { stepCode: 'block', body: [{ stepCode: 'nested', failedStrategy: '1' }] }] }
  ] }
  const rows = displaySteps(result, dsl)
  assert.deepEqual(rows.map(row => row.status), ['IGNORED', 'FAILED', 'IGNORED', 'SUCCEEDED'])
  assert.equal(statusLabel(rows[0].status), '忽略')
  for (const field of ['message', 'error', 'errorStack']) assert.equal(rows[0][field], '')
  assert.equal(rows[1].message, 'real error')
  assert.match(conclusion(result, rows).content, /成功 1 次，失败 1 次，忽略 2 次/)
  assert.equal(executionSteps(result)[0].message, 'selenium exception')
  assert.equal(result.trace[0].status, 'FAILED')
})

test('legacy details support explicit strategies and avoid guessing ambiguous or missing steps', () => {
  const result = { details: [
    { stepCode: 'explicit', status: 0, failedStrategy: '1', error: 'ignored error' },
    { stepCode: 'duplicate', status: '0', error: 'ambiguous error' },
    { stepCode: 'missing', status: 0, error: 'unknown error' },
    { stepCode: 'success', status: 1, failedStrategy: 1 }
  ] }
  const dsl = { flowCode: 'main', steps: [{ stepCode: 'duplicate', failedStrategy: 1 }], subflows: [
    { flowCode: 'child', steps: [{ stepCode: 'duplicate', failedStrategy: 0 }] }
  ] }
  assert.deepEqual(displaySteps(result, dsl).map(row => row.status), ['IGNORED', 'FAILED', 'FAILED', 'SUCCEEDED'])
  assert.deepEqual(displaySteps({ trace: [{ status: 'FAILED', error: 'retain' }] })[0], { status: 'FAILED', error: 'retain' })
})
