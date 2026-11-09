'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),{createDecipheriv}=require('node:crypto')
const {createUserAuth}=require('../src/services/user-auth')
test('IDE-compatible login uses AES-ECB query credentials and user-scoped Bearer menus, without exposing secrets',async()=>{
  const calls=[],auth=createUserAuth({request:async(url,fields,options)=>{
    calls.push({url,fields,options})
    if(url.endsWith('/oauth/token'))return {access_token:'user-secret',expires_in:30,custName:'测试客户'}
    return {code:200,data:{menus:[{name:'应用'}],tabs:[],buttons:['add']}}
  },now:()=>1000})
  assert.throws(()=>auth.requireIdentity(),/先登录/)
  const user=await auth.login({baseUrl:'http://localhost:3000/api/',username:' alice ',password:'password123'})
  assert.equal(calls[0].url,'http://localhost:3000/api/oauth/token');assert.equal(calls[0].options.query,true)
  assert.equal(calls[0].fields.username,'alice');assert.equal(calls[0].fields.grant_type,'password')
  const decipher=createDecipheriv('aes-128-ecb',Buffer.from('1a2C9b8gh5ltvt0m'),null)
  assert.equal(Buffer.concat([decipher.update(Buffer.from(calls[0].fields.password,'base64')),decipher.final()]).toString(),'password123')
  assert.equal(calls[1].url,'http://localhost:3000/api/sys/user/menu/listMenuByUser/1');assert.equal(calls[1].options.headers.Authorization,'Bearer user-secret')
  assert.ok(!JSON.stringify(user).includes('user-secret'));assert.equal(user.username,'alice');assert.deepEqual(user.buttons,['add'])
  assert.equal(auth.requireIdentity().token,'user-secret');auth.logout();assert.equal(auth.status(),null)
})
test('failed permissions, missing tokens and expired sessions cannot authorize workbench reads',async()=>{
  const auth=createUserAuth({request:async url=>url.endsWith('/oauth/token')?{access_token:'secret'}:{code:403,message:'无权访问'}})
  await assert.rejects(auth.login({username:'alice',password:'x'}),/无权访问/);assert.equal(auth.status(),null)
  const missing=createUserAuth({request:async()=>({message:'用户名或者密码错误'})})
  await assert.rejects(missing.login({username:'alice',password:'x'}),/密码/)
  let now=0
  const expiring=createUserAuth({now:()=>now,request:async url=>url.endsWith('/oauth/token')?{access_token:'secret',expires_in:1}:{data:{menus:[]}}})
  await expiring.login({username:'alice',password:'x'});now=1001;assert.throws(()=>expiring.requireIdentity(),/过期/)
})
test('logout supersedes an in-flight login, and account partitions bind both user and API endpoint',async()=>{
  let release
  const auth=createUserAuth({request:async url=>url.endsWith('/oauth/token')?new Promise(resolve=>{release=resolve}):{data:{}}})
  const pending=auth.login({username:'alice',password:'x'});auth.logout();release({access_token:'late'})
  await assert.rejects(pending,/取消/);assert.equal(auth.status(),null)
  const separate=createUserAuth({request:async url=>url.endsWith('/oauth/token')?{access_token:'secret'}:{data:{}}})
  const first=await separate.login({baseUrl:'http://localhost:3000/api',username:'alice',password:'x'}),firstIdentity=separate.requireIdentity()
  const second=await separate.login({baseUrl:'http://localhost:3000/api',username:'bob',password:'x'})
  assert.notEqual(first.id,second.id);assert.equal(separate.isCurrent(firstIdentity),false)
  const third=await separate.login({baseUrl:'http://localhost:3001/api',username:'alice',password:'x'})
  assert.notEqual(first.id,third.id)
})
