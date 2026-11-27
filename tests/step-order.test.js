'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {reorderSteps}=require('../src/shared/step-order')
const original={steps:[{stepCode:'parent',stepName:'父步骤',children:[{stepCode:'a',stepName:'甲'},{stepCode:'b',stepName:'乙',skipTo:'甲'}]},
  {stepCode:'block',stepName:'代码块',actionCode:'codeBlock',body:[{stepCode:'body',stepName:'块内'}]}, {stepCode:'last',stepName:'末尾'}]}
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
test('a child can move to the outer list and into a different parent',()=>{
  const moved=reorderSteps(original,'b','parent','after')
  assert.deepEqual(moved.steps.map(step=>step.stepCode),['parent','b','block','last'])
  assert.deepEqual(moved.steps[0].children.map(step=>step.stepCode),['a'])
  assert.equal(moved.steps[1].skipTo,'甲')
  const relocated=reorderSteps(moved,'a','last','inside')
  assert.equal(relocated.steps[0].children,undefined)
  assert.deepEqual(relocated.steps.at(-1).children,[original.steps[0].children[0]])
})
test('steps can enter or leave a code block if their jump bindings remain intact',()=>{
  assert.throws(()=>reorderSteps(original,'a','body'),/改变.*跳转/)
  assert.throws(()=>reorderSteps(original,'b','block','inside'),/改变.*跳转/)
  const moved=reorderSteps(original,'last','block','inside')
  assert.deepEqual(moved.steps[1].body.map(step=>step.stepCode),['body','last'])
  assert.deepEqual(reorderSteps(moved,'last','block','after'),original)
})
test('dragging rejects unsupported nesting and deleted targets',()=>{
  assert.throws(()=>reorderSteps(original,'parent','a'),/自身/)
  assert.throws(()=>reorderSteps(original,'parent','last','inside'),/两级/)
  assert.throws(()=>reorderSteps(original,'last','a','inside'),/两级/)
  assert.throws(()=>reorderSteps(original,'a','deleted'),/已变化/)
  assert.throws(()=>reorderSteps(original,'a','b','invalid'),/位置无效/)
  assert.deepEqual(reorderSteps(original,'a','a'),original)
})
