'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { completeChat } = require('../src/services/ai-model-client')
const { validateModelSettings } = require('../src/services/model-settings')
const settings = { modelBaseUrl: 'http://model.test/v1', modelName: 'fixture' }
const input = { messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'request' }], tools: [] }
test('model settings validation leaves saved-secret decisions to the caller', () => {
  const input = { modelName: 'model', modelBaseUrl: 'https://example.test/v1', modelApiKey: '', clearModelApiKey: true }
  const original = structuredClone(input)
  assert.doesNotThrow(() => validateModelSettings(input))
  assert.deepEqual(input, original)
  assert.doesNotThrow(() => validateModelSettings({}))
})
test('model settings reject invalid endpoints and oversized names or API keys', () => {
  for (const modelBaseUrl of ['not a URL', 'file:///tmp/model', 'https://name:password@example.test']) {
    assert.throws(() => validateModelSettings({ modelBaseUrl }), /API 地址无效/)
  }
  assert.throws(() => validateModelSettings({ modelName: 'x'.repeat(201) }), /模型配置过长/)
  assert.throws(() => validateModelSettings({ modelApiKey: 'x'.repeat(4097) }), /API Key 过长/)
  for (const value of [null, [], 'settings']) assert.throws(() => validateModelSettings(value), /设置无效/)
})
function complete(finishReason, message = { content: 'answer' }) {
  return completeChat(settings, '', input, async () => ({ ok: true, text: async () => JSON.stringify({
    choices: [{ finish_reason: finishReason, message }], usage: { total_tokens: 12 }
  }) }))
}
test('model adapter preserves stop reason and usage, including omitted legacy stop reasons', async () => {
  const stopped = await complete('stop')
  assert.equal(stopped.message.content, 'answer')
  assert.equal(Object.hasOwn(stopped.message,'tool_calls'),false)
  assert.equal(stopped.completionStatus, 'complete')
  assert.equal(stopped.usage.total_tokens, 12)
  assert.equal((await complete(undefined)).completionStatus, 'legacy')
})
test('length, filtering, refusal and unknown stop reasons cannot be normal completion', async () => {
  for (const reason of ['length', 'content_filter', 'provider_error']) {
    assert.equal((await complete(reason)).completionStatus, 'incomplete')
  }
  assert.equal((await complete('stop', { content: '', refusal: 'refused' })).completionStatus, 'incomplete')
  assert.equal((await complete(null)).completionStatus, 'incomplete')
  assert.equal((await complete('stop', { content: '' })).completionStatus, 'incomplete')
  assert.equal((await complete('tool_calls', { content: '', tool_calls: [] })).completionStatus, 'incomplete')
})
test('a complete tool response retains arguments while keeping transport metadata separate', async () => {
  const calls = [{ id: 'read', type: 'function', function: { name: 'get_flow_context', arguments: '{}' } }]
  const response = await complete('tool_calls', { content: '', tool_calls: calls })
  assert.equal(response.completionStatus, 'complete')
  assert.deepEqual(response.message.tool_calls, calls)
  assert.equal(response.message.finishReason, undefined)
  assert.equal(response.message.usage, undefined)
})

test('conclusion requests explicitly disable tools in the model transport', async () => {
  let body
  await completeChat(settings, '', { ...input, finalOnly: true }, async (_, options) => {
    body = JSON.parse(options.body)
    return { ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '建议' } }] }) }
  })
  assert.equal(body.tool_choice, 'none')
  assert.equal(body.tools, undefined)
})

test('request transport omits legacy empty tool_calls without changing the transcript or valid calls', async () => {
  const calls=[{id:'read',type:'function',function:{name:'get_flow_context',arguments:'{}'}}]
  const messages=[...input.messages,{role:'assistant',content:'请选择账户',tool_calls:[]},{role:'user',content:'已选择，请继续'},
    {role:'assistant',content:'',tool_calls:calls},{role:'tool',tool_call_id:'read',content:'{}'},{role:'assistant',content:'已读取',tool_calls:null}]
  const before=JSON.stringify(messages)
  const result=await completeChat(settings,'',{...input,messages},async (_url,options)=>{
    const body=JSON.parse(options.body)
    assert.equal(Object.hasOwn(body.messages[2],'tool_calls'),false)
    assert.equal(Object.hasOwn(body.messages[6],'tool_calls'),false)
    assert.deepEqual(body.messages[4].tool_calls,calls)
    assert.deepEqual(body.messages[5],messages[5])
    return {ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:'继续完成',tool_calls:[]}}]})}
  })
  assert.equal(Object.hasOwn(result.message,'tool_calls'),false)
  assert.equal(JSON.stringify(messages),before)
})
