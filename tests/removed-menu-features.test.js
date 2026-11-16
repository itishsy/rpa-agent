'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {createTools}=require('../src/agents/development/tools')
test('removed menu features have no UI handlers, IPC channels or knowledge tools',()=>{
  const root=path.resolve(__dirname,'../src')
  const ui=['renderer/index.html','renderer/app.js','renderer/agent-footer.js'].map(file=>fs.readFileSync(path.join(root,file),'utf8')).join('\n')
  for(const id of ['assertions','history','businessContext','businessDiagnosis','importBusinessRules','archiveBusinessCase','importExperience','exportExperience','collectExperience','stopExperience']){
    assert.ok(!ui.includes('id="'+id+'"'))
    assert.ok(!ui.includes("action('"+id+"'"))
  }
  const channels=['main.js','preload.js'].map(file=>fs.readFileSync(path.join(root,file),'utf8')).join('\n')
  for(const channel of ['workspace:assertions','workspace:business-context','business-knowledge:import-rules','business-knowledge:archive','experience:import','experience:export','experience:collect','experience:stop','experience:progress'])assert.ok(!channels.includes("'"+channel+"'"))
  const registry=createTools({})
  for(const name of ['search_business_rules','search_experience'])assert.equal(registry.get(name),undefined)
  for(const name of ['get_business_context','get_diagnosis','run_current_dsl'])assert.ok(registry.get(name))
  for(const file of ['services/experience.js','agents/development/business-knowledge.js','agent/business-knowledge.js'])assert.equal(fs.existsSync(path.join(root,file)),false)
})
