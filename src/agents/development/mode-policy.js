'use strict'
// Operation policy is enforced by the Harness, independent of the selector UI.
const POLICIES=Object.freeze({
  generate:Object.freeze({label:'仅生成步骤',model:true,effects:Object.freeze(['read','edit']),writeToEditor:true}),
  run:Object.freeze({label:'仅运行',model:false,effects:Object.freeze([]),writeToEditor:false}),
  dslRun:Object.freeze({label:'仅运行',model:false,directTool:'run_current_dsl',effects:Object.freeze(['execute']),writeToEditor:false}),
  develop:Object.freeze({label:'运行与诊断',model:true,effects:Object.freeze(['read','edit','execute']),writeToEditor:false})
})
function modePolicy(mode){
  if(!Object.hasOwn(POLICIES,mode))throw new Error('未知操作模式')
  return POLICIES[mode]
}
module.exports={modePolicy}
