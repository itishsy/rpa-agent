'use strict'
class ToolRegistry {
  constructor({ modePolicy = () => ({ effects: ['read'] }) } = {}) { this.tools = new Map(); this.modePolicy = modePolicy }
  add(name, description, schema, effect, run) {
    const { z } = require('zod')
    const invocationSchema = schema.extend({ _purpose: z.string().trim().min(1).max(300).optional()
      .describe('简要说明本次调用要解决什么问题或确认什么证据；描述目的，不要声称已完成。') })
    this.tools.set(name, { name, effect, run, schema: invocationSchema, description, validate: value => {
      const check = input => {
        if (!input || typeof input !== 'object') return
        for (const [key, item] of Object.entries(input)) {
          if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('不安全的对象字段')
          check(item)
        }
      }
      check(value)
      if (value && ['__proto__', 'prototype', 'constructor'].includes(value.key)) throw new Error('不安全的参数字段')
      for (const operation of value?.operations || []) if (['__proto__', 'prototype', 'constructor'].includes(operation.key)) throw new Error('不安全的参数字段')
      const { _purpose, ...args } = invocationSchema.parse(value)
      return args
    } })
    return this
  }
  get(name) { return this.tools.get(name) }
  schemas(mode) {
    const { z } = require('zod')
    const policy=this.modePolicy(mode)
    if (policy.model === false) return []
    return [...this.tools.values()].filter(tool => policy.effects.includes(tool.effect)).map(tool => ({
      type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.schema) }
    }))
  }
}

module.exports = { ToolRegistry }
