const { test } = require('node:test')
const assert = require('node:assert/strict')
const { enrichRemarks, loginTypeRemarks, normalizeRows } = require('../src/services/undeclared-monitor')

test('remarks show LoginType suffix fields only', () => {
  assert.equal(loginTypeRemarks({ data: [
    { args: [{ argsKey: 'socialLoginType', fieldName: '社保登录方式', argsValue: '短信登录' },
      { argsKey: 'password', fieldName: '密码', argsValue: 'secret' },
      { argsKey: 'taxLoginType', fieldName: '税务系统登录方式', argsValue: '扫码登录' },
      { argsKey: 'taxLoginType', fieldName: '税务登录方式', argsValue: '个人所得税扫码登录' },
      { argsKey: 'LoginTypeOther', fieldName: '其他', argsValue: '排除' }] },
    { args: [{ argsKey: 'fundLoginType', fieldName: '公积金登录方式', argsValue: '证书登录' }] }
  ] }), '社保登录方式：短信登录，公积金登录方式：证书登录')
})

test('remark requests encode identifiers and reuse task config within one refresh', async () => {
  const rows = normalizeRows([
    { appName: '武汉-社保', appCode: 'app/1', taskCode: 'task?1', accNumber: '0001/2', noDeclaredCount: 5 },
    { appName: '武汉-社保', appCode: 'app/1', taskCode: 'task?1', accNumber: 'other', auditCount: 1 }
  ], { baseServer: 'https://example.com' }, 0, ['武汉-社保'])
  const calls = []
  await enrichRemarks(rows, {}, async (_server, endpoint) => {
    calls.push(endpoint)
    return endpoint.includes('showServiceItemFlow') ? { data: [{ serviceItemName: '增员', noDeclaredCount: 2 }, { serviceItemName: '减员', noDeclaredCount: 3 }] } :
      { data: [{ args: [{ argsKey: 'socialLoginType', fieldName: '社保登录方式', argsValue: '短信登录' }] }] }
  })
  assert.equal(rows[0].remark, '社保登录方式：短信登录')
  assert.deepEqual(rows[0].taskDetails, [{ name: '增员', count: 2 }, { name: '减员', count: 3 }])
  assert.equal(rows[0].accountNumber, '0001/2')
  assert.ok(calls.includes('robot/app/client/showServiceItemFlow/app%2F1/task%3F1/0001%2F2'))
  assert.equal(calls.filter(p => p.includes('getRobotTaskConfigInfo')).length, 1)
})

test('partial detail failures preserve rows and successful remark sections', async () => {
  const rows = [{ appCode: 'a', taskCode: 't', accNumber: '1' }, {}]
  await enrichRemarks(rows, {}, async (_server, endpoint) => {
    if (endpoint.includes('showServiceItemFlow')) throw new Error('offline')
    return [{ args: [{ argsKey: 'xLoginType', fieldName: '社保登录方式', argsValue: '短信登录' }] }]
  })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].remark, '增减员数加载失败，社保登录方式：短信登录')
  assert.match(rows[1].remark, /缺少/)
})
