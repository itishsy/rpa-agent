'use strict'
const {clone,digest}=require('../agent-core/store')
// Stage -> review -> apply to a draft. Saving and execution are separate actions.
function createPatchWorkflow({targetFor,validate,assertAvailable}){
  async function prepare(source,expected){
    assertAvailable(source)
    const proposal=source.proposal
    if(!proposal)throw new Error('没有待应用的补丁')
    const reviewId=digest(proposal)
    if(expected&&expected!==reviewId)throw new Error('补丁已变化，请重新预览确认')
    const assertSource=()=>{
      assertAvailable(source)
      if(source.proposal!==proposal||digest(proposal)!==reviewId||proposal.baseRevision!==source.revision||proposal.baseline!==digest(source.dsl))throw new Error('补丁已过期，请重新生成')
    }
    assertSource()
    const target=proposal.targetFlowCode?await targetFor(source,proposal):source
    const revision=target.revision,baseline=digest(target.dsl)
    const assertCurrent=()=>{
      assertSource();assertAvailable(target)
      if(target!==source&&target.proposal)throw new Error('子流程已有其他待审核补丁，请先在对应 Tab 应用或放弃')
      if(target.revision!==revision||digest(target.dsl)!==baseline)throw new Error('目标流程已变化，请重新生成补丁')
      if(proposal.targetFlowCode&&(target.id!==proposal.targetSessionId||revision!==proposal.targetBaseRevision||baseline!==proposal.targetBaseline))throw new Error('子流程候选已过期，请重新读取')
    }
    assertCurrent()
    await validate(target,clone(proposal.dsl))
    assertCurrent()
    return {proposal,target,reviewId,assertCurrent}
  }
  return {
    async review(source){
      const {proposal,target,reviewId}=await prepare(source)
      return {...clone(proposal),reviewId,baseDsl:clone(target.dsl),targetFlowName:target.dsl.flowName||target.scope.flowCode,
        targetSessionId:target.id,advisoryOnly:!!(source.readOnly||target.readOnly||proposal.advisoryOnly)}
    },
    async apply(source,reviewId){
      if(source.readOnly||source.proposal?.advisoryOnly)throw new Error('只读流程建议补丁仅供审阅，不能直接应用')
      if(!reviewId)throw new Error('请先预览并确认补丁')
      const {proposal,target,assertCurrent}=await prepare(source,reviewId)
      if(target.readOnly)throw new Error('只读子流程不能直接应用补丁')
      assertCurrent()
      target.dsl=clone(proposal.dsl);target.revision++
      // A previously staged target proposal no longer matches the new draft.
      target.proposal=null;source.proposal=null
      return {target,changedStepCodes:clone(proposal.changedStepCodes||[])}
    }
  }
}
module.exports={createPatchWorkflow}
