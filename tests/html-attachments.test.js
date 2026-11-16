'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {extractHtml}=require('../src/shared/html-input')
const {attachHtml,prepareHtmlRequest}=require('../src/services/html-attachments')
const {Harness}=require('../src/agent/harness')
const {createTools}=require('../src/agent/tools')
function fixture(){
  const session={id:'s',scope:{flowCode:'flow'},runs:[],events:[],sequence:0,artifacts:{},messages:[]}
  const harness=new Harness({store:{save(){}},registry:createTools({})})
  return {session,harness}
}
const html='<!doctype html><html><body><form><input id="account"><button id="login">登录</button></form></body></html>'
test('large pasted documents become files while instructions before and after HTML remain intact',()=>{
  const source=html.replace('</form>','<div>'+'x'.repeat(90000)+'</div></form>')
  const split=extractHtml('请输入账号\n'+source+'\n然后点击登录')
  assert.equal(split.parts[0],source);assert.match(split.text,/请输入账号/);assert.match(split.text,/然后点击登录/)
  const {session,harness}=fixture(),request=prepareHtmlRequest(session,'请输入账号\n'+source+'\n然后点击登录',[],harness)
  assert.ok(request.length<2000);assert.match(request,/\.html/);assert.equal(session.attachments.length,1)
  assert.equal(harness.readArtifact(session,session.attachments[0].artifactId).content,source)
  assert.equal(session.messages.length,0)
})
test('HTML fences and fragments are detected without turning ordinary prose into attachments',()=>{
  assert.equal(extractHtml('配置两个步骤\n```html\n'+html+'\n```\n不要运行').parts.length,1)
  assert.equal(extractHtml('<div><input id="x"><button>确认</button></div>').parts.length,1)
  assert.equal(extractHtml('金额 < 100，人数 > 0').parts.length,0)
})
test('file content is deduplicated, names are safe and selection cannot cross sessions',()=>{
  const {session,harness}=fixture(),file=attachHtml(session,html,harness,'../../页面.htm')
  assert.equal(file.name,'页面.html');assert.equal(attachHtml(session,html,harness).artifactId,file.artifactId)
  assert.equal(session.attachments.length,1)
  assert.match(prepareHtmlRequest(session,'点击登录',[file.artifactId],harness),/点击登录/)
  assert.throws(()=>prepareHtmlRequest({...session,attachments:[]},'点击登录',[file.artifactId],harness),/不属于/)
  assert.throws(()=>attachHtml(session,'x'.repeat(5*1024*1024+1),harness),/5MiB/)
  assert.throws(()=>prepareHtmlRequest(session,'x'.repeat(32001),[],harness),/需求文字过长/)
  assert.equal(prepareHtmlRequest(session,'x'.repeat(32000),[],harness).length,32000)
})
test('attachments survive normal artifact cleanup and remain available in generate mode',async()=>{
  const {session,harness}=fixture(),file=attachHtml(session,html,harness)
  for(let i=0;i<65;i++)harness.artifact(session,{i})
  assert.equal(harness.readArtifact(session,file.artifactId).kind,'html_attachment')
  const registry=createTools({htmlEvidence:async(_,options)=>({elements:[{xpath:'//*[@id="login"]',xpathMatches:1}],...options})})
  assert.ok(registry.schemas('generate').some(item=>item.function.name==='inspect_html_attachment'))
  assert.ok(!registry.schemas('generate').some(item=>item.function.name==='run_current_dsl'))
  const tool=registry.get('inspect_html_attachment')
  const result=await tool.run(tool.validate({artifactId:file.artifactId}),{session,harness})
  assert.equal(result.elements[0].xpathMatches,1)
  await assert.rejects(tool.run({artifactId:'other'},{session,harness}),/不属于/)
})

test('HTML inspection normalizes oversized pages without weakening type or session validation',async()=>{
  const {session,harness}=fixture(),file=attachHtml(session,html,harness)
  const registry=createTools({htmlEvidence:async(_,options)=>options}),tool=registry.get('inspect_html_attachment')
  for(const [requested,expected] of [[1,1],[25,25],[40,40],[41,40],[1000,40]]){
    const result=await tool.run(tool.validate({artifactId:file.artifactId,limit:requested,offset:40}),{session,harness})
    assert.equal(result.limit,expected);assert.equal(result.offset,40)
  }
  for(const limit of [0,-1,1.5,'100',null,Infinity])assert.throws(()=>tool.validate({artifactId:file.artifactId,limit}))
  const schema=registry.schemas('generate').find(item=>item.function.name==='inspect_html_attachment').function.parameters
  assert.match(schema.properties.limit.description,/nextOffset/)
  assert.equal(schema.properties.limit.maximum,9007199254740991)
  await assert.rejects(tool.run(tool.validate({artifactId:'other',limit:100}),{session,harness}),/不属于/)
})
