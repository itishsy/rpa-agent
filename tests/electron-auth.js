'use strict'
const {app,BrowserWindow,safeStorage}=require('electron')
app.disableHardwareAcceleration()
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),{createDecipheriv}=require('node:crypto')
const artifacts=path.resolve(__dirname,'../artifacts');fs.mkdirSync(artifacts,{recursive:true})
process.env.RPA_AGENT_TEST_DATA=fs.mkdtempSync(path.join(artifacts,'auth-data-'))
const requests=[],errors=[],checks=[];let expire=false,holdAlice=false,heldResponse
const userServer=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk
  const u=new URL(req.url,'http://local');let data
  const username=u.searchParams.get('username')
  requests.push({path:u.pathname,authorization:req.headers.authorization,body:raw})
  if(u.pathname.endsWith('/oauth/token')){
    try{
      assert.equal(req.method,'POST');assert.equal(raw,'');assert.equal(u.searchParams.get('client_id'),'rpa');assert.equal(u.searchParams.get('grant_type'),'password')
      const decipher=createDecipheriv('aes-128-ecb',Buffer.from('1a2C9b8gh5ltvt0m'),null)
      const password=Buffer.concat([decipher.update(Buffer.from(u.searchParams.get('password'),'base64')),decipher.final()]).toString()
      if(password==='wrong'){res.writeHead(401);res.end('{}');return}
      assert.equal(password,'pass-'+username)
      data={access_token:'user-'+username+'-secret',expires_in:3600,custId:1,custName:'测试客户'}
    }catch(error){errors.push(error.message);res.writeHead(400);res.end('{}');return}
  }else if(u.pathname.endsWith('/sys/user/menu/listMenuByUser/1')){
    assert.match(req.headers.authorization,/^Bearer user-(alice|bob)-secret$/);data={menus:[{name:'流程设计'}],tabs:[],buttons:[]}
  }else if(u.pathname.endsWith('/robot/app/getAppData')){
    if(expire){expire=false;res.end(JSON.stringify({code:5000,msg:'会话已过期'}));return}
    if(holdAlice&&req.headers.authorization==='Bearer user-alice-secret'){heldResponse=res;return}
    const who=req.headers.authorization==='Bearer user-alice-secret'?'alice':'bob'
    assert.equal(req.method,'POST');const body=JSON.parse(raw);assert.ok(body.query.every(q=>['keyWord','appStatusList'].includes(q.property)))
    data={rows:[{appCode:who+'-app',appName:who+' 的应用',version:'1.0',status:1,appArgs:'{}'}],total:1}
  }else {errors.push('Unexpected user endpoint '+u.pathname);res.writeHead(404);res.end('{}');return}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:200,data}))
})
let platformReads=0
const platformServer=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://local');let data
  if(u.pathname.endsWith('/oauth/token'))data={access_token:'executor-platform-secret',custId:2,custName:'执行器业务平台',expires_in:3600}
  else if(u.pathname.endsWith('/oauth/check_token'))data={active:true,exp:Date.now()/1000+3600}
  else {platformReads++;data={rows:[{appCode:'wrong',appName:'不应出现在主页的平台数据'}],total:1}}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:200,data}))
})
const deadline=setTimeout(()=>{console.error('User auth acceptance timed out');app.exit(1)},60000)
app.on('web-contents-created',(_e,contents)=>{
  contents.on('preload-error',(_e,file,error)=>errors.push(file+': '+error.message))
  contents.on('console-message',(_e,details,message)=>{if(details?.level==='error'||details===3)errors.push(details?.message||message)})
})
app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',async()=>{
  if(!win.webContents.getURL().endsWith('/index.html'))return
  const run=code=>win.webContents.executeJavaScript(code,true)
  const wait=async code=>{for(let i=0;i<150;i++){if(await run(code))return;await new Promise(resolve=>setTimeout(resolve,30))}throw new Error('Timed out '+code)}
  const shot=async name=>{await Promise.race([run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'),new Promise(resolve=>setTimeout(resolve,250))]);fs.writeFileSync(path.join(artifacts,name+'.png'),(await win.webContents.capturePage()).toPNG())}
  try{
    await Promise.all([userServer,platformServer].map(server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))))
    const userUrl='http://127.0.0.1:'+userServer.address().port+'/api',platformUrl='http://127.0.0.1:'+platformServer.address().port+'/api'
    await wait('$("userLoginServer").value.length>0')
    assert.equal(await run('document.documentElement.dataset.authenticated'),'false')
    assert.equal(await run('getComputedStyle($("mainContent")).display'),'none')
    assert.equal(requests.length,0)
    assert.match(await run('desktop.invoke("business:action","applications",{page:1,size:20,platformId:"fake"}).then(()=>"unexpected",e=>e.message)'),/先登录/)
    checks.push('login-required-before-home','unauthenticated-IPC-rejected','no-application-requests-before-login')
    await shot('auth-login')
    const login=async(who,password='pass-'+who)=>{
      await run(`$('userLoginServer').value=${JSON.stringify(userUrl)};$('userLoginName').value=${JSON.stringify(who)};$('userLoginPassword').value=${JSON.stringify(password)};$('userLoginForm').requestSubmit()`)
      await wait('!$("userLoginSubmit").disabled')
    }
    await login('alice','wrong');assert.equal(await run('document.documentElement.dataset.authenticated'),'false');assert.match(await run('$("userLoginMessage").textContent'),/密码/)
    await login('alice');await wait('managed.rows[0]?.appCode==="alice-app"')
    assert.equal(await run('(async()=>(await desktop.invoke("platforms:load")).length)()'),0)
    assert.equal(await run('document.body.dataset.currentView'),'home')
    assert.equal(await run('$("userLoginPassword").value'),'')
    assert.match(await run('$("signedInUser").textContent'),/alice/)
    assert.equal(await run('$("pageTitle").textContent'),'工作概览')
    assert.equal(await run('!!$("applicationStatus")'),false)
    await run('sessionStorage.setItem("application-filters:"+currentUser.id,JSON.stringify({status:"3",page:4,size:20}));initializeManagement()')
    assert.equal(await run('managed.page'),1)
    assert.equal(JSON.parse(requests.filter(item=>item.path.endsWith('/robot/app/getAppData')).at(-1).body).query.some(item=>item.property==='appStatusList'),false)
    assert.equal(await run('Object.hasOwn(JSON.parse(sessionStorage.getItem("application-filters:"+currentUser.id)),"status")'),false)
    checks.push('application-management-removes-status-filter-and-migrates-old-state')
    assert.equal(await run('$("workspaceHeader").contains($("signedInUser"))||$("workspaceHeader").contains($("userLogout"))'),false)
    assert.equal(await run('$("applicationHeaderActions").contains($("newApplication"))&&$("applicationHeaderActions").contains($("exportApplications"))'),true)
    assert.equal(await run('$("userMenu").matches(":popover-open")'),false)
    await run('$("userMenuTrigger").click()');await wait('$("userMenu").matches(":popover-open")')
    assert.equal(await run('$("userMenuTrigger").getBoundingClientRect().left<52&&$("userMenuTrigger").getBoundingClientRect().top>innerHeight/2'),true)
    assert.equal(await run('$("userMenu").getBoundingClientRect().bottom<=innerHeight'),true)
    await shot('user-menu-open')
    await run('$("userMenuTrigger").click()');await wait('!$("userMenu").matches(":popover-open")')
    checks.push('application-list-title-and-header-actions','user-info-only-in-avatar-menu','bottom-left-avatar-opens-clamped-menu')
    const userId=await run('currentUser.id')
    checks.push('wrong-password-stays-on-login','IDE-OAuth-AES-query-contract','user-menu-Bearer-contract','applications-without-any-platform-config','current-user-display')
    await shot('auth-alice-home')
    await run(`(async()=>{const result=await desktop.invoke('platforms:save',[{name:'独立执行器平台',url:${JSON.stringify(platformUrl)},username:'executor',password:'platform-pass'}]);await desktop.invoke('platform:select',result.platforms[0].id);await bootstrap();await loadApplicationTable()})()`)
    assert.equal(await run('currentUser.id'),userId);assert.equal(await run('managed.rows[0].appCode'),'alice-app');assert.equal(platformReads,0)
    checks.push('executor-platform-selection-does-not-change-home-user','no-application-query-to-executor-platform')
    const reloaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.webContents.reload();await reloaded;await wait('managed.rows[0]?.appCode==="alice-app"')
    checks.push('renderer-reload-keeps-live-user-session')
    holdAlice=true;await run('window.oldRead=loadApplicationTable().then(()=>"done",e=>e.message);true');await wait('true');for(let i=0;i<100&&!heldResponse;i++)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(heldResponse)
    await run('$("userMenuTrigger").click();$("userLogout").click()');await wait('!currentUser&&document.documentElement.dataset.authenticated==="false"')
    assert.equal(await run('$("userMenu").matches(":popover-open")'),false)
    assert.equal(await run('managed.rows.length'),0);assert.equal(await run('$("applicationTable").textContent.includes("alice 的应用")'),false)
    await login('bob');await wait('managed.rows[0]?.appCode==="bob-app"')
    heldResponse.writeHead(401);heldResponse.end('{"message":"old alice token"}');await run('window.oldRead')
    assert.equal(await run('currentUser.username'),'bob');assert.equal(await run('managed.rows[0].appCode'),'bob-app')
    checks.push('logout-clears-renderer-data','different-users-see-different-applications','late-old-user-401-cannot-log-out-new-user')
    expire=true;await run('loadApplicationTable().catch(()=>{})');await wait('!currentUser&&document.documentElement.dataset.authenticated==="false"')
    assert.equal(await run('managed.rows.length'),0)
    checks.push('IDE-code-5000-expiry-returns-to-login')
    const settings=JSON.parse(safeStorage.decryptString(Buffer.from(fs.readFileSync(path.join(process.env.RPA_AGENT_TEST_DATA,'settings.enc'),'utf8'),'base64')))
    assert.deepEqual(settings.userLogin,{baseUrl:userUrl,username:'bob'})
    assert.equal(JSON.stringify(settings).includes('user-bob-secret'),false);assert.equal(JSON.stringify(settings).includes('pass-bob'),false)
    checks.push('only-login-address-and-username-persist-when-unchecked','unchecked-password-and-token-never-persist')
    await run('$("userLoginRemember").checked=true');await login('bob')
    const remembered=JSON.parse(safeStorage.decryptString(Buffer.from(fs.readFileSync(path.join(process.env.RPA_AGENT_TEST_DATA,'settings.enc'),'utf8'),'base64')))
    assert.equal(remembered.userLogin.rememberPassword,true);assert.equal(remembered.userLogin.password,'pass-bob')
    assert.equal(fs.readFileSync(path.join(process.env.RPA_AGENT_TEST_DATA,'settings.enc'),'utf8').includes('pass-bob'),false)
    assert.equal(JSON.stringify(remembered).includes('user-bob-secret'),false)
    assert.equal(await run('(async()=>(await desktop.invoke("auth:status")).password)()'),'')
    assert.equal(await run('(async()=>Object.hasOwn((await desktop.invoke("settings:get")).userLogin,"password"))()'),false)
    await run('desktop.invoke("auth:logout")');await wait('!currentUser&&$("userLoginRemember").checked&&$("userLoginPassword").value==="pass-bob"')
    const rememberedRequests=requests.length,rememberReloaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.webContents.reload();await rememberReloaded
    await wait('$("userLoginRemember").checked&&$("userLoginPassword").value==="pass-bob"')
    assert.equal(requests.length,rememberedRequests)
    await shot('auth-login-remembered')
    await run('$("userLoginName").value="alice";$("userLoginName").dispatchEvent(new Event("input"))')
    assert.equal(await run('$("userLoginPassword").value'),'')
    const nameReloaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.webContents.reload();await nameReloaded
    await wait('$("userLoginPassword").value==="pass-bob"')
    await run('$("userLoginServer").value="http://127.0.0.1:1/api";$("userLoginServer").dispatchEvent(new Event("input"))')
    assert.equal(await run('$("userLoginPassword").value'),'')
    await run('$("userLoginRemember").click()');await wait('(async()=>!(await desktop.invoke("auth:status")).rememberPassword)()')
    const forgotten=JSON.parse(safeStorage.decryptString(Buffer.from(fs.readFileSync(path.join(process.env.RPA_AGENT_TEST_DATA,'settings.enc'),'utf8'),'base64')))
    assert.equal(Object.hasOwn(forgotten.userLogin,'password'),false)
    const forgottenReloaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.webContents.reload();await forgottenReloaded
    await wait('$("userLoginName").value==="bob"');assert.equal(await run('$("userLoginRemember").checked'),false);assert.equal(await run('$("userLoginPassword").value'),'')
    await run('$("userLoginRemember").checked=true');await login('bob','wrong')
    assert.equal(await run('(async()=>(await desktop.invoke("auth:status")).rememberPassword)()'),false)
    checks.push('remember-password-saved-only-after-success','remembered-password-encrypted-and-no-token','active-session-does-not-expose-remembered-password','logout-and-reload-prefill-without-auto-login','changing-account-clears-prefilled-password','changing-server-clears-prefilled-password','unchecking-erases-password-immediately','forgotten-password-stays-empty-after-reload','failed-login-does-not-remember-password')
    assert.deepEqual(errors,[])
    fs.writeFileSync(path.join(artifacts,'auth-acceptance.json'),JSON.stringify({passed:true,checks,requests:requests.length,scope:'isolated local user service and separate executor platform',screenshots:['auth-login.png','auth-login-remembered.png','auth-alice-home.png','user-menu-open.png']},null,2))
    console.log('User auth acceptance passed: '+checks.length+' checks');clearTimeout(deadline);userServer.close();platformServer.close();app.exit(0)
  }catch(error){console.error(error.stack,errors);await shot('auth-failure').catch(()=>{});clearTimeout(deadline);userServer.close();platformServer.close();app.exit(1)}
}))
require('../src/main')
