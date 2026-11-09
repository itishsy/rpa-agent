(function(root,factory){
  const api=factory()
  if(typeof module==='object'&&module.exports)module.exports=api
  else root.stepState=api
})(typeof globalThis==='object'?globalThis:this,function(){
  function canonical(value){
    if(Array.isArray(value))return value.map(canonical)
    if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]))
    return value
  }
  function index(dsl){
    const nodes=new Map(),groups=[]
    function visit(steps,parent='',slot='steps'){
      groups.push({steps,parent,slot})
      for(const step of steps){
        nodes.set(step.stepCode,{step,parent,slot})
        for(const field of ['children','body'])if(step[field])visit(step[field],step.stepCode,field)
      }
    }
    visit(dsl?.steps||[]);return {nodes,groups}
  }
  function predecessors(tree,other){
    const result=new Map()
    for(const {steps,parent,slot} of tree.groups){
      let previous=null
      for(const step of steps){
        const match=other.nodes.get(step.stepCode)
        if(match?.parent!==parent||match?.slot!==slot)continue
        result.set(step.stepCode,previous);previous=step.stepCode
      }
    }
    return result
  }
  function signature(step){
    const own={...step};delete own.stepCode;delete own.children;delete own.body
    if(own.status==null||own.status===1||own.status==='1')delete own.status
    else if(own.status==='0')own.status=0
    for(const field of ['children','body'])if(step[field]?.length)own[field]=step[field].map(child=>child.stepCode)
    return JSON.stringify(canonical(own))
  }
  function classifySteps(dsl,baseline){
    const current=index(dsl),saved=index(baseline),currentOrder=predecessors(current,saved),savedOrder=predecessors(saved,current),result=new Map()
    for(const [code,node] of current.nodes){
      const old=saved.nodes.get(code),added=!old
      const modified=added||node.parent!==old.parent||node.slot!==old.slot||currentOrder.get(code)!==savedOrder.get(code)||signature(node.step)!==signature(old.step)
      result.set(code,{added,modified,voided:node.step.status===0||node.step.status==='0'})
    }
    return result
  }
  return {classifySteps}
})
