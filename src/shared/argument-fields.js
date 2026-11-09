/* Shared by the isolated renderer and main-process validation. */
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.argumentFields = api
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function visible(definitions, values) {
    const controllers = definitions.filter(field => field.cond)
    if (!controllers.length) return definitions.map(field => ({ ...field, hidden: false }))
    // A selector that exposes another controller in only some branches is its parent.
    // Back references present in every branch (e.g. inputType -> validateType)
    // do not make the primary selector dependent on the child.
    const mappings = new Map(controllers.map(field => {
      let mapping
      try { mapping = typeof field.cond === 'string' ? JSON.parse(field.cond) : field.cond } catch (_) { throw new Error('指令条件参数定义无效：' + field.fieldKey) }
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('指令条件参数定义无效：' + field.fieldKey)
      return [field.fieldKey, Object.fromEntries(Object.entries(mapping).map(([value, keys]) => {
        const list = typeof keys === 'string' ? keys.split(',') : keys
        if (!Array.isArray(list)) throw new Error('指令条件参数定义无效：' + field.fieldKey)
        return [value, list.map(key => String(key).trim())]
      }))]
    }))
    const dependent = new Set()
    for (const field of controllers) {
      const branches = Object.values(mappings.get(field.fieldKey))
      for (const child of controllers) if (child !== field && branches.some(keys => keys.includes(child.fieldKey)) &&
        branches.some(keys => !keys.includes(child.fieldKey))) dependent.add(child.fieldKey)
    }
    const roots = controllers.filter(field => !dependent.has(field.fieldKey))
    if(!roots.length)roots.push(controllers[0])
    // Only controllers reachable through the selected branch can expose more fields;
    // a stale value on a hidden controller must never revive an inactive branch.
    const byKey = new Map(controllers.map(field => [field.fieldKey, field]))
    const allowed = new Set(roots.map(field=>field.fieldKey))
    const pending = [...roots], visited = new Set()
    for (let index = 0; index < pending.length; index++) {
      const field = pending[index]
      if (visited.has(field.fieldKey)) continue
      visited.add(field.fieldKey)
      const mapping = mappings.get(field.fieldKey)
      const selected = mapping && Object.hasOwn(mapping, values[field.fieldKey]) ? mapping[values[field.fieldKey]] : []
      for (const key of selected) {
        const name = String(key).trim()
        allowed.add(name)
        if (byKey.has(name) && !visited.has(name)) pending.push(byKey.get(name))
      }
    }
    return definitions.map(field => ({ ...field, hidden: !allowed.has(field.fieldKey) }))
  }
  function validate(definitions, values, label) {
    const fields = visible(definitions, values)
    for (const field of fields) {
      if (field.hidden) continue
      const value = values[field.fieldKey]
      const empty = value === undefined || value === null || String(value).trim() === ''
      if (Number(field.required) === 1 && empty) throw new Error(label + '：请填写' + (field.fieldName || field.fieldKey))
      if (!empty && field.fieldType === 'number' && !/^\d+$/.test(String(value))) throw new Error(label + '：' + (field.fieldName || field.fieldKey) + '须为非负整数')
    }
    return fields
  }
  return { visible, validate }
})
