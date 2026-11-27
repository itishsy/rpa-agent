'use strict'
const {app,BrowserWindow}=require('electron')
app.disableHardwareAcceleration()
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict')
const artifacts=path.resolve(__dirname,'../artifacts');fs.mkdirSync(artifacts,{recursive:true})
const {inspectHtmlDocument}=require('../src/services/html-evidence')
process.env.RPA_AGENT_TEST_DATA=fs.mkdtempSync(path.join(artifacts,'html-input-data-'))
let inspected=false,modelCalls=0,artifactId
const requests=[]
const html='<!doctype html><html><head><title>登录页面</title><script>window.HTML_SCRIPT_RAN=true</script></head><body><form><input id="unit" placeholder="单位账号"><button id="login">登录</button><input id="a\'b&quot;c"></form><div>'+'source-only-'.repeat(9000)+'</div></body></html>'
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk
  const url=new URL(req.url,'http://local'),p=url.pathname,body=raw?JSON.parse(raw):{}
  requests.push(p)
  const reply=data=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:200,data}))}
  try{
    if(p==='/v1/chat/completions'){
      modelCalls++
      assert.ok(!raw.includes('source-only-'.repeat(100)))
      const latestContent=body.messages.filter(item=>item.role==='user').at(-1)?.content||''
      const latest=Array.isArray(latestContent)?latestContent[0].text:latestContent
      if(latest.includes('[html-generation]')){
        assert.equal(body.model,'alternate-model')
        assert.match(latest,/需求\.md/)
        assert.match(latestContent.find(part=>part.type==='image_url').image_url.url,/^data:image\/jpeg;base64,/)
      }
      if(!latest.includes('[html-fallback]'))assert.ok(body.tools.every(tool=>!/^run_|continue_failed_run/.test(tool.function.name)))
      const match=latest.match(/\{[^\n]+\.html"[^\n]+\}/)
      assert.ok(match);artifactId=JSON.parse(match[0]).artifactId
      const names=new Set(body.messages.flatMap(item=>(item.tool_calls||[]).map(call=>call.function.name)))
      let calls
      if(!names.has('inspect_html_attachment'))calls=[['inspect_html_attachment',{artifactId,limit:100}],['get_action_detail',{actionCode:'input'}],['get_action_detail',{actionCode:'click'}]]
      else if(!names.has('propose_dsl_patch')&&!latest.includes('[html-fallback]')){
        if(modelCalls===2){
          res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'建议确认验证码后再生成步骤。'}}]}));return
        }
        assert.equal(body.tool_choice.function.name,'propose_dsl_patch')
        const outputs=body.messages.filter(item=>item.role==='tool').map(item=>{try{return JSON.parse(item.content)}catch(_){return {}}})
        const evidence=outputs.find(item=>item.elements)
        assert.equal(evidence.title,'登录页面');assert.ok(evidence.elements.every(item=>item.xpathMatches===1))
        assert.equal(evidence.limit,40);assert.equal(evidence.nextOffset,null)
        assert.ok(evidence.elements.some(item=>item.id==='a\'b"c'))
        inspected=true
        calls=[['propose_dsl_patch',{baseRevision:0,operations:[
          {op:'insert',index:0,step:{stepName:'输入单位账号',actionCode:'input',actionArgs:{inputValue:'demo'},targetArgs:{xpath:evidence.elements.find(item=>item.id==='unit').xpath}}},
          {op:'insert',index:1,step:{stepName:'输入验证码（待补充）',actionCode:'input',status:0,targetArgs:{xpath:evidence.elements.find(item=>item.id==='a\'b"c').xpath}}},
          {op:'insert',index:2,step:{stepName:'点击登录',actionCode:'click',targetArgs:{xpath:evidence.elements.find(item=>item.id==='login').xpath}}}
        ]}]]
      }
      const message=calls?{role:'assistant',content:'',tool_calls:calls.map(([name,args],i)=>({id:'html-'+modelCalls+'-'+i,type:'function',function:{name,arguments:JSON.stringify(args)}}))}
        :{role:'assistant',content:'已根据HTML生成步骤，未执行流程。'}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:calls?'tool_calls':'stop',message}]}));return
    }
    if(p.endsWith('/oauth/token'))return reply({access_token:'test-token',custId:1,custName:'测试客户',expires_in:3600})
    if(p.endsWith('/oauth/check_token'))return reply({active:true,exp:Date.now()/1000+3600})
    if(p.endsWith('/sys/user/menu/listMenuByUser/1'))return reply({menus:[],tabs:[],buttons:[]})
    if(p.endsWith('/robot/app/getAppData')||p.endsWith('/robot/app/page'))return reply({rows:[{appCode:'app',appName:'HTML示例',appArgs:'{}'}],total:1})
    if(p.endsWith('/robot/flow/list'))return reply([{flowCode:'flow',flowName:'政务验证码登入',appCode:'app'},{flowCode:'other',flowName:'其他流程',appCode:'app'}])
    if(p.includes('/robot/flow/step/list/'))return reply([])
    if(p.endsWith('/robot/action/all'))return reply([{actionCode:'input',actionName:'输入文本'},{actionCode:'click',actionName:'点击'}])
    if(p.endsWith('/robot/action/args'))return reply(url.searchParams.get('dataCode')==='input'?[{fieldKey:'inputValue',fieldName:'输入值',fieldType:'text',required:1}]:[])
    if(p.endsWith('/robot/action/target/args'))return reply([{fieldKey:'xpath',fieldName:'元素定位',fieldType:'text',required:1}])
    if(p.endsWith('/robot/task/listAllTask'))return reply([{taskCode:'html-test-account'}])
    if(p.endsWith('/robot/start/status'))return reply(0)
    throw new Error('Unexpected endpoint '+p)
  }catch(error){console.error(error.stack);res.writeHead(500);res.end(JSON.stringify({message:error.message}))}
})
const deadline=setTimeout(()=>{console.error('HTML input acceptance timed out');app.exit(1)},60000)
app.on('browser-window-created',(_,win)=>win.webContents.once('did-finish-load',async()=>{
  if(!win.webContents.getURL().endsWith('/index.html'))return
  const run=code=>win.webContents.executeJavaScript(code,true)
  const wait=async code=>{for(let i=0;i<200;i++){if(await run(code))return;await new Promise(resolve=>setTimeout(resolve,30))}throw new Error('Timed out '+code)}
  try{
    const pagedHtml='<html><body>'+Array.from({length:45},(_,i)=>'<button id="page-'+i+'">按钮'+i+'</button>').join('')+'</body></html>'
    const inspect=options=>run(`(${inspectHtmlDocument.toString()})(${JSON.stringify(pagedHtml)},${JSON.stringify(options)})`)
    const first=await inspect({limit:100,offset:0})
    assert.equal(first.elements.length,40);assert.equal(first.nextOffset,40);assert.equal(first.total,45)
    const last=await inspect({limit:100,offset:first.nextOffset})
    assert.equal(last.elements.length,5);assert.equal(last.nextOffset,null)
    assert.equal(new Set([...first.elements,...last.elements].map(item=>item.id)).size,45)
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint='http://127.0.0.1:'+server.address().port
    await run(`desktop.invoke('auth:login',{baseUrl:${JSON.stringify(endpoint+'/api')},username:'test',password:'offline'})`)
    await run(`desktop.invoke('settings:save',{remoteEnabled:true,connections:[{baseUrl:${JSON.stringify(endpoint)},debugToken:'test-debug'}],modelBaseUrl:${JSON.stringify(endpoint+'/v1')},modelName:'configured-model',additionalModelNames:['alternate-model'],modelApiKey:'test-key'})`)
    await run('(async()=>{await bootstrap();await loadApplications()})()');await wait('$("application").options.length>1')
    await run('(async()=>{$("application").value="app";await loadFlows();$("flow").value="flow";await openFlow();$("mode").value="generate";$("request").value="[html-generation] 输入账号demo并点击登录";$("request").setSelectionRange($("request").value.length,$("request").value.length)})()')
    await run(`(()=>{const clipboard=new DataTransfer();clipboard.setData('text/plain',${JSON.stringify(html)});$('request').dispatchEvent(new ClipboardEvent('paste',{clipboardData:clipboard,bubbles:true,cancelable:true}))})()`)
    await wait('$("requestAttachments").textContent.includes(".html")&&!$("requestAttachments").textContent.includes("正在添加")')
    assert.ok((await run('$("request").value')).length<100)
    assert.notEqual(await run('getComputedStyle($("mode")).display'),'none')
    assert.deepEqual(await run('[...$("mode").options].map(option=>option.textContent)'),['调试与修复','仅配置步骤','仅运行'])
    assert.deepEqual(await run('[...$("composerModel").options].map(option=>option.value)'),['configured-model','alternate-model'])
    assert.ok(await run('$("attachFile").getBoundingClientRect().width>0'))
    await run(`(async()=>{
      const files=new DataTransfer();
      files.items.add(new File(['## 登录需求'],'需求.md'));
      const picker=$('agentFileInput');
      let opened=false;
      picker.click=()=>{opened=true};
      $('attachFile').click();
      delete picker.click;
      if(!opened)throw Error('附件按钮未打开文件选择');
      picker.files=files.files;
      picker.dispatchEvent(new Event('change'));
      const image=new DataTransfer();
      const canvas=document.createElement('canvas');
      canvas.getContext('2d').fillRect(0,0,20,20);
      const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      image.items.add(new File([png],'现场.png',{type:'image/png'}));
      $('request').dispatchEvent(new ClipboardEvent('paste',{clipboardData:image,bubbles:true,cancelable:true}));
      $('composerModel').value='alternate-model';
    })()`)
    await wait('$("requestAttachments").querySelectorAll(".html-attachment").length===3&&!$("send").disabled')
    const documentArtifact=await run('desktop.invoke("agent:artifact",current.id,attachmentDrafts.get(current.id).find(file=>file.name==="需求.md").artifactId)')
    assert.equal(documentArtifact.content,'## 登录需求')
    await run('window.savedRequest=$("request").value;$("request").value="";$("send").click()')
    await wait('$("notice").textContent.includes("请描述需要配置的步骤")&&!$("send").disabled')
    assert.equal(await run('$("requestAttachments").querySelectorAll(".html-attachment").length'),3)
    await run('$("request").value=window.savedRequest')
    assert.ok(await run('$("attachFile").getBoundingClientRect().right < $("mode").getBoundingClientRect().left && $("mode").getBoundingClientRect().right < $("send").getBoundingClientRect().left && $("composerModel").getBoundingClientRect().bottom < $("request").getBoundingClientRect().top'))
    await run('$("hideDisabledSteps").checked=true;$("hideDisabledSteps").dispatchEvent(new Event("change"));$("send").click()');await wait('current?.proposal?.dsl.steps.length===3&&current.state==="completed"')
    assert.equal(await run('current.dsl.steps.length'),0)
    await run('$("applyCandidate").click()');await wait('$("patchReviewDialog")?.open')
    assert.equal(await run('current.dsl.steps.length'),0)
    assert.equal(await run('$("patchReviewDialog").querySelectorAll(".patch-change").length'),3)
    await run('$("patchReviewDialog").querySelector(".patch-change").open=true')
    await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    fs.writeFileSync(path.join(artifacts,'patch-review.png'),await win.webContents.capturePage().then(image=>image.toPNG()))
    await run('$("patchReviewDialog").close()');await wait('!$("patchReviewDialog")')
    assert.equal(await run('current.dsl.steps.length'),0)
    assert.ok(await run('!!current.proposal'))
    await run('$("previewCandidate").click()');await wait('$("patchReviewDialog")?.open')
    await run('$("confirmApplyPatch").click()');await wait('!$("patchReviewDialog")||!!$("patchReviewDialog").querySelector("[role=alert]").textContent')
    assert.equal(await run('$("patchReviewDialog")?.querySelector("[role=alert]").textContent||""'),'')
    assert.equal(await run('current.dsl.steps.length'),3)
    assert.equal(inspected,true);assert.equal(await run('current.proposal'),null)
    assert.equal(await run('$("stepTree").textContent.includes("输入单位账号")'),true)
    assert.equal(await run('$("hideDisabledSteps").checked'),false)
    assert.equal(await run('current.dsl.steps[1].status'),0)
    assert.equal(await run('getComputedStyle($("stepTree").querySelectorAll(".step-row")[1]).display')==='none',false)
    assert.equal(await run('current.savedBaseline.steps.length'),0)
    fs.writeFileSync(path.join(artifacts,'html-generated-editor.png'),await win.webContents.capturePage().then(image=>image.toPNG()))
    assert.equal(await run('window.HTML_SCRIPT_RAN===undefined'),true)
    assert.equal(await run('current.attachments.length'),3)
    const sessionId=await run('current.id'),meta=await run('current.attachments.find(file=>file.mimeType==="text/html")')
    assert.match(meta.name,/\.html$/)
    const rawArtifact=await run(`desktop.invoke('agent:artifact',current.id,${JSON.stringify(meta.artifactId)})`)
    assert.equal(rawArtifact.kind,'html_attachment');assert.ok(rawArtifact.content.length>32000)
    const fallback='[html-fallback] 仅阅读HTML，保留候选。\n'+html
    await run('desktop.invoke("workspace:update",current.id,{taskCode:"html-test-account"})')
    await run(`desktop.invoke('agent:start',current.id,{request:${JSON.stringify(fallback)},mode:'develop'})`)
    await run('refreshSnapshot()');assert.equal(await run('current.attachments.length'),3)
    assert.match(await run('desktop.invoke("agent:start",current.id,{request:"测试",mode:"generate",modelName:"unknown"}).catch(error=>error.message)'),/请选择已配置/)
    const other=await run(`desktop.invoke('workspace:open',{appCode:'app',flowCode:'other',executor:${JSON.stringify(endpoint)}})`)
    const rejected=await run(`desktop.invoke('agent:start',${JSON.stringify(other.session.id)},{request:'生成步骤',mode:'generate',attachmentIds:[${JSON.stringify(meta.artifactId)}]}).then(()=>'unexpected',error=>error.message)`)
    assert.match(rejected,/不属于当前会话/)
    assert.ok(!requests.some(item=>item.includes('/debug/runs')||item.includes('/step/save')||item.includes('/remoteTask')))
    const storeFile=path.join(process.env.RPA_AGENT_TEST_DATA,'sessions',sessionId+'.session')
    assert.ok(!fs.readFileSync(storeFile,'utf8').includes('source-only-'))
    // The HTML content is an encrypted artifact; model requests contain references and summaries.
    const artifactFiles=fs.readdirSync(path.join(process.env.RPA_AGENT_TEST_DATA,'sessions',sessionId+'-artifacts'))
    assert.ok(artifactFiles.length>0)
    fs.writeFileSync(path.join(artifacts,'html-input-acceptance.json'),JSON.stringify({passed:true,checks:['premature-analysis-redirected','generated-steps-in-left-editor','incomplete-step-disabled-and-visible','three-operation-modes-visible','oversized-page-normalization','complete-element-pagination','html-paste-to-file','long-request-fallback','preserved-intent','static-xpath-validation','no-script-execution','no-execution-or-save','session-scope','deduplication']},null,2))
    console.log('HTML input acceptance passed: large paste -> attachment -> static evidence -> actual steps in the left editor, without running or saving a flow.')
    clearTimeout(deadline);server.close();app.exit(0)
  }catch(error){console.error(error.stack);clearTimeout(deadline);server.close();app.exit(1)}
}))
require('../src/main')
