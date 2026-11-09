'use strict'
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { spawn } = require('node:child_process'), { createHash } = require('node:crypto')
const asar = require('@electron/asar'), net = require('node:net')
const root = path.resolve(__dirname, '..'), packageDirectory=path.resolve(root,process.argv[2]||'release/win-unpacked')
const archive = path.join(packageDirectory, 'resources/app.asar')
const executable = path.join(packageDirectory, 'rpa-agent.exe'), artifacts = path.join(root, 'artifacts')
const files = []
function compare(dir) {
  for(const item of fs.readdirSync(path.join(root, dir), { withFileTypes:true })) {
    const relative=path.join(dir,item.name)
    if(item.isDirectory())compare(relative)
    else {assert.deepEqual(asar.extractFile(archive,relative),fs.readFileSync(path.join(root,relative)),relative);files.push(relative)}
  }
}
async function main(){
  compare('src')
  const packaged = JSON.parse(asar.extractFile(archive,'package.json'))
  assert.equal(packaged.name,'rpa-agent')
  assert.equal(packaged.version,require('../package.json').version)
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve))
  const testData=fs.mkdtempSync(path.join(artifacts,'package-data-'))
  const child=spawn(executable,['--disable-gpu',...process.argv.slice(3),'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port],{env:{...process.env,RPA_AGENT_TEST_DATA:testData},stdio:'ignore',windowsHide:true})
  let socket
  try{
    let targets=[]
    for(let i=0;i<150;i++){
      if(child.exitCode!==null)throw new Error('Packaged app exited '+child.exitCode)
      try{targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json()}catch(_){}
      if(targets.some(target=>target.url.endsWith('/index.html')))break
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    const target=targets.find(target=>target.url.endsWith('/index.html'));assert.ok(target,'packaged native page opened')
    socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject})
    let sequence=0
    const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>reject(new Error('CDP timeout')),5000);const listener=event=>{const message=JSON.parse(event.data);if(message.id!==id)return;clearTimeout(timer);socket.removeEventListener('message',listener);if(message.error)reject(new Error(message.error.message));else resolve(message.result)};socket.addEventListener('message',listener);socket.send(JSON.stringify({id,method,params}))})
    let ready=false
    for(let i=0;i<100;i++){
      try{const check=await call('Runtime.evaluate',{expression:'document.readyState==="complete"&&!!window.desktop&&!!document.getElementById("applicationTable")',returnByValue:true});ready=check.result?.value===true}catch(_){}
      if(ready)break
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    assert.ok(ready,'packaged renderer loaded')
    const result=await call('Runtime.evaluate',{expression:`(async()=>({node:typeof window.require,bootstrap:await desktop.invoke('app:bootstrap'),title:document.getElementById('pageTitle').textContent}))()`,awaitPromise:true,returnByValue:true})
    assert.equal(result.exceptionDetails,undefined,JSON.stringify(result.exceptionDetails))
    const value=result.result.value;assert.equal(value.node,'undefined');assert.equal(value.bootstrap.connected,false);assert.equal(value.bootstrap.platforms.length,0)
    assert.equal(value.title,'工作概览')
    const gate=await call('Runtime.evaluate',{expression:`document.documentElement.dataset.authenticated==='false'&&getComputedStyle(document.getElementById('mainContent')).display==='none'&&!!document.getElementById('userLoginForm')`,returnByValue:true})
    assert.equal(gate.result.value,true)
    // Verify real identifiers from the shipped HTML, not test-only UI.
    const structure=await call('Runtime.evaluate',{expression:`['applicationTable','flowManagementTable','executionFields','monitor'].every(id=>!!document.getElementById(id))`,returnByValue:true})
    assert.equal(structure.result.value,true)
    fs.writeFileSync(path.join(artifacts,'package-check.json'),JSON.stringify({passed:true,sourceFiles:files.length,byteIdentical:true,packagedLaunch:true,securePreload:true,isolatedProfile:true,executable,sha256:createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),checkedAt:new Date().toISOString()},null,2))
    await call('Runtime.evaluate',{expression:'setTimeout(()=>window.close(),50)'})
    for(let i=0;i<50&&child.exitCode===null;i++)await new Promise(resolve=>setTimeout(resolve,100))
    console.log('Package verified: '+files.length+' identical source files; executable launched with isolated data and secure preload.')
  }finally{socket?.close();if(child.exitCode===null)child.kill()}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1})
