'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const {digest}=require('../src/agent-core/store')
const {registerTakeoverHandlers}=require('../src/handoff/takeover-service')

test('接管统计按当前用户和本机日期读取，跨日清零并保留累计次数',()=>{
  const handlers=new Map(),settings={accountTakeoverTotals:{[digest('user-A')]:8}}
  let userId='user-A'
  registerTakeoverHandlers({handle:(name,handler)=>handlers.set(name,handler),
    ensureIdentity:id=>({id}),activeUserId:()=>userId,getSettings:()=>settings})
  const stats=handlers.get('monitor:takeover-stats')
  assert.deepEqual(stats(),{userId:'user-A',active:0,today:0,total:8})
  const now=new Date()
  const date=[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-')
  settings.accountTakeoverDaily={[digest('user-A')]:{date,count:3}}
  assert.equal(stats().today,3)
  settings.accountTakeoverDaily[digest('user-A')].date='2000-01-01'
  assert.equal(stats().today,0)
  assert.equal(stats().total,8)
  userId='user-B'
  assert.deepEqual(stats(),{userId:'user-B',active:0,today:0,total:0})
})
