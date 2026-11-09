(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.stepOrder=factory()})(globalThis,function(){
  function reorderSteps(dsl,sourceCode,targetCode,position='before'){
    if(!['before','after'].includes(position))throw new Error('拖动位置无效')
    const next=JSON.parse(JSON.stringify(dsl));let source,target
    const visit=list=>(list||[]).forEach(step=>{
      if(step.stepCode===sourceCode)source={list,step}
      if(step.stepCode===targetCode)target={list,step}
      visit(step.body);visit(step.children)
    })
    visit(next.steps)
    if(!source||!target)throw new Error('步骤已变化，请重新拖动')
    if(source.list!==target.list)throw new Error('只能拖动调整同一层级、同一父步骤下的顺序')
    if(source.step===target.step)return next
    source.list.splice(source.list.indexOf(source.step),1)
    source.list.splice(source.list.indexOf(target.step)+(position==='after'?1:0),0,source.step)
    return next
  }
  return {reorderSteps}
})
