'use strict'
const SERVICE_ITEMS = [[1,'增员'],[2,'减员'],[3,'调基'],[5,'补缴'],[6,'缴费'],[7,'在册名单'],[8,'费用明细'],[9,'政策通知'],[10,'基数申报'],[11,'登录'],[12,'查审核结果'],[13,'调基名单'],[14,'参保证明'],[15,'获取待缴'],[16,'申报核定'],[17,'缴费扣款'],[18,'获取凭据'],[19,'撤销核定'],[20,'公司参保证明'],[21,'获取同步待缴'],[22,'申报同步核定'],[23,'获取缴费截图']]
const FLOW_STATUSES = ['配置','调试通过','等待数据','验证有效','修复问题']
const managed = { page: 1, size: 20, rows: [], app: null, flows: [], completeFlows: [], appRequest: 0, flowRequest: 0, platformId: '' }
let businessPending = false
const business = (name, input = {}) => invoke('business:action', name, { ...input, platformId: managed.platformId })
const multiValues = element => [...element.selectedOptions].map(option => option.value)
const safeObject = value => typeof value === 'string' ? JSON.parse(value || '{}') : value || {}
function managementAction(work) { return async (...args) => { try { await work(...args) } catch (error) { notice(error.message, true) } } }
function shortTime(value) {
  if (value === null || value === undefined || value === '') return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : String(value)
}
function table(container, columns, rows, actions) {
  container.replaceChildren()
  const element = document.createElement('table'); element.className = 'data-table'
  const head = document.createElement('thead'), header = document.createElement('tr')
  for (const column of columns) { const th = document.createElement('th'); th.textContent = column.label; header.append(th) }
  if (actions) { const th = document.createElement('th'); th.textContent = '操作'; header.append(th) }
  head.append(header); element.append(head)
  const body = document.createElement('tbody')
  for (const row of rows) {
    const tr = document.createElement('tr')
    for (const column of columns) {
      const td = document.createElement('td'), value = column.format ? column.format(row) : row[column.key]
      if (column.click) {
        const button = document.createElement('button'); button.className = 'link-button'; button.textContent = value ?? '—'
        button.onclick = managementAction(() => column.click(row)); td.append(button)
      } else td.textContent = value === null || value === undefined || value === '' ? '—' : String(value)
      tr.append(td)
    }
    if (actions) {
      const cell = document.createElement('td'); cell.className = 'actions'
      for (const [label, handler] of actions(row)) {
        const button = document.createElement('button'); button.textContent = label
        button.onclick = async () => { button.disabled = true; try { await handler() } catch (error) { notice(error.message, true) } finally { button.disabled = false } }
        cell.append(button)
      }
      tr.append(cell)
    }
    body.append(tr)
  }
  if (!rows.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns.length + !!actions; td.className = 'empty'; td.textContent = '暂无数据'; tr.append(td); body.append(tr) }
  element.append(body); container.append(element)
}
function formField(parent, name, label, { value = '', options, type = 'text', required = false, wide = false, disabled = false } = {}) {
  const wrapper = document.createElement('label'); wrapper.textContent = label; if (wide) wrapper.className = 'wide'
  const control = document.createElement(options ? 'select' : type === 'textarea' ? 'textarea' : 'input')
  if (!options && type !== 'textarea') control.type = type
  control.name = name; control.dataset.field = name; control.disabled = disabled; control.required = required
  if (options) {
    control.add(new Option('请选择', ''))
    for (const item of options) control.add(new Option(item[1], String(item[0])))
    if (value !== '' && value != null && ![...control.options].some(item => item.value === String(value))) control.add(new Option(String(value), String(value)))
  }
  control.value = value ?? ''; wrapper.append(control); parent.append(wrapper)
  return control
}
function nativeForm(title, help, submit, { readonly = false } = {}) {
  if ($('businessDialog').open) throw new Error('请先完成或关闭当前操作')
  const formPlatformId = managed.platformId
  $('businessTitle').textContent = title; $('businessHelp').textContent = help || ''; $('businessError').textContent = ''
  $('businessFields').replaceChildren(); $('businessFields').className = 'business-fields'
  $('businessSave').hidden = readonly; $('businessSave').textContent = '确认保存'
  $('businessForm').onsubmit = async event => {
    event.preventDefault(); if (businessPending) return
    businessPending = true; $('businessSave').disabled = true; $('businessError').textContent = ''
    try {
      if (formPlatformId !== managed.platformId) throw new Error('登录用户已变化，请关闭表单后重新打开')
      await submit(); $('businessDialog').close()
    }
    catch (error) { $('businessError').textContent = error.message }
    finally { businessPending = false; $('businessSave').disabled = false }
  }
  $('businessDialog').showModal(); return $('businessFields')
}
$('businessClose').onclick = () => { if (!businessPending) $('businessDialog').close() }
$('businessDialog').addEventListener('cancel', event => { if (businessPending) event.preventDefault() })
function readTable(title, rows, columns) {
  const content = nativeForm(title, '', async () => {}, { readonly: true }); content.className = ''
  table(content, columns, rowsOf(rows))
}
async function loadApplicationTable() {
  const requestId = ++managed.appRequest, platformId = managed.platformId
  const result = await business('applications', { page: managed.page, size: managed.size, keyword: $('applicationKeyword').value })
  if (requestId !== managed.appRequest || platformId !== managed.platformId) return
  managed.rows = result.rows
  managed.hasNext = result.hasNext
  $('managementPage').textContent = '第' + result.page + '页' + (result.total === null ? '' : ' · 共' + result.total + '条')
  $('managementPrevious').disabled = result.page <= 1; $('managementNext').disabled = !result.hasNext
  renderApplicationTable(result.rows)
  sessionStorage.setItem('application-filters:' + platformId, JSON.stringify({ keyword:$('applicationKeyword').value,page:managed.page,size:managed.size }))
}
function renderApplicationTable(rows) {
  table($('applicationTable'), [
    { key:'appName',label:'应用名称' },
    { label:'版本状态',format:row=>Number(row.status)===0?'有新版本未发布':Number(row.status)===1?'已发布':'未发布' },
    { key:'version',label:'版本号' }, { label:'最新发布时间',format:row=>shortTime(row.releaseTime) }
  ], rows, row=>[['流程设计',()=>invoke('design:open',{platformId:managed.platformId,appCode:row.appCode})]])
}
renderApplicationTable([])
async function syncApplicationSelection(app) {
  if (![...$('application').options].some(item=>item.value===app.appCode)) $('application').add(new Option(app.appName || app.appCode,app.appCode))
  $('application').value = app.appCode
  await loadFlows()
}
async function openFlowManagement(app, taskName, mainOnly=false) {
  if(typeof resetFlowFilterSearch==='function')resetFlowFilterSearch()
  managed.app = app; managed.flowRequest++
  $('managedAppName').textContent = (app.appName || app.appCode) + ' · RPA流程管理'; $('managedAppCode').textContent = app.appCode
  $('designFlowTab').textContent='RPA流程管理（'+(app.appName||app.appCode)+'）'
  if(![...$('application').options].some(item=>item.value===app.appCode))$('application').add(new Option(app.appName||app.appCode,app.appCode))
  $('application').value=app.appCode
  $('flowKeyword').value = ''; [...$('flowTypes').options].forEach(option=>{option.selected=!mainOnly||option.value==='1'})
  selectOptions($('flowServices'),SERVICE_ITEMS,item=>String(item[0]),item=>item[1])
  ;[...$('flowServices').options].forEach(option=>{option.selected=!!taskName&&option.textContent===taskName})
  managed.completeFlows = await business('flows',{appCode:app.appCode})
  flowRows=managed.completeFlows;selectOptions($('flow'),flowRows,item=>item.flowCode,item=>(item.relationFlowCode?'↗ ':'')+item.flowName,'选择流程')
  const systems = [...new Map(managed.completeFlows.filter(row=>row.declareSystem!==null&&row.declareSystem!==undefined&&row.declareSystem!=='').map(row=>[String(row.declareSystem),[row.declareSystem,row.declareSystemName||row.declareSystem]])).values()]
  selectOptions($('flowSystems'),systems,item=>String(item[0]),item=>item[1]); [...$('flowSystems').options].forEach(option=>{option.selected=false})
  if (taskName && !SERVICE_ITEMS.some(item=>item[1]===taskName)) $('flowKeyword').value = taskName
  setView('flowManagement'); await loadManagedFlows(taskName?null:managed.completeFlows.filter(row=>!mainOnly||Number(row.flowType)===1))
}
async function loadManagedFlows(initialRows=null) {
  if (!managed.app) throw new Error('请先从应用列表进入流程管理')
  if(typeof syncFlowFilters==='function')syncFlowFilters()
  if(!multiValues($('flowTypes')).length)throw new Error('请至少选择一种流程类型')
  document.querySelectorAll('.flow-filter-popup:popover-open').forEach(popup=>popup.hidePopover())
  const requestId = ++managed.flowRequest, appCode = managed.app.appCode
  const rows = Array.isArray(initialRows)?initialRows:await business('flows',{appCode,flowTypeList:multiValues($('flowTypes')).map(Number),serviceItemList:multiValues($('flowServices')).map(Number),declareSystemList:multiValues($('flowSystems'))})
  if (requestId!==managed.flowRequest || appCode!==managed.app.appCode) return
  const keyword = $('flowKeyword').value.trim().toLowerCase()
  managed.flows = rows.filter(row=>!keyword||String(row.flowName||'').toLowerCase().includes(keyword)).sort((a,b)=>Number(a.execOrder)-Number(b.execOrder))
  table($('flowManagementTable'),[
    {key:'execOrder',label:'执行顺序'},{key:'serviceItemName',label:'服务项目'},{label:'流程类型',format:row=>Number(row.flowType)===2?'子流程':'主流程'},
    {key:'declareSystemName',label:'申报系统'},{key:'runSupportName',label:'运行载体'},{label:'流程名称',format:row=>(row.relationFlowCode?'↗ ':'')+row.flowName},
    {key:'comment',label:'备注'},{key:'tagName',label:'标签'},{label:'更新时间',format:row=>shortTime(row.updateTime)}
  ],managed.flows,row=>[
    ['AI配置',()=>openManagedSteps(row)],['编辑',()=>flowForm('edit',row)]
  ])
}
async function refreshManagedFlows() {
  managed.completeFlows = await business('flows',{appCode:managed.app.appCode})
  await syncApplicationSelection(managed.app); await loadManagedFlows()
}
async function openManagedSteps(row) {
  if(workspaceOpening)return
  $('application').value=managed.app.appCode
  if(![...$('flow').options].some(item=>item.value===row.flowCode))$('flow').add(new Option(row.flowName,row.flowCode))
  $('flow').value=row.flowCode
  await openFlow()
}
async function applicationForm(row) {
  const [types, regions, businessTypes] = await Promise.all([business('appTypes'),business('regions'),business('dictionary',{key:'1001'})])
  const args = structuredClone(safeObject(row?.appArgs)), refs = {}, services = structuredClone(row?.serviceVOList || [1,2,3,5,6,7,8,9].map(serviceItem=>({id:null,appCode:null,serviceItem,serviceStatus:2,serviceRemark:''})))
  const typeRows = rowsOf(types), selectedType = typeRows.find(item=>item.robotName===row?.robotName||item.robotCode===row?.robotName)
  let dynamicLoading = false
  const content = nativeForm(row?'编辑应用':'添加应用','未实现的服务项目必须填写情况说明；编辑时保留未展示的应用参数。',async()=>{
    if (dynamicLoading) throw new Error('应用字段仍在加载，请稍后保存')
    const appArgs={...args}
    for (const [key,control] of Object.entries(refs)) appArgs[key]=control.value
    if (refs.addrName) { const region=regionRows.find(item=>String(item.id)===refs.addrName.value); appArgs.addrId=region?.id||args.addrId; appArgs.addrName=region?.name||args.addrName }
    await business('saveApplication',{id:row?.id,appCode:row?.appCode,appName:name.value,robotName:type.value,appRemark:remark.value,appArgs,robotServiceItemList:services})
    if(current?.scope.appCode===row?.appCode)clearWorkspace()
    await loadApplicationTable(); notice('应用已保存')
  })
  const name=formField(content,'appName','应用名称',{value:row?.appName,required:true})
  const type=formField(content,'robotName','机器人类型',{value:selectedType?.robotCode||'',options:typeRows.map(item=>[item.robotCode,item.robotName]),required:true})
  const remark=formField(content,'appRemark','备注',{value:row?.appRemark,type:'textarea',wide:true})
  const dynamic=document.createElement('div'); dynamic.className='wide business-fields'; content.append(dynamic)
  const regionRows=[]
  const flatten=items=>rowsOf(items).forEach(item=>{if(item.id!=null&&item.name)regionRows.push(item);for(const value of Object.values(item))if(Array.isArray(value))flatten(value)})
  flatten(regions)
  let dynamicRequest=0
  const draw=async()=>{
    const version=++dynamicRequest; dynamicLoading=true
    let definitions
    try { definitions=rowsOf(await business('dynamicFields',{robotCode:type.value})) } finally { if(version===dynamicRequest)dynamicLoading=false }
    if(version!==dynamicRequest)return
    dynamic.replaceChildren(); for(const key of Object.keys(refs))delete refs[key]
    for(const definition of definitions){
      const key=definition.fieldKey
      if(!key)continue
      const options=key==='addrName'?regionRows.map(item=>[item.id,item.name]):key==='businessType'?rowsOf(businessTypes).map(item=>[item.dictCode,item.dictName]):undefined
      refs[key]=formField(dynamic,key,definition.fieldName||key,{value:key==='addrName'?args.addrId:args[key],options,required:true,disabled:!!row&&['addrName','businessType'].includes(key)})
    }
  }
  type.onchange=managementAction(draw); if(type.value)await draw()
  const group=document.createElement('div');group.className='wide';content.append(group)
  const heading=document.createElement('h3');heading.textContent='服务项目';group.append(heading)
  for(const service of services){
    const line=document.createElement('div');line.className='service-row'
    const label=document.createElement('span');label.textContent=SERVICE_ITEMS.find(item=>Number(item[0])===Number(service.serviceItem))?.[1]||service.serviceItem
    const status=document.createElement('select');for(const option of [[2,'待配置'],[1,'已实现'],[0,'不实现']])status.add(new Option(option[1],option[0]));status.value=service.serviceStatus??2
    const explanation=document.createElement('input');explanation.value=service.serviceRemark||'';explanation.placeholder='情况说明';explanation.setAttribute('aria-label',label.textContent+'情况说明')
    status.onchange=()=>{service.serviceStatus=Number(status.value);explanation.required=status.value==='0'}
    explanation.oninput=()=>{service.serviceRemark=explanation.value};status.onchange();line.append(label,status,explanation);group.append(line)
  }
}
function applicationOperation(row, operation) {
  const refs={}, titles={releaseApplication:'上线应用',offlineApplication:'下架应用',statusApplication:'调整应用状态',syncApplication:'同步至生产'}
  const content=nativeForm(titles[operation],row.appName+' · 启用账户 '+(row.startAccountCount??0)+' / 停用账户 '+(row.stopAccountCount??0)+' / 问题流程 '+(row.problemCount??0),async()=>{
    const input=Object.fromEntries(Object.entries(refs).map(([key,control])=>[key,control.value]))
    await business(operation,{...input,appCode:row.appCode});await loadApplicationTable();notice(titles[operation]+'已完成')
  })
  if(operation==='releaseApplication'){
    if(Number(row.problemCount)>0){const warning=document.createElement('div');warning.className='wide form-error';warning.textContent='该应用仍有 '+row.problemCount+' 个问题流程，请核对后再上线。';content.append(warning)}
    refs.rule=formField(content,'rule','版本规则',{value:'补丁',options:[['主版本号','主版本'],['子版本号','子版本'],['补丁','补丁']],required:true})
    refs.changeReason=formField(content,'changeReason','变更原因',{required:true})
  }
  if(['offlineApplication','statusApplication'].includes(operation))refs.appStatus=formField(content,'appStatus','目标状态',{options:[[0,'调研'],[1,'配置'],[2,'调试通过'],[3,'等待数据'],[4,'验证有效'],[6,'修复问题']],required:true})
  const key=operation==='statusApplication'?'remark':'comment'
  refs[key]=formField(content,key,operation==='releaseApplication'?'更新内容（最多500字）':'原因说明',{type:'textarea',required:true,wide:true})
  if(operation==='releaseApplication')refs[key].maxLength=500
}
async function showVersions(row) {
  const result=await business('versions',{appCode:row.appCode}), content=nativeForm('历史版本 · '+row.appName,'选择历史版本后仍需确认激活。',async()=>{},{readonly:true});content.className=''
  table(content,[{key:'version',label:'版本号'},{key:'comment',label:'更新内容'},{key:'createName',label:'操作人'},{label:'时间',format:item=>shortTime(item.createTime||item.releaseTime)}],rowsOf(result),version=>[['使用此版本',async()=>{
    $('businessDialog').close();nativeForm('激活版本',row.appName+' → '+version.version,async()=>{await business('activateVersion',{appCode:row.appCode,version:version.version});await loadApplicationTable()})
  }]])
}
async function flowForm(mode='add', row) {
  if(!managed.app)throw new Error('请先选择应用')
  const app=managed.app, args=safeObject(app.appArgs)
  const [systems,carriers,tags,templates,sources]=await Promise.all([
    business('dictionary',{key:Number(args.businessType)===1001001?'10007':'10008'}),business('robotDictionary',{key:'10019'}),
    business('robotDictionary',{key:'10018'}),business('templates'),mode==='copyAdd'?business('flowSources'):Promise.resolve(managed.completeFlows)
  ])
  const refs={}, titles={add:'添加流程',edit:'编辑流程',copyAdd:'复制现有流程',relateAdd:'关联已有流程'}
  const content=nativeForm(titles[mode],mode==='edit'?'编辑流程配置和执行顺序，保存后生效；删除操作位于下方。':'自定义主流程可按服务项目生成；复制、关联和编辑不会自动生成。',async()=>{
    const input=Object.fromEntries(Object.entries(refs).map(([key,control])=>[key,control.value]))
    if(mode==='add'&&input.flowType==='1'&&generate.checked){
      if(!input.serviceItem)throw new Error('生成步骤前请选择服务项目')
      if(!await confirmNavigation())throw new Error('已取消创建流程')
      const created=await invoke('workspace:generate-flow',{...input,appCode:app.appCode})
      clearWorkspace();await refreshManagedFlows();$('flow').value=created.flowCode;$('businessDialog').close();await openFlow()
      $('mode').value='generate';$('request').value=created.request
      invoke('agent:start',current.id,{request:created.request,mode:'generate'}).then(refreshSnapshot).catch(error=>notice(error.message,true))
    }else{
      await business('saveFlow',{...input,appCode:app.appCode,flowCode:row?.flowCode,mode})
      if(mode==='edit'&&current?.scope.flowCode===row?.flowCode)clearWorkspace()
      if(mode==='edit'&&Number(input.execOrder)!==Number(row.execOrder)){
        try{await business('orderFlow',{appCode:app.appCode,flowCode:row.flowCode,execOrder:input.execOrder})}
        catch(error){await refreshManagedFlows();throw new Error('流程信息已保存，但排序未完成：'+error.message+'。请核对后重试。')}
      }
      await refreshManagedFlows();notice('流程已保存')
    }
  })
  const addMode=formField(content,'addMode','添加方式',{value:mode,options:[['add','自定义'],['copyAdd','复制现有'],['relateAdd','关联已有'],...(mode==='edit'?[['edit','编辑当前流程']]:[])],disabled:mode==='edit'})
  if(mode==='edit')addMode.parentElement.hidden=true
  addMode.onchange=managementAction(async()=>{$('businessDialog').close();await flowForm(addMode.value,row)})
  refs.flowName=formField(content,'flowName','流程名称',{value:mode==='edit'?row?.flowName:row?row.flowName+' 副本':'',required:true})
  refs.flowType=formField(content,'flowType','流程类型',{value:row?.flowType||1,options:[[1,'主流程'],[2,'子流程']],required:true})
  refs.serviceItem=formField(content,'serviceItem','服务项目',{value:row?.serviceItem,options:SERVICE_ITEMS})
  refs.declareSystem=formField(content,'declareSystem','申报系统',{value:row?.declareSystem,options:rowsOf(systems).map(item=>[item.dictCode,item.dictName]),required:true})
  refs.runSupport=formField(content,'runSupport','运行载体',{value:row?.runSupport,options:rowsOf(carriers).map(item=>[item.dictCode,item.dictName]),required:true})
  refs.tagCode=formField(content,'tagCode','标签',{value:row?.tagCode,options:rowsOf(tags).map(item=>[item.dictCode,item.dictName])})
  refs.templateFlowCode=formField(content,'templateFlowCode','模板引用',{value:row?.templateFlowCode,options:rowsOf(templates).map(item=>[item.flowCode,item.flowName]),disabled:mode==='relateAdd'})
  if(['copyAdd','relateAdd'].includes(mode))refs.sourceFlowCode=formField(content,'sourceFlowCode','来源流程',{value:row?.flowCode,options:rowsOf(sources).map(item=>[item.flowCode,item.appNameAndFlowName||item.flowName]),required:true})
  const label=document.createElement('label');label.className='wide checkbox';const generate=document.createElement('input');generate.type='checkbox';generate.checked=true;label.append(generate,'根据服务项目生成步骤');content.append(label)
  const flowTypeChanged=()=>{const child=refs.flowType.value==='2';if(child)refs.serviceItem.value='';refs.serviceItem.disabled=child;refs.templateFlowCode.disabled=mode==='relateAdd'||mode==='add'&&child;if(mode==='add'&&child)refs.templateFlowCode.value='';label.hidden=mode!=='add'||child}
  refs.flowType.onchange=flowTypeChanged;flowTypeChanged()
  if(mode==='edit'){
    refs.execOrder=formField(content,'execOrder','执行顺序（保存时生效）',{value:row.execOrder,type:'number',required:true})
    refs.execOrder.min=Math.min(...managed.completeFlows.map(item=>Number(item.execOrder)));refs.execOrder.max=Math.max(...managed.completeFlows.map(item=>Number(item.execOrder)));refs.execOrder.step='1'
    const more=document.createElement('details');more.className='wide flow-edit-more';const moreTitle=document.createElement('summary');moreTitle.textContent='其他流程操作';more.append(moreTitle)
    const hint=document.createElement('p');hint.className='muted';hint.textContent='以下操作使用已保存的流程配置；当前表单输入不会自动保存。';more.append(hint)
    for(const [title,work] of [['复制流程',()=>flowForm('copyAdd',row)],['关联流程',()=>flowForm('relateAdd',row)],['调整状态',()=>flowStatusForm(row)],['状态历史',()=>flowHistory(row)]]){
      const button=document.createElement('button');button.type='button';button.textContent=title;button.onclick=managementAction(async()=>{$('businessDialog').close();await work()});more.append(button)
    }
    content.append(more)
    const danger=document.createElement('details');danger.className='wide flow-delete-zone'
    const summary=document.createElement('summary');summary.textContent='删除流程';danger.append(summary)
    const explanation=document.createElement('p');explanation.textContent='删除“'+row.flowName+'”后将无法在列表中恢复，请先核对。';danger.append(explanation)
    const confirmation=document.createElement('label');confirmation.className='checkbox';const checked=document.createElement('input');checked.type='checkbox';checked.id='confirmFlowDeletion';confirmation.append(checked,'我确认删除此流程')
    const remove=document.createElement('button');remove.id='deleteEditedFlow';remove.type='button';remove.className='danger';remove.textContent='删除此流程';remove.disabled=true
    checked.onchange=()=>{remove.disabled=!checked.checked||businessPending}
    const userId=managed.platformId
    remove.onclick=async()=>{
      if(!checked.checked||businessPending)return
      if(managed.platformId!==userId){$('businessError').textContent='登录用户已变化，请重新打开表单';return}
      const controls=[...$('businessForm').querySelectorAll('button,input,select,textarea')].map(control=>[control,control.disabled])
      businessPending=true;controls.forEach(([control])=>{control.disabled=true});$('businessError').textContent=''
      try{
        await business('deleteFlow',{appCode:app.appCode,flowCode:row.flowCode})
        if(current?.scope.flowCode===row.flowCode)clearWorkspace()
        await refreshManagedFlows();$('businessDialog').close();notice('流程已删除')
      }catch(error){$('businessError').textContent=error.message}
      finally{businessPending=false;controls.forEach(([control,disabled])=>{control.disabled=disabled})}
    }
    danger.append(confirmation,remove);content.append(danger)
  }
}
function flowOrderForm(row) {
  const content=nativeForm('流程排序',row.flowName+'；排序范围来自当前应用完整流程列表。',async()=>{await business('orderFlow',{appCode:managed.app.appCode,flowCode:row.flowCode,execOrder:order.value});await refreshManagedFlows()})
  const order=formField(content,'execOrder','新执行顺序',{value:row.execOrder,type:'number',required:true})
  order.min=Math.min(...managed.completeFlows.map(item=>Number(item.execOrder)));order.max=Math.max(...managed.completeFlows.map(item=>Number(item.execOrder)))
}
function flowStatusForm(row) {
  const content=nativeForm('调整流程状态',row.flowName,async()=>{await business('statusFlow',{appCode:managed.app.appCode,flowCode:row.flowCode,status:status.value,comment:comment.value});await refreshManagedFlows();if(managed.completeFlows.length&&managed.completeFlows.every(item=>Number(item.status)===3))notice('全部流程已验证有效，可返回应用列表上线。')})
  const status=formField(content,'status','目标状态',{value:row.status,options:FLOW_STATUSES.map((item,index)=>[index,item]),required:true})
  const comment=formField(content,'comment','原因备注',{type:'textarea',wide:true})
  status.onchange=()=>{comment.required=status.value==='4'};status.onchange()
}
async function flowHistory(row) {
  readTable('状态历史 · '+row.flowName,await business('flowHistory',{appCode:managed.app.appCode,flowCode:row.flowCode}),[
    {key:'actionName',label:'操作'},{key:'flowStatusName',label:'流程状态'},{key:'remark',label:'原因备注'},{key:'appStatusName',label:'应用状态'},{key:'createName',label:'操作人'},{label:'时间',format:item=>shortTime(item.createTime)}])
}
function deleteFlowForm(row){nativeForm('删除流程','确认删除“'+row.flowName+'”？此操作将提交到平台。',async()=>{await business('deleteFlow',{appCode:managed.app.appCode,flowCode:row.flowCode});if(current?.scope.flowCode===row.flowCode)clearWorkspace();await refreshManagedFlows()})}
async function initializeManagement(bootstrapData) {
  const data=bootstrapData||await invoke('app:bootstrap')
  const changed=managed.platformId!==data.platformId
  managed.platformId=data.platformId
  if(changed){managed.app=null;managed.rows=[];managed.appRequest++;managed.flowRequest++}
  if(!managed.platformId)return
  if(document.documentElement.dataset.windowMode==='design')return
  try{const saved=JSON.parse(sessionStorage.getItem('application-filters:'+managed.platformId)||'{}');managed.page=saved.status?1:saved.page||1;managed.size=saved.size||20;$('applicationKeyword').value=saved.keyword||'';$('applicationPageSize').value=managed.size}catch(_){}
  await loadApplicationTable()
}
action('searchApplications',async()=>{managed.page=1;await loadApplicationTable()})
action('resetApplications',async()=>{$('applicationKeyword').value='';managed.page=1;await loadApplicationTable()})
$('applicationKeyword').addEventListener('keydown',event=>{if(event.key==='Enter')$('searchApplications').click()})
action('managementPrevious',async()=>{if(managed.page>1){managed.page--;await loadApplicationTable()}})
action('managementNext',async()=>{managed.page++;try{await loadApplicationTable()}catch(error){managed.page--;throw error}})
$('applicationPageSize').onchange=managementAction(async()=>{managed.size=Number($('applicationPageSize').value);managed.page=1;await loadApplicationTable()})
action('newApplication',()=>applicationForm())
action('exportApplications',()=>invoke('business:export-applications',{platformId:managed.platformId,rows:managed.rows}))
action('backApplications',async()=>{setView('applications');await loadApplicationTable()})
action('newFlow',()=>flowForm())
action('searchManagedFlows',loadManagedFlows)
action('resetManagedFlows',async()=>{[...$('flowTypes').options].forEach(option=>{option.selected=true});for(const id of ['flowServices','flowSystems'])[...$(id).options].forEach(option=>{option.selected=false});$('flowKeyword').value='';if(typeof resetFlowFilterSearch==='function')resetFlowFilterSearch();await loadManagedFlows()})
action('organizeFlows',async()=>{if(!managed.app)throw new Error('请选择应用');nativeForm('流程整理','将按登录、服务项目和子流程整理完整列表，不受当前筛选影响。',async()=>{await business('organizeFlows',{appCode:managed.app.appCode});await refreshManagedFlows();notice('流程整理完成')})})
document.addEventListener('user-authenticated',event=>initializeManagement(event.detail).catch(error=>notice(error.message,true)))
window.desktop.on('app:navigate-flow',managementAction(async input=>{
  clearWorkspace();await bootstrap();managed.platformId=input.platformId
  let app
  if(input.appCode){try{app=await business('application',{appCode:input.appCode})}catch(_){}}
  if(!app){const result=await business('applications',{page:1,size:100,keyword:input.appName});const matches=result.rows.filter(row=>row.appName===input.appName);if(matches.length!==1)throw new Error('无法唯一确定监控对应的应用，请从应用列表手工查找');app=matches[0]}
  await openFlowManagement(app,input.taskName)
}))
document.querySelector('[data-workbench-view="applications"]').onclick=managementAction(async()=>{setView('applications');if(managed.platformId)await loadApplicationTable()})
document.querySelector('[data-workbench-view="flowManagement"]').onclick=managementAction(async()=>{
  if(!managed.app&&$('application').value){const app=await business('application',{appCode:$('application').value});await openFlowManagement(app)}
  else if(managed.app)setView('flowManagement')
  else {setView('applications');notice('请从应用列表选择需要管理流程的应用');if(managed.platformId)await loadApplicationTable()}
})
// Reconnect and login both emit platform-connected. A cold start has no in-memory
// identity, so the initial table stays explicit until the user connects.
