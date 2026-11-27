'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { validateReport } = require('../src/services/codex/report')

function report(evidenceIds) {
  return { summary: '已分析', cause: null, executionStatus: 'NOT_RUN', evidenceIds,
    candidateId: null, validationStatus: 'NOT_RUN', remainingIssues: [] }
}

test('Codex reports map execution codes to evidence ids and ignore unverifiable references', () => {
  const session = { runs: [{ artifactId: 'artifact-id', evidenceState: 'persisted', turnId: 'older-turn',
    result: { status: 'FAILED', executionCode: 'executor-run-id' } }], proposal: null, turn: { calls: [] } }
  const value = validateReport(report(['executor-run-id', 'missing-id', 'artifact-id']), session, { id: 'current-turn', mode: 'develop' })
  assert.deepEqual(value.evidenceIds, ['artifact-id'])
  assert.match(value.remainingIssues[0], /无法核对/)
})

test('Codex reports keep strict execution status validation', () => {
  const session = { runs: [{ artifactId: 'artifact-id', evidenceState: 'persisted', turnId: 'current-turn',
    result: { status: 'FAILED' } }], proposal: null, turn: { calls: [] } }
  assert.throws(() => validateReport(report([]), session, { id: 'current-turn', mode: 'develop' }), /实际执行状态不一致/)
})
