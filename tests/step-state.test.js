const test=require('node:test'),assert=require('node:assert/strict')
const {classifySteps}=require('../src/shared/step-state')
const step=(code,args={})=>({stepCode:code,stepName:code,actionCode:'page',actionArgs:args})
test('step state ignores argument key order and identifies content changes and new steps',()=>{
  const baseline={steps:[step('a',{x:1,y:2}),step('b')]}
  const next=structuredClone(baseline);next.steps[0].actionArgs={y:2,x:1}
  assert.equal(classifySteps(next,baseline).get('a').modified,false)
  next.steps[0].actionArgs.x=3;next.steps.push(step('new'))
  const states=classifySteps(next,baseline)
  assert.equal(states.get('a').modified,true);assert.equal(states.get('b').modified,false);assert.equal(states.get('new').added,true)
})
test('inserting a sibling does not flag unchanged followers; real order or child changes are marked',()=>{
  const baseline={steps:[step('a'),step('b'),{...step('p'),children:[step('c')]}]}
  const next=structuredClone(baseline);next.steps.splice(1,0,step('new'))
  assert.equal(classifySteps(next,baseline).get('b').modified,false)
  next.steps[3].children[0].stepName='改名'
  const states=classifySteps(next,baseline)
  assert.equal(states.get('c').modified,true);assert.equal(states.get('p').modified,false)
  next.steps[3].children.push(step('new-child'))
  assert.equal(classifySteps(next,baseline).get('p').modified,true)
  const reordered={steps:[baseline.steps[1],baseline.steps[0],baseline.steps[2]]}
  assert.equal(classifySteps(reordered,baseline).get('a').modified,true)
})
test('saved voided steps retain void marking while modification clears after save or revert',()=>{
  const baseline={steps:[step('a'),step('b')]},next=structuredClone(baseline);next.steps[0].status=0
  assert.deepEqual(classifySteps(next,baseline).get('a'),{added:false,modified:true,voided:true})
  assert.deepEqual(classifySteps(next,next).get('a'),{added:false,modified:false,voided:true})
  next.steps[0].status=1
  assert.equal(classifySteps(next,baseline).get('a').modified,false)
  assert.equal(classifySteps({steps:[{...step('b'),status:null}]},baseline).get('b').voided,false)
})
