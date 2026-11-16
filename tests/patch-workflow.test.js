'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {createPatchWorkflow}=require('../src/services/patch-workflow')
const {digest}=require('../src/agent-core/store')
function fixture(){
  const source={id:'root',scope:{appCode:'app',flowCode:'root'},revision:0,dsl:{appCode:'app',flowCode:'root',steps:[{stepCode:'one',stepName:'原步骤',actionCode:'page'}]}}
  source.savedBaseline=structuredClone(source.dsl)
  source.proposal={baseRevision:0,baseline:digest(source.dsl),dsl:{...structuredClone(source.dsl),steps:[{stepCode:'one',stepName:'新步骤',actionCode:'page'}]},operations:[{op:'set',stepCode:'one',field:'stepName',value:'新步骤'}],changedStepCodes:['one']}
  let target=source,validate=async()=>{}
  const workflow=createPatchWorkflow({targetFor:async()=>target,validate:(...args)=>validate(...args),assertAvailable(session){if(session.busy)throw Error('运行中')}})
  return {source,workflow,setTarget(value){target=value},setValidate(fn){validate=fn}}
}
test('review does not mutate; explicit reviewed patch applies to a local draft only',async()=>{
  const {source,workflow}=fixture(),before=structuredClone(source)
  const review=await workflow.review(source)
  assert.deepEqual(source,before)
  await assert.rejects(workflow.apply(source),/先预览/)
  const {target}=await workflow.apply(source,review.reviewId)
  assert.equal(target.dsl.steps[0].stepName,'新步骤');assert.equal(target.revision,1)
  assert.deepEqual(target.savedBaseline,before.savedBaseline);assert.equal(source.proposal,null)
  await assert.rejects(workflow.apply(source,review.reviewId),/没有待应用/)
})
test('an older review cannot apply a replacement proposal or an edited draft',async()=>{
  const {source,workflow}=fixture(),review=await workflow.review(source)
  source.proposal.dsl.steps[0].stepName='另一个补丁'
  await assert.rejects(workflow.apply(source,review.reviewId),/补丁已变化/)
  assert.equal(source.dsl.steps[0].stepName,'原步骤')
  source.revision++
  await assert.rejects(workflow.review(source),/过期/)
})
test('rechecks versions and availability after asynchronous command validation',async()=>{
  const f=fixture(),review=await f.workflow.review(f.source)
  f.setValidate(async()=>{f.source.revision++})
  await assert.rejects(f.workflow.apply(f.source,review.reviewId),/过期/)
  assert.equal(f.source.dsl.steps[0].stepName,'原步骤')
  const other=fixture(),r=await other.workflow.review(other.source)
  other.setValidate(async()=>{other.source.busy=true})
  await assert.rejects(other.workflow.apply(other.source,r.reviewId),/运行中/)
})
test('child patch updates only the child and consumes the source proposal',async()=>{
  const f=fixture(),child={id:'child',scope:{appCode:'app',flowCode:'child'},revision:2,dsl:{appCode:'app',flowCode:'child',steps:[]},proposal:null}
  const root=structuredClone(f.source.dsl)
  Object.assign(f.source.proposal,{targetFlowCode:'child',targetSessionId:child.id,targetBaseRevision:2,targetBaseline:digest(child.dsl),dsl:{...child.dsl,steps:[{stepCode:'new',stepName:'新增',actionCode:'page'}]}})
  f.setTarget(child)
  const review=await f.workflow.review(f.source)
  child.proposal={old:true}
  await assert.rejects(f.workflow.apply(f.source,review.reviewId),/其他待审核补丁/)
  child.proposal=null
  const {target}=await f.workflow.apply(f.source,review.reviewId)
  assert.equal(target,child);assert.equal(child.revision,3);assert.equal(child.dsl.steps.length,1)
  assert.deepEqual(f.source.dsl,root);assert.equal(f.source.proposal,null);assert.equal(child.proposal,null)
})
test('read-only suggestions remain inspectable but never apply',async()=>{
  const {source,workflow}=fixture();source.readOnly=true;source.proposal.advisoryOnly=true
  const review=await workflow.review(source);assert.equal(review.advisoryOnly,true)
  await assert.rejects(workflow.apply(source,review.reviewId),/不能直接应用/)
  assert.equal(source.revision,0);assert.equal(source.dsl.steps[0].stepName,'原步骤')
})
