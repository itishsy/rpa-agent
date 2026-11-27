(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./step-structure'))
  else root.stepOrder = factory(root.stepStructure)
})(globalThis, function ({ scopes }) {
  function jumpTargets(dsl) {
    const targets = new Map()
    for (const scope of scopes(dsl.steps)) {
      const byName = new Map(scope.map(step => [step.stepName, step.stepCode]))
      for (const step of scope) for (const field of ['skipTo', 'failedSkipTo', 'falseSkipTo']) {
        const name = step[field]
        if (name && name !== 'NEXT' && byName.has(name)) {
          targets.set(step.stepCode + ':' + field, { code: byName.get(name), name, from: step.stepName })
        }
      }
    }
    return targets
  }

  function reorderSteps(dsl, sourceCode, targetCode, position = 'before') {
    if (!['before', 'after', 'inside'].includes(position)) throw new Error('拖动位置无效')
    const next = JSON.parse(JSON.stringify(dsl))
    const locations = new Map()
    function visit(list, parent = null, field = null) {
      for (const step of list || []) {
        locations.set(step.stepCode, { list, step, parent, field })
        visit(step.body, step, 'body')
        visit(step.children, step, 'children')
      }
    }
    visit(next.steps)
    const source = locations.get(sourceCode), target = locations.get(targetCode)
    if (!source || !target) throw new Error('步骤已变化，请重新拖动')
    if (source === target && position !== 'inside') return next
    if (source === target || target.parent === source.step) throw new Error('不能将步骤移到自身下方的子步骤中')
    const inside = position === 'inside'
    const parent = inside ? target.step : target.parent
    if (inside && target.parent || parent && (source.step.children?.length || source.step.body?.length || source.step.actionCode === 'codeBlock')) {
      throw new Error('流程仅支持两级步骤，带子步骤的步骤和代码块须留在外层')
    }

    const field = inside ? (parent.actionCode === 'codeBlock' ? 'body' : 'children') : target.field
    const destination = inside ? (parent[field] ||= []) : target.list
    source.list.splice(source.list.indexOf(source.step), 1)
    const index = inside ? destination.length : destination.indexOf(target.step) + (position === 'after' ? 1 : 0)
    destination.splice(index, 0, source.step)
    if (source.parent && !source.list.length) delete source.parent[source.field]
    const fromBlock = source.field === 'body' ? source.parent : null
    const toBlock = field === 'body' ? parent : null
    if (fromBlock !== toBlock) {
      const movedTargets = jumpTargets(next)
      for (const [key, jump] of jumpTargets(dsl)) {
        if (movedTargets.get(key)?.code !== jump.code) {
          throw new Error('移动会改变“' + jump.from + '”跳转到“' + jump.name + '”的范围，请先调整跳转配置')
        }
      }
    }
    return next
  }
  return { reorderSteps }
})
