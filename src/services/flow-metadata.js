'use strict'
// Retired flow-template/chart metadata must never influence current flow reads.
const RETIRED=new Set(['templateFlowCode','relationFlowCode','loginFlowFlag','templateType',
  'flowGraph','flowGraphJson','graphJson','flowChart','flowChartJson','graphNodes','graphEdges','nodes','edges'])
function flowMetadata(value,options={}){
  if(!value||typeof value!=='object'||Array.isArray(value))return value
  return Object.fromEntries(Object.entries(value).filter(([key])=>!RETIRED.has(key)||(options.appArgs&&['nodes','edges'].includes(key))))
}
function stepMetadata(row){
  const result=flowMetadata(row)
  for(const key of ['list','children','body'])if(Array.isArray(result?.[key]))result[key]=result[key].map(stepMetadata)
  return result
}
function dslMetadata(dsl){
  if(!dsl||typeof dsl!=='object')return dsl
  const result=flowMetadata(dsl)
  if(result.appArgs&&typeof result.appArgs==='object')result.appArgs=flowMetadata(result.appArgs,{appArgs:true})
  if(Array.isArray(result.steps))result.steps=result.steps.map(stepMetadata)
  if(Array.isArray(result.subflows))result.subflows=result.subflows.map(dslMetadata)
  return result
}
module.exports={flowMetadata,stepMetadata,dslMetadata}
