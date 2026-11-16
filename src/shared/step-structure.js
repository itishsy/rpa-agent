(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.stepStructure = api
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const jumps = ['skipTo', 'failedSkipTo', 'falseSkipTo']
  function scopes(steps) {
    const result = [], current = []
    for (const step of steps || []) {
      current.push(step, ...(step.children || []))
      if (step.body?.length) result.push(...scopes(step.body))
    }
    return [current, ...result]
  }
  function renameReferences(dsl, code, oldName, newName) {
    const scope = scopes(dsl.steps).find(list => list.some(step => step.stepCode === code))
    for (const step of scope || []) for (const key of jumps) if (step[key] === oldName) step[key] = newName
  }
  function cleanJumps(dsl, strict = false) {
    const warnings = []
    for (const scope of scopes(dsl.steps)) {
      const names = new Set(scope.map(step => step.stepName))
      for (const step of scope) for (const key of jumps) if (step[key] && step[key] !== 'NEXT' && !names.has(step[key])) {
        if (strict) throw new Error((dsl.flowName?'流程“'+dsl.flowName+'”（'+dsl.flowCode+'）中':'')+'步骤“' + step.stepName + '”的跳转目标不存在：' + step[key])
        warnings.push(step.stepName + '：已清理' + key + ' → ' + step[key]); delete step[key]
      }
    }
    return warnings
  }
  function jumpDiagnostics(dsl){
    const diagnostics=[]
    for(const scope of scopes(dsl.steps)){
      const names=new Set(scope.map(step=>step.stepName))
      for(const step of scope)for(const field of jumps)if(step[field]&&step[field]!=='NEXT'&&!names.has(step[field])){
        diagnostics.push({code:'JUMP_TARGET_MISSING',flowCode:dsl.flowCode,flowName:dsl.flowName,
          stepCode:step.stepCode,stepName:step.stepName,field,target:step[field],
          message:'当前流程执行列表中未找到目标步骤；这是步骤名称，不是被调用流程名称'})
      }
    }
    return diagnostics
  }
  return { scopes, renameReferences, cleanJumps,jumpDiagnostics }
})
