'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { collectExperience, scrubExperience } = require('../src/services/experience')

test('fresh experience exporter paginates apps, expands references and masks input constants', async () => {
  let active = 0, maxActive = 0
  const catalog = await collectExperience({ request: async input => {
    active++; maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setImmediate(resolve)); active--
    if (input.path === 'robot/app/page') {
      const start = input.body.start
      return { rows: Array.from({ length: start ? 5 : 50 }, (_, index) => ({ appCode: 'a' + (index + start), appName: 'App' })), total: 55 }
    }
    if (input.path === 'robot/flow/list') return [{ flowCode: 'f-' + input.body.appCode, relationFlowCode: 'reference' }]
    if (input.path.startsWith('robot/client/app/getByFlowCode/')) return { flowCode: 'reference' }
    if (input.path.endsWith('/reference')) return [{ actionCode: 'input', actionArgs: '{"inputValue":"private-input"}' }]
    return []
  } })
  assert.equal(catalog.report.applications, 55)
  assert.equal(catalog.flows.length, 55)
  assert.equal(catalog.status, 'COMPLETE')
  assert.ok(maxActive <= 4)
  assert.ok(!JSON.stringify(catalog).includes('private-input'))
  assert.ok(catalog.flows.every(flow => flow.status === 'UNVERIFIED_REFERENCE'))
})
test('export refuses empty applications and repeated pages', async () => {
  await assert.rejects(collectExperience({ request: async () => ({ rows: [], total: 0 }) }), /没有可读取/)
  await assert.rejects(collectExperience({ request: async () => ({ rows: Array.from({ length: 50 }, (_, index) => ({ appCode: 'a' + index })) }) }), /重复返回/)
})
test('cancelled export does not produce a replacement catalog', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(collectExperience({ signal: controller.signal, request: async () => assert.fail('should not request') }), /旧目录保留/)
})
test('partial flow failures remain explicit rather than reporting full success', async () => {
  const catalog = await collectExperience({ request: async input => {
    if (input.path === 'robot/app/page') return { rows: [{ appCode: 'a' }], total: 1 }
    if (input.path === 'robot/flow/list') return [{ flowCode: 'good' }, { flowCode: 'bad' }]
    if (input.path.endsWith('/bad')) throw new Error('forbidden')
    return [{ stepCode: 's', actionCode: 'page' }]
  } })
  assert.equal(catalog.status, 'PARTIAL'); assert.equal(catalog.report.errors.length, 1)
  assert.equal(catalog.flows.length, 1)
})
test('import sanitization masks code and passwords as well as literal VO values', () => {
  const safe = scrubExperience({ password: 'abc', code: 'secret code', actionArgsVOS: [{ fieldKey: 'inputValue', fieldValue: 'customer' }] })
  assert.equal(safe.password, '[REDACTED]'); assert.equal(safe.code, '[REDACTED]')
  assert.equal(safe.actionArgsVOS[0].fieldValue, '[REDACTED]')
})
