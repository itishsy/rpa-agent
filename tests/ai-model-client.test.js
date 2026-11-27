'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { completeChat } = require('../src/services/ai-model-client')
const { validateModelSettings } = require('../src/services/model-settings')
const settings = { modelBaseUrl: 'http://model.test/v1', modelName: 'fixture' }
const input = { messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'request' }], tools: [] }

test('generation tool choice is sent to the model and closing still disables tools',async()=>{
  const choice={type:'function',function:{name:'propose_dsl_patch'}}
  for(const finalOnly of [false,true])await completeChat(settings,'',{...input,toolChoice:choice,finalOnly},async(_,options)=>{
    const body=JSON.parse(options.body)
    assert.deepEqual(body.tool_choice,finalOnly?'none':choice)
    return {ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:'done'}}]})}
  })
})
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

test('thinking tool turns retain reasoning through history normalization and transport', async () => {
  const { normalizeHistory } = require('../src/agent/history')
  const calls=[{id:'read',type:'function',function:{name:'queue_status',arguments:'{}'}}]
  const response=await complete('tool_calls',{content:'',reasoning_content:'provider reasoning payload',tool_calls:calls})
  assert.equal(response.message.reasoning_content,'provider reasoning payload')
  const messages=normalizeHistory([...input.messages,
    {role:'assistant',content:'',tool_calls:[{...calls[0],id:'synthetic'}]},
    {role:'tool',tool_call_id:'synthetic',content:'{}'},response.message,{role:'tool',tool_call_id:'read',content:'{}'}])
  const before=JSON.stringify(messages)
  await completeChat(settings,'',{...input,messages},async(_,options)=>{
    const sent=JSON.parse(options.body).messages.filter(message=>message.role==='assistant')
    assert.equal(sent[0].reasoning_content,'')
    assert.equal(sent[1].reasoning_content,'provider reasoning payload')
    return {ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:'分析完成'}}]})}
  })
  assert.equal(JSON.stringify(messages),before)
})

test('missing reasoning_content on legacy tool history retries once without replaying tools', async () => {
  const messages=[...input.messages,{role:'assistant',content:'',tool_calls:[{id:'initial',type:'function',function:{name:'queue_status',arguments:'{}'}}]},
    {role:'tool',tool_call_id:'initial',content:'{"records":[]}'}]
  let attempts=0
  const result=await completeChat(settings,'',{...input,messages},async(_,options)=>{
    attempts++
    if(attempts===1)return {ok:false,status:400,text:async()=>'{"error":{"message":"The reasoning_content in the thinking mode must be passed back"}}'}
    assert.equal(JSON.parse(options.body).messages[2].reasoning_content,'')
    return {ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:'证据不足'}}]})}
  })
  assert.equal(attempts,2);assert.equal(result.message.content,'证据不足')
  assert.equal(Object.hasOwn(messages[2],'reasoning_content'),false)
})

test('thinking mode retries a rejected named tool choice with only that tool and preserves reasoning history', async () => {
  const calls = [{ id: 'read', type: 'function', function: { name: 'get_flow_context', arguments: '{}' } }]
  const messages = [...input.messages, { role: 'assistant', content: '', reasoning_content: 'retained reasoning', tool_calls: calls },
    { role: 'tool', tool_call_id: 'read', content: '{}' }]
  const tools = ['get_flow_context', 'propose_dsl_patch'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } }))
  const request = { ...input, messages, tools, toolChoice: { type: 'function', function: { name: 'propose_dsl_patch' } } }
  const before = JSON.stringify(request)
  let attempts = 0
  const result = await completeChat(settings, '', request, async (_, options) => {
    const body = JSON.parse(options.body)
    assert.equal(body.messages[2].reasoning_content, 'retained reasoning')
    if (++attempts === 1) return { ok: false, status: 400,
      text: async () => JSON.stringify({ error: { message: 'Thinking mode does not support this tool_choice' } }) }
    assert.equal(body.tool_choice, 'auto')
    assert.deepEqual(body.tools, [tools[1]])
    return { ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: 'tool_calls',
      message: { tool_calls: [{ id: 'patch', type: 'function', function: { name: 'propose_dsl_patch', arguments: '{}' } }] } }] }) }
  })
  assert.equal(attempts, 2)
  assert.equal(result.message.tool_calls[0].function.name, 'propose_dsl_patch')
  assert.equal(JSON.stringify(request), before)
})

test('thinking compatibility keeps final responses tool-free and can repair legacy reasoning on the next rejection', async () => {
  const messages = [...input.messages, { role: 'assistant', tool_calls: [
    { id: 'read', type: 'function', function: { name: 'get_flow_context', arguments: '{}' } }
  ] }, { role: 'tool', tool_call_id: 'read', content: '{}' }]
  let attempts = 0
  const result = await completeChat(settings, '', { ...input, messages, finalOnly: true }, async (_, options) => {
    const body = JSON.parse(options.body)
    assert.equal(body.tools, undefined)
    attempts++
    if (attempts === 1) return { ok: false, status: 400, text: async () => 'Thinking mode does not support this tool_choice' }
    assert.equal(Object.hasOwn(body, 'tool_choice'), false)
    if (attempts === 2) return { ok: false, status: 400, text: async () => 'reasoning_content in thinking mode must be passed back' }
    assert.equal(body.messages[2].reasoning_content, '')
    return { ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '分析完成' } }] }) }
  })
  assert.equal(attempts, 3)
  assert.equal(result.message.content, '分析完成')
})

test('unrelated bad requests and repeated tool-choice rejections stop without unbounded retries', async () => {
  for (const error of ['Invalid API key', 'Thinking mode does not support this tool_choice']) {
    let attempts = 0
    await assert.rejects(completeChat(settings, '', { ...input, tools: [
      { type: 'function', function: { name: 'read', parameters: { type: 'object' } } }
    ], toolChoice: 'required' }, async () => {
      attempts++
      return { ok: false, status: 400, text: async () => error }
    }), /模型 API 返回 400/)
    assert.equal(attempts, error.startsWith('Thinking') ? 2 : 1)
  }
})
