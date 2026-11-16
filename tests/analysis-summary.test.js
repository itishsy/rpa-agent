'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {summarize}=require('../src/shared/analysis-summary')

test('列表提取短结论，保留不确定性并隐藏报告章节',()=>{
  const report='## 未完成原因\n### 一、已确定的事实\n1. **现有证据不足，不能确定是否为流程配置问题。**\n依据：错误记录尚未取得\n建议：核对原任务\n原因分类：证据不足'
  assert.equal(summarize(report),'现有证据不足，不能确定是否为流程配置问题。')
  assert.equal(summarize('结论：队列已等待30分钟。同账户任务正在执行。其他细节。\n依据：队列Q'),'队列已等待30分钟。同账户任务正在执行。')
})

test('兼容停用结论及旧分析，完整报告不会被列表摘要修改',()=>{
  const report='未完成原因：该户已停用，自动任务暂停。\n停用原因：用户不扫码\n建议：处理后启用\n原因分类：任务调度'
  assert.equal(summarize(report),'该户已停用，自动任务暂停。')
  assert.ok(report.includes('用户不扫码'))
  assert.equal(summarize('未完成原因：验证码等待未完成。\n依据：执行编号e'),'验证码等待未完成。')
  assert.ok(summarize('证据不足，'+ '需要继续核实，'.repeat(50)).length<=140)
})
