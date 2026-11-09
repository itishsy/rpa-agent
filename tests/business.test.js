'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createBusinessService } = require('../src/services/business')
const { prepareMonitorSettings, publicMonitorSettings, migrateLegacyPayments } = require('../src/services/monitor-settings')
const { applicationCsv } = require('../src/services/table-export')
function fixture(extra = {}) {
  const calls = [], flows = [{ id: 10, appCode: 'app', flowCode: 'f1', flowName: '减员', execOrder: 1, serviceItem: 2, flowType: 1, status: 0 },
    { id: 11, appCode: 'app', flowCode: 'f2', flowName: '登录', execOrder: 2, serviceItem: 11, flowType: 1, status: 3 }]
  const service = createBusinessService(async input => {
    calls.push(structuredClone(input))
    if (extra.request) return extra.request(input, flows)
    if (input.path === 'robot/flow/list') return structuredClone(flows)
    if (input.path === 'robot/flow/showOneAppFlow') return [{ flowCode: 'source', flowName: '来源' }]
    return true
  })
  return { service, calls, flows }
}
test('monitor settings normalize legacy strings, deduplicate keywords and never expose secrets', () => {
  const first = prepareMonitorSettings({}, { keywords:'武汉-社保， 武汉-社保,深圳-公积金',servers:[{baseServer:'https://example.test/api/',username:'account',password:'secret'}] })
  assert.deepEqual(first.keywords,['武汉-社保','深圳-公积金'])
  const second=prepareMonitorSettings(first,{keywords:first.keywords,servers:[{baseServer:'https://example.test/api',username:'account',password:''}]})
  assert.equal(second.servers[0].password,'secret')
  assert.ok(!JSON.stringify(publicMonitorSettings(second)).includes('secret'))
  assert.deepEqual(publicMonitorSettings({keywords:'legacy'}).keywords,['legacy'])
  assert.equal(prepareMonitorSettings(first,{keywords:'a',servers:[{baseServer:'https://example.test/api',username:'other',password:''}]}).servers[0].password,'')
  assert.throws(()=>prepareMonitorSettings(first,{keywords:'a',servers:[{baseServer:'file:///tmp',username:'a'}]}),/HTTP/)
  assert.throws(()=>prepareMonitorSettings(first,{keywords:'a',servers:[first.servers[0],first.servers[0]]}),/重复/)
})
test('application pagination uses the actual query contract, numeric records total and last-page detection', async () => {
  const f=fixture({request:async()=>({rows:[{appCode:'app'}],records:21})})
  const result=await f.service.invoke('applications',{page:2,size:20,keyword:'负责人',statuses:[6]})
  assert.deepEqual(f.calls[0],{path:'robot/app/getAppData',body:{page:2,size:20,start:20,query:[{property:'keyWord',value:'负责人'},{property:'appStatusList',value:[6]}]}})
  assert.equal(result.total,21);assert.equal(result.hasNext,false)
  await assert.rejects(f.service.invoke('applications',{page:0}),/页码/)
  const invalid=fixture({request:async()=>({error:'not a table'})})
  await assert.rejects(invalid.service.invoke('applications',{}),/格式无效/)
})
test('application save preserves metadata, checks unimplemented service remarks and refuses array arguments', async () => {
  const f=fixture(), input={appCode:'app',id:3,appName:'武汉-社保',robotName:'social',appArgs:{addrId:1,businessType:1001001,custom:'preserved'},robotServiceItemList:[{serviceItem:1,serviceStatus:0,serviceRemark:''}]}
  await assert.rejects(f.service.invoke('saveApplication',input),/情况说明/);assert.equal(f.calls.length,0)
  input.robotServiceItemList[0].serviceRemark='不支持'
  await f.service.invoke('saveApplication',input)
  assert.equal(f.calls[0].path,'robot/app/updateApp');assert.equal(f.calls[0].body.id,3)
  assert.deepEqual(JSON.parse(f.calls[0].body.appArgs),input.appArgs)
  await assert.rejects(f.service.invoke('saveApplication',{...input,appArgs:[]}),/对象/)
})
test('application release, offline and state contracts separate JSON body from query parameters', async () => {
  const f=fixture()
  await f.service.invoke('releaseApplication',{appCode:'app',rule:'补丁',changeReason:'修复',comment:'说明'})
  assert.deepEqual(f.calls[0],{path:'robot/app/release',body:{appCode:'app',rule:'补丁',changeReason:'修复',comment:'说明'}})
  await f.service.invoke('offlineApplication',{appCode:'app',appStatus:0,comment:'下线原因'})
  assert.deepEqual(f.calls[1],{path:'robot/app/offlineStatus',params:{appCode:'app',appStatus:0,comment:'下线原因'}})
  await f.service.invoke('statusApplication',{appCode:'app',appStatus:6,remark:'网站升级'})
  assert.equal(f.calls[2].params.remark,'网站升级')
  await assert.rejects(f.service.invoke('releaseApplication',{appCode:'app',rule:'补丁',changeReason:'x',comment:'x'.repeat(501)}),/500/)
})
test('flow list retains all requested filter arrays and duplicate names cannot create another flow', async () => {
  const f=fixture()
  await f.service.invoke('flows',{appCode:'app',flowTypeList:[2],serviceItemList:[1],declareSystemList:['sys']})
  assert.deepEqual(f.calls[0].body,{appCode:'app',flowTypeList:[2],serviceItemList:[1],declareSystemList:['sys']})
  await assert.rejects(f.service.invoke('saveFlow',{appCode:'app',flowName:'减员',flowType:1,declareSystem:'sys',runSupport:'web'}),/不能重复/)
  assert.ok(!f.calls.some(call=>call.path==='robot/flow/add'))
})
test('flow editing sends JSON with the fresh row id; creating/copying/linking uses POST query', async () => {
  const f=fixture(), common={appCode:'app',flowName:'新流程',flowType:1,serviceItem:1,declareSystem:'sys',runSupport:'web',tagCode:'tag'}
  await f.service.invoke('saveFlow',{...common,mode:'edit',flowCode:'f1',id:'forged'})
  assert.equal(f.calls.at(-1).path,'robot/flow/editFlow');assert.equal(f.calls.at(-1).body.id,10);assert.equal(f.calls.at(-1).params,undefined)
  await f.service.invoke('saveFlow',{...common,mode:'add'})
  assert.equal(f.calls.at(-1).params.flowType,1);assert.equal(f.calls.at(-1).body,undefined)
  await f.service.invoke('saveFlow',{...common,mode:'copyAdd',sourceFlowCode:'source'})
  assert.equal(f.calls.at(-1).params.flowCode,'source');assert.equal(f.calls.at(-1).params.flowType,'')
  await assert.rejects(f.service.invoke('saveFlow',{...common,mode:'relateAdd',sourceFlowCode:'source'}),/允许范围/)
  await f.service.invoke('saveFlow',{...common,mode:'relateAdd',sourceFlowCode:'f2'})
  assert.equal(f.calls.at(-1).path,'robot/flow/relateAdd')
})
test('flow sorting validates the complete application range and flow status/history use their actual JSON contract', async () => {
  const f=fixture()
  await assert.rejects(f.service.invoke('orderFlow',{appCode:'app',flowCode:'f1',execOrder:3}),/范围/)
  await f.service.invoke('orderFlow',{appCode:'app',flowCode:'f1',execOrder:2})
  assert.deepEqual(f.calls.at(-1),{path:'robot/flow/editFlowOrder',body:{id:10,appCode:'app',execOrder:2}})
  await assert.rejects(f.service.invoke('statusFlow',{appCode:'app',flowCode:'f1',status:4}),/原因备注/)
  await f.service.invoke('statusFlow',{appCode:'app',flowCode:'f1',status:0,comment:'reset'})
  assert.deepEqual(f.calls.at(-1).body,{appCode:'app',flowCode:'f1',id:10,status:0,comment:'reset'})
  await f.service.invoke('flowHistory',{appCode:'app',flowCode:'f1'})
  assert.deepEqual(f.calls.at(-1),{path:'robot/flow/statusHistory',body:{appCode:'app',flowCode:'f1',historyType:2}})
  await assert.rejects(f.service.invoke('deleteFlow',{appCode:'app',flowCode:'foreign'}),/不属于/)
})
test('flow organization reports partial writes and never announces success without re-reading the server', async () => {
  let writes=0
  const f=fixture({request:async(input,flows)=>{
    if(input.path==='robot/flow/list')return structuredClone(flows)
    if(input.path==='robot/flow/editFlowOrder'){writes++;throw new Error('permission denied')}
  }})
  await assert.rejects(f.service.invoke('organizeFlows',{appCode:'app'}),/已完成0\/1/)
  assert.equal(writes,1)
})
test('CSV export escapes commas, quotes, line breaks and spreadsheet formulas', () => {
  const csv=applicationCsv([{appName:'=HYPERLINK("x")',appRemark:'a,b\nc'}])
  assert.ok(csv.startsWith('\ufeff'));assert.match(csv,/'=HYPERLINK/);assert.match(csv,/"a,b\nc"/)
  assert.throws(()=>applicationCsv(null),/无效/)
})

test('task data sources migrate legacy payment accounts once, retain passwords by category and redact secrets',()=>{
  const old={keywords:['武汉'],servers:[{baseServer:'https://normal.test',username:'same',password:'normal-secret'}]}
  const legacy=[{url:'https://pay.test/api/',username:'same',passwordEncrypted:'encrypted'}]
  const migrated=migrateLegacyPayments(old,legacy,value=>{assert.equal(value,'encrypted');return 'payment-secret'})
  assert.equal(migrated.paymentServers[0].password,'payment-secret')
  assert.equal(migrateLegacyPayments(migrated,legacy,()=>{throw Error('must not repeat')}),migrated)
  const saved=prepareMonitorSettings(migrated,{keywords:'武汉',servers:[{baseServer:'https://normal.test',username:'same',password:''}],paymentServers:[{baseServer:'https://pay.test/api',username:'same',password:''}]})
  assert.equal(saved.servers[0].password,'normal-secret');assert.equal(saved.paymentServers[0].password,'payment-secret')
  assert.equal(JSON.stringify(publicMonitorSettings(saved)).includes('secret'),false)
  assert.equal(prepareMonitorSettings(saved,{keywords:'武汉',servers:[],paymentServers:[]}).paymentServers.length,0)
  assert.throws(()=>prepareMonitorSettings(saved,{servers:[],paymentServers:[{baseServer:'file:///bad',username:'x'}]}),/HTTP/)
  const damaged=migrateLegacyPayments({},[{url:'https://pay.test',username:'test',passwordEncrypted:'broken'}],()=>{throw Error('private decrypt error')})
  assert.equal(damaged.paymentServers[0].password,'');assert.equal(damaged.migrationWarnings.length,1)
  assert.equal(JSON.stringify(publicMonitorSettings(damaged)).includes('private decrypt'),false)
  assert.equal(migrateLegacyPayments({},null,()=>{}).legacyPaymentsMigrated,true)
})
