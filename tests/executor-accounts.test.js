const test=require('node:test'),assert=require('node:assert/strict')
const {normalizeExecutorAccounts}=require('../src/services/executor-accounts')
test('执行器账户保留任务编号并支持公积金账户和列表包装',()=>{
  assert.deepEqual(normalizeExecutorAccounts({rows:[{taskCode:12,accfundNumber:'公积金账户'},{taskCode:12,taskName:'重复'}]}),[{taskCode:'12',accfundNumber:'公积金账户',taskName:'公积金账户'}])
})
test('有效空列表与接口错误严格区分',()=>{
  assert.deepEqual(normalizeExecutorAccounts([]),[])
  assert.throws(()=>normalizeExecutorAccounts({error:'运行时发生异常'}),/未返回有效/)
  assert.throws(()=>normalizeExecutorAccounts([{taskName:'缺少编号'}]),/缺少任务编号/)
})
