'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {runtimeUrl,matchTask}=require('../src/services/runtime-control')
test('takeover uses configured runtime and requires a unique task account',()=>{
 assert.equal(runtimeUrl({baseUrl:'http://192.0.2.10:9090'}),'http://192.0.2.10:19090')
 assert.equal(runtimeUrl({baseUrl:'http://192.0.2.10:9090',runtimeUrl:'https://runtime.example.test:19091'}),'https://runtime.example.test:19091')
 assert.throws(()=>runtimeUrl({runtimeUrl:'http://user:password@example.test'}),/用户名/)
 assert.equal(matchTask([{taskCode:'one',accountNumber:'001'}],{taskCode:'one'}).taskCode,'one')
 assert.throws(()=>matchTask([{taskCode:'other',accountNumber:'001'}],{taskCode:'one',accountNumber:'001'}),/唯一匹配/)
 assert.throws(()=>matchTask([{taskCode:'one',accountNumber:'001'},{taskCode:'two',accountNumber:'001'}],{accountNumber:'001'}),/唯一匹配/)
})
