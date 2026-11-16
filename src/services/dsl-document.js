'use strict'
const {buildDebugDsl}=require('./debug-dsl')

// The IDE's debugDsl builder defines the document shape. Rebuild from local
// DSL values, rather than exposing editor/server metadata or inspection state.
function buildDslDocument(bundle){
  const rows=steps=>(steps||[]).map(step=>({...step,
    actionArgsVOS:undefined,targetArgsVOS:undefined,
    list:rows(step.actionCode==='codeBlock'?step.body:step.children)}))
  const flow=definition=>buildDebugDsl(bundle.appCode,definition.flowCode,definition,rows(definition.steps),undefined,{draft:true})
  const document=flow(bundle)
  document.subflows=(bundle.subflows||[]).map(definition=>{
    const child=flow(definition)
    return {flowCode:child.flowCode,flowName:child.flowName,steps:child.steps}
  })
  return document
}
module.exports={buildDslDocument}
