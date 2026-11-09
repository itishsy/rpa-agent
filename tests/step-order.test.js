'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {reorderSteps}=require('../src/shared/step-order')
const original={steps:[{stepCode:'parent',stepName:'父步骤',children:[{stepCode:'a',stepName:'甲'},{stepCode:'b',stepName:'乙',skipTo:'甲'}]},
  {stepCode:'block',stepName:'代码块',body:[{stepCode:'body',stepName:'块内'}]}, {stepCode:'last',stepName:'末尾'}]}
test('dragging a root step carries all descendants and does not mutate the source',()=>{
  const moved=reorderSteps(original,'parent','last','after')
  assert.deepEqual(moved.steps.map(step=>step.stepCode),['block','last','parent'])
  assert.deepEqual(moved.steps[2].children,original.steps[0].children)
  assert.equal(original.steps[0].stepCode,'parent')
})
test('sibling dragging keeps step identifiers, parameters and jump references',()=>{
  const moved=reorderSteps(original,'b','a')
  assert.deepEqual(moved.steps[0].children.map(step=>step.stepCode),['b','a'])
  assert.equal(moved.steps[0].children[0].skipTo,'甲')
})
test('dragging cannot reparent a step, enter a code block or refer to a deleted target',()=>{
  for(const [source,target]of [['last','a'],['a','body'],['parent','a']])assert.throws(()=>reorderSteps(original,source,target),/同一层级/)
  assert.throws(()=>reorderSteps(original,'a','deleted'),/已变化/)
  assert.throws(()=>reorderSteps(original,'a','b','invalid'),/位置无效/)
  assert.deepEqual(reorderSteps(original,'a','a'),original)
})
