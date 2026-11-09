const assert = require('node:assert/strict')
const { test } = require('node:test')
const { filterRows, filterLabels, normalizeFilter } = require('../src/services/undeclared-filter')

const rows = [
  { appName: '武汉-社保', customerName: '客户甲', taskStatus: '运行中', noDeclaredCount: 3 },
  { appName: '武汉-社保', customerName: '客户甲', taskStatus: '待缴费', isPayFeeTask: true, noDeclaredCount: 1 },
  { appName: '武汉-公积金', customerName: '客户乙', taskStatus: '已停用', noDeclaredCount: 2 }
]

test('result filters combine app, customer, status and payment inclusion locally', () => {
  assert.equal(filterRows(rows, {}).length, 3)
  assert.deepEqual(filterRows(rows, { appName: '武汉-社保', customerName: '户甲', includePayFee: false }), [rows[0]])
  assert.deepEqual(filterRows(rows, { taskStatus: '待缴费' }), [rows[1]])
  assert.deepEqual(filterRows(rows, { customerName: '客户乙', includePayFee: false }), [rows[2]])
  assert.deepEqual(filterRows(rows, { appName: '武汉-公积金', taskStatus: '运行中' }), [])
  assert.deepEqual(filterRows(rows, { appName: '社保', taskStatus: '行中' }), [rows[0]])
  assert.deepEqual(filterRows(rows, { appName: '武汉', taskStatus: '缴费' }), [rows[1]])
  assert.deepEqual(filterRows(rows, { appName: '社保', taskStatus: '缴费', includePayFee: false }), [])
})

test('active filter labels reflect exactly the applied conditions', () => {
  assert.deepEqual(filterLabels(normalizeFilter({ appName: '武汉-社保', customerName: '甲', taskStatus: '运行中', includePayFee: false })),
    ['应用包含武汉-社保', '客户名称包含甲', '任务状态包含运行中', '不包含缴费任务'])
  assert.deepEqual(filterLabels(normalizeFilter()), [])
})

test('multiple include and exclude rules combine with AND and retain payment toggle', () => {
  const candidates = [
    { appName: '武汉-社保', customerName: '龙湖集团', taskStatus: '运行中' },
    { appName: '武汉-社保', customerName: '其他客户', taskStatus: '运行中' },
    { appName: '武汉-社保', customerName: '其他客户', taskStatus: '待缴费', isPayFeeTask: true },
    { appName: '武汉-公积金', customerName: '其他客户', taskStatus: '运行中' }
  ]
  const filter = normalizeFilter({
    rules: [
      { field: 'appName', operator: 'contains', keyword: '社保' },
      { field: 'customerName', operator: 'notContains', keyword: '龙湖' }
    ],
    includePayFee: false
  })
  assert.deepEqual(filterRows(candidates, filter), [candidates[1]])
  assert.deepEqual(filterLabels(filter), ['应用包含社保', '客户名称不包含龙湖', '不包含缴费任务'])
})

test('blank rules are ignored and legacy saved filters migrate', () => {
  assert.deepEqual(normalizeFilter({ appName: '社保', includePayFee: false }), {
    rules: [{ field: 'appName', operator: 'contains', keyword: '社保' }], includePayFee: false
  })
  assert.deepEqual(normalizeFilter({ rules: [{ field: 'taskStatus', operator: 'notContains', keyword: '  ' }] }).rules, [])
  assert.deepEqual(normalizeFilter({ rules: [{ field: 'appName', operator: 'contains', keyword: '，, ' }] }).rules, [])
})

test('comma separated keywords match any included term and exclude every listed term', () => {
  const candidates = [
    { appName: '广州-社保', customerName: '龙湖集团' },
    { appName: '深圳-社保', customerName: '普通客户' },
    { appName: '武汉-公积金', customerName: '万科集团' },
    { appName: '上海-社保', customerName: '普通客户' }
  ]
  const filter = {
    rules: [
      { field: 'appName', operator: 'contains', keyword: '广州，深圳' },
      { field: 'customerName', operator: 'notContains', keyword: '龙湖, 万科' }
    ]
  }
  assert.deepEqual(filterRows(candidates, filter), [candidates[1]])
  assert.deepEqual(filterRows(candidates, {
    rules: [{ field: 'appName', operator: 'notContains', keyword: '广州,, 深圳，' }]
  }), [candidates[2], candidates[3]])
})
