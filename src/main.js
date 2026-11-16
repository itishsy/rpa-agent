'use strict'
const {flowMetadata,stepMetadata}=require('./services/flow-metadata')
const { app, BrowserWindow, ipcMain, Menu, dialog, safeStorage, session: electronSession, shell, clipboard, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { SessionStore, clone, digest } = require('./agent-core/store')
const { ExecutionEvidence } = require('./services/execution-evidence')
const { Harness } = require('./agents/development/agent')
const {ExecutorLeases} = require('./agent-core/executor-leases')
const {registerOperationsHandlers} = require('./ipc/operations-handlers')
const {registerDevelopmentHandlers} = require('./ipc/development-handlers')
const {registerTakeoverHandlers} = require('./handoff/takeover-service')
const { checkpoint, executorKey } = require('./agent-core/control')
const { createTools, validateCandidate, toSaveRows } = require('./agents/development/tools')
const { attachHtml, attachFile, addImageParts } = require('./services/html-attachments')
const { validateModelSettings, configuredModelNames } = require('./services/model-settings')
const { inspectHtmlDocument } = require('./services/html-evidence')
const { platformRequest } = require('./services/platform-api')
const { createPlatformService, updateProperties, activatePlatform } = require('./services/platform-service')
const executor = require('./services/executor-service')
const {normalizeExecutorAccounts}=require('./services/executor-accounts')
const {createPatchWorkflow}=require('./services/patch-workflow')
const control = require('./services/executor-control')
const { completeChat } = require('./agent-core/model-client')
const { buildDebugDsl, nestDebugSteps, loadReferencedDebugFlows } = require('./services/debug-dsl')
const { refreshUndeclaredData, analysisSourceKey } = require('./services/undeclared-monitor')
const { buildTaskExport } = require('./services/undeclared-export')
const { diagnosisCard } = require('./agents/development/diagnosis')
const { createBusinessService } = require('./services/business')
const { prepareMonitorSettings, publicMonitorSettings, migrateLegacyPayments } = require('./services/monitor-settings')
const { validateAppearance, appearanceSnapshot } = require('./services/appearance')
const { nativeTheme } = require('electron')
const {createUserAuth,DEFAULT_USER_API}=require('./services/user-auth')
const userAuth=createUserAuth()

app.setName('rpa-agent')
require('electron').nativeTheme.themeSource = 'dark'
// Separate from the older IDE, which already calls its data folder rpa-agent.
app.setPath('userData', process.env.RPA_AGENT_TEST_DATA || path.join(app.getPath('appData'), 'rpa-agent-electron'))
const root = path.join(__dirname, 'renderer')
const windows = new Set()
const sessions = new Map()
const productionRuns = new Set()
const executorLeases = new ExecutorLeases()
const takeoverContexts=new Map(),takeovers=new Set()
let monitorSnapshot=null
const monitorAnalysisRuns=new Map()
const monitorAnalysisFields=['incompleteReason','analyzedAt','analysisModel','analysisResult','analysisAttempted','analysisCategory']
function monitorFacts(row){return digest(Object.fromEntries(Object.entries(row).filter(([key])=>!monitorAnalysisFields.includes(key))))}
const workspaceOwners = new Map()
const commandCache = new Map()

let mainWindow, store, executionEvidence, harness, platforms, settings, mcp, mcpSessionId, businessWriting = false
const codec = {
  encrypt(value) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存凭据或会话')
    return safeStorage.encryptString(value).toString('base64')
  },
  decrypt(value) { return safeStorage.decryptString(Buffer.from(value, 'base64')) }
}
function readSettings() {
  const file = path.join(app.getPath('userData'), 'settings.enc')
  try { return JSON.parse(codec.decrypt(fs.readFileSync(file, 'utf8'))) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { platformId: '', modelBaseUrl: '', modelName: '', modelApiKey: '', localDebugToken: '', remoteEnabled: false, connections: [], monitor: { keywords: '', servers: [] } }
  }
}
function saveSettings() {
  const file = path.join(app.getPath('userData'), 'settings.enc')
  fs.writeFileSync(file + '.tmp', codec.encrypt(JSON.stringify(settings)))
  fs.renameSync(file + '.tmp', file)
}
function currentAppearance() {return appearanceSnapshot(settings.appearance,nativeTheme.shouldUseDarkColors)}
function broadcastAppearance() {
  const value=currentAppearance()
  for(const win of windows)if(!win.isDestroyed()){
    win.setBackgroundColor(value.resolvedTheme==='dark'?'#1c1c1e':'#f5f5f7')
    if(win.isMainShell)win.setTitleBarOverlay({color:value.resolvedTheme==='dark'?'#242426':'#ececef',symbolColor:value.resolvedTheme==='dark'?'#f5f5f7':'#1d1d1f',height:36})
    win.webContents.send('appearance:changed',value)
  }
}
function busy() { return monitorAnalysisRuns.size>0||takeovers.size>0||businessWriting || productionRuns.size>0 || harness && harness.active.size > 0 }
function assertIdle() { if(productionRuns.size)throw new Error('请等待执行器本次运行结束');if (busy()) throw new Error('请先停止正在运行或等待授权的 Agent 轮次') }
function activeUserId(){return userAuth.status()?.id||''}
function broadcastUser(){for(const win of windows)if(!win.isDestroyed())win.webContents.send('auth:changed',userAuth.status())}
function invalidateUserSession(){
  for (const run of monitorAnalysisRuns.values()) run.controller.abort()
  userAuth.logout()
  for(const current of sessions.values())if(harness.active.has(current.id))harness.stop(current).catch(()=>{})
  sessions.clear();workspaceOwners.clear();commandCache.clear();closeMcp().catch(()=>{})
  for(const win of [...windows])if(win!==mainWindow&&!win.isDestroyed())win.destroy()
  broadcastUser()
}
function ensureIdentity(id) {
  let identity
  try{identity=userAuth.requireIdentity()}catch(error){if(userAuth.status())invalidateUserSession();throw error}
  if(id!==identity.id)throw new Error('用户会话已变化，请重新打开')
  return identity
}
async function userRequest(input, expectedIdentity=ensureIdentity(activeUserId())){
  if(!userAuth.isCurrent(expectedIdentity))throw new Error('用户会话已变化，请重新操作')
  try{
    const result=await platformRequest(expectedIdentity,input)
    if(!userAuth.isCurrent(expectedIdentity))throw new Error('用户会话已变化，已忽略旧请求结果')
    return result
  }catch(error){
    if(!userAuth.isCurrent(expectedIdentity))throw new Error('用户会话已变化，已忽略旧请求结果')
    if(userAuth.isCurrent(expectedIdentity)&&([401,5000].includes(Number(error.code))||error.status===401||error.message==='无法获取当前登录用户信息'))invalidateUserSession()
    throw error
  }
}
function requireSession(id) {
  const current = sessions.get(id)
  if (!current || current.scope.platformId !== activeUserId()) throw new Error('会话不属于当前登录用户，请重新打开')
  const identity = ensureIdentity(current.scope.platformId)
  if (identity.username !== current.scope.username || identity.url !== current.scope.platformUrl) throw new Error('登录用户已变化，请重新打开')
  connection(current)
  return current
}
function sessionSnapshot(current) {
  return { ...clone(current), diagnosisCard: current.turn?.mode === 'dslRun' ? null : diagnosisCard(current), productionRunning:productionRuns.has(current.id), executorBlocked: harness.leases.owners.has(executorKey(current.scope.executor)) }
}
function connection(current) {
  const baseUrl = current.scope.executor
  if (!settings.remoteEnabled && baseUrl === executor.DEFAULT_EXECUTOR_BASE_URL) return { baseUrl, debugToken: settings.localDebugToken }
  const found = settings.remoteEnabled && settings.connections.find(item => item.baseUrl === baseUrl)
  if (!found) throw new Error('会话绑定的执行器已失效，请重新打开')
  return found
}
async function robot(current, input) {
  const selected = connection(current)
  const response = await executor.request(selected.baseUrl, { ...input, debugToken: selected.debugToken })
  if (response && response.code && Number(response.code) !== 200) throw new Error(response.message || '执行器请求失败')
  return response && Object.hasOwn(response, 'data') ? response.data : response
}
async function api(current, input) { return userRequest(input,ensureIdentity(current.scope.platformId)) }
const adapters = {
  async commands(current, codes = []) {
    const key = current.scope.platformId
    if (!commandCache.has(key)) {
      const definitions=await api(current,{path:'robot/action/all'})
      if(!Array.isArray(definitions))throw new Error('命令中心返回格式无效')
      commandCache.set(key,definitions.filter(item=>!['start','end'].includes(item.actionCode)))
    }
    const items = commandCache.get(key)
    if (!Array.isArray(items)) throw new Error('命令中心返回格式无效')
    for (const code of new Set(codes)) {
      const item = items.find(command => command.actionCode === code)
      if (!item) throw new Error('未知指令：' + code)
      if (!item.actionArgsVOS || !item.targetArgsVOS) {
        const [actionArgsVOS, targetArgsVOS] = await Promise.all([
          api(current, { path: 'robot/action/args', params: { dataCode: code } }),
          api(current, { path: 'robot/action/target/args', params: { dataCode: code } })
        ])
        if (!Array.isArray(actionArgsVOS) || !Array.isArray(targetArgsVOS)) throw new Error('指令参数定义无效')
        Object.assign(item, { actionArgsVOS, targetArgsVOS })
      }
    }
    return { items, oldSteps: current.editorRows || [] }
  },
  flows: async current => (await api(current, { path: 'robot/flow/list', body: { appCode: current.scope.appCode } })).map(flowMetadata),
  steps: async (current,input) => {
    const code=typeof input==='string'?input:input.flowCode
    const rows=await api(current,{path:'robot/flow/step/list/'+encodeURIComponent(code),params:{}})
    if(!Array.isArray(rows))throw new Error('流程步骤必须为数组：'+code)
    return rows.map(stepMetadata)
  },
  async tasks(current) {
    const { appName, scope: { appCode } } = current
    if (!appName) throw new Error('缺少应用名称，请重新打开应用后查询申报账户')
    const query = new URLSearchParams({ appCode, appName })
    const accounts = normalizeExecutorAccounts(await robot(current, {
      path: '/api/robot/task/listAllTask?' + query, method: 'POST', timeout: 20000
    }))
    return current.takeoverTaskCode?accounts.filter(account=>account.taskCode===current.takeoverTaskCode):accounts
  },
  executionDependencies(current) {
    // Capture local drafts before asynchronous bundle loading and check again at commit.
    return [...sessions.values()].filter(item => item.scope.platformId === current.scope.platformId &&
      item.scope.platformUrl === current.scope.platformUrl && item.scope.username === current.scope.username &&
      item.scope.executor === current.scope.executor && item.scope.appCode === current.scope.appCode &&
      (item.id === current.id || (!item.readOnly && !item.serverChanged && digest(item.dsl) !== digest(item.savedBaseline))))
      .map(item => ({ id: item.id, revision: item.revision, dsl: digest(item.dsl),
        baseline: digest(item.savedBaseline || null), businessProfile: digest(item.businessProfile || null), readOnly: !!item.readOnly, serverChanged: !!item.serverChanged }))
      .sort((a, b) => a.id.localeCompare(b.id))
  },
  async bundle(current, dsl, { proposal = null,inspectionFlowCode,inspect=false } = {}) {
    const bundle = await loadReferencedDebugFlows(dsl, current.scope.appCode, {
      listFlows: () => adapters.flows(current),
      listSteps: flow => adapters.steps(current,flow),
      overrideFlow(flow, owner) {
        if (owner !== current.scope.appCode || flow.readOnly) return null
        if (proposal?.targetFlowCode === flow.flowCode) return clone(proposal.dsl)
        const child = [...sessions.values()].find(item => item.scope.platformId === current.scope.platformId &&
          item.scope.platformUrl === current.scope.platformUrl && item.scope.username === current.scope.username &&
          item.scope.executor === current.scope.executor && item.scope.appCode === owner && item.scope.flowCode === flow.flowCode &&
          !item.readOnly && !item.serverChanged && digest(item.dsl) !== digest(item.savedBaseline))
        return child ? clone(child.dsl) : null
      },
      async prepareFlow(definition, flow, owner) {
        const target = { ...current, scope: { ...current.scope, appCode: owner, flowCode: flow.flowCode } }
        const codes = definition.steps.flatMap(step => [step.actionCode, ...(step.body || step.children || []).map(child => child.actionCode)])
        const commands = await adapters.commands(target, codes)
        const rows = validateCandidate(target, definition, { ...commands, oldSteps: [] }, { execution: true })
        return buildDebugDsl(owner, flow.flowCode, definition, rows)
      }
    },{inspect:inspect||!!inspectionFlowCode,targetFlowCode:inspectionFlowCode})
    if (proposal?.targetFlowCode) {
      const definition = bundle.subflows.find(flow => flow.flowCode === proposal.targetFlowCode)
      if (!definition) throw new Error('候选目标不再属于主流程调用范围')
    }
    return bundle
  },
  async inspectSubflow(current, flowCode) {
    const bundle = await adapters.bundle(current, clone(current.dsl),{inspectionFlowCode:flowCode})
    const definition = bundle.subflows.find(flow => flow.flowCode === flowCode)
    if (!definition) throw new Error('目标不属于当前主流程的实际调用范围，不能读取')
    return { scope: { ...current.scope, flowCode }, revision: null, readOnly: true,
      dsl: { ...clone(definition), appCode: current.scope.appCode },
      inspectionDiagnostics:bundle.inspectionDiagnostics }
  },
  async subflow(current, flowCode) {
    const ownFlows = await adapters.flows(current)
    const flow = ownFlows.find(item => item.flowCode === flowCode)
    if (!flow || flow.readOnly || flowCode === current.scope.flowCode) throw new Error('只能修复当前应用拥有的可编辑子流程')
    const bundle = await adapters.bundle(current, clone(current.dsl),{inspectionFlowCode:flowCode})
    if (!bundle.subflows.some(item => item.flowCode === flowCode && !item.readOnly)) throw new Error('目标不在主流程实际调用范围内')
    const scope = { ...current.scope, flowCode }
    const rows = nestDebugSteps(await adapters.steps(current,flow))
    const dsl = buildDebugDsl(scope.appCode, flowCode, { ...current.dsl, ...flow }, rows,undefined,{draft:true})
    let target = [...sessions.values()].find(item => digest(item.scope) === digest(scope))
    if (target) {
      if (target.serverChanged || digest(target.savedBaseline) !== digest(dsl)) throw new Error('子流程服务器基线已变化，请重新打开后合并')
      if (harness.active.has(target.id)) throw new Error('子流程正在处理其他轮次')
      return target
    }
    target = store.create(scope, dsl)
    Object.assign(target, { appName: current.appName, editorRows: rows, savedBaseline: clone(dsl), taskCode: current.taskCode, readOnly: false,
      inspectionDiagnostics:bundle.inspectionDiagnostics })
    if (current.takeoverTaskCode) target.takeoverTaskCode = current.takeoverTaskCode
    if (current.monitorAccount) target.monitorAccount = clone(current.monitorAccount)
    sessions.set(target.id, target); store.save(target)
    return target
  },
  async validateSubflow(current, proposal) {
    const target = await adapters.subflow(current, proposal.targetFlowCode)
    if (target.id !== proposal.targetSessionId || target.revision !== proposal.targetBaseRevision || digest(target.dsl) !== proposal.targetBaseline) throw new Error('子流程候选已过期，请重新读取')
    return target
  },
  archiveExecution: (current, run, result, dsl) => executionEvidence.record(current.scope, run, result, dsl),
  execute: (current, body, signal) => { checkpoint(signal); return robot(current, { path: '/api/robot/debug/runs', method: 'POST', body }) },
  continue: (current, previous, dsl, signal) => { checkpoint(signal); return robot(current, { path: '/api/robot/debug/runs/' + encodeURIComponent(previous.result.executionCode) + '/continue', method: 'POST',
    body: { stepCode: previous.result.failedStepCode, dsl, ctx: true, dom: true, screenshot: true } }) },
  async query(content, selector, fields) {
    if (!mainWindow || mainWindow.isDestroyed()) return null
    // DOMParser creates an inert document: no navigation, scripts or image requests.
    return mainWindow.webContents.executeJavaScript(`(() => {
      const fields = ${JSON.stringify(fields || null)};
      return Array.from(new DOMParser().parseFromString(${JSON.stringify(content)}, 'text/html').querySelectorAll(${JSON.stringify(selector)})).map(node => {
        if (!fields) return node.textContent;
        return Object.fromEntries(Object.entries(fields).map(([key, selector]) => {
          const cells = node.querySelectorAll(selector);
          return [key, cells.length === 1 ? cells[0].textContent : null];
        }));
      });
    })()`)
  },
  async htmlEvidence(content,options) {
    if(!mainWindow||mainWindow.isDestroyed())throw new Error('本地页面解析器不可用，请重新打开工作台')
    return mainWindow.webContents.executeJavaScript('('+inspectHtmlDocument.toString()+')('+JSON.stringify(content)+','+JSON.stringify(options)+')')
  },
  async navigation(result, request) {
    const snapshots = result.DOMs?.length ? result.DOMs : result.snapshots || []
    const found = []
    for (let snapshotIndex = 0; snapshotIndex < snapshots.length; snapshotIndex++) {
      const snapshot = snapshots[snapshotIndex]
      const pages = snapshot.pages || snapshot.doms || [snapshot.dom]
      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const page = pages[pageIndex]
        if (!page || page.status !== 'AVAILABLE' || !page.content) continue
        const candidates = await mainWindow.webContents.executeJavaScript(`(() => {
          const doc = new DOMParser().parseFromString(${JSON.stringify(page.content)}, 'text/html');
          const terms = ${JSON.stringify(request)}.split(/\\s+/).filter(Boolean);
          return Array.from(doc.querySelectorAll('a,button,[role="menuitem"],[role="button"],input[type="submit"]')).map(node => {
            const text = (node.textContent || node.getAttribute('aria-label') || node.getAttribute('value') || '').trim().slice(0,200);
            const parts = []; let item = node;
            while (item && item.nodeType === 1) {
              if(item.id) { parts.unshift('#'+CSS.escape(item.id)); break; }
              const tag = item.tagName.toLowerCase(); const same = Array.from(item.parentNode?.children || []).filter(peer => peer.tagName === item.tagName);
              parts.unshift(tag+':nth-of-type('+(same.indexOf(item)+1)+')'); item=item.parentElement;
            }
            const selector = parts.join(' > ');
            return { text, selector, unique: doc.querySelectorAll(selector).length === 1, href: node.getAttribute('href') };
          }).filter(item => item.text && terms.some(term => item.text.includes(term))).slice(0,30);
        })()`)
        found.push(...candidates.map(item => ({ ...item, snapshotIndex, pageIndex, url: page.url, framePath: page.framePath || '' })))
        if (found.length >= 60) return found.slice(0, 60)
      }
    }
    return found
  }
}

function trusted(event) {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || !windows.has(owner) || event.senderFrame !== event.sender.mainFrame) throw new Error('IPC 来源无效')
  const actual = new URL(event.senderFrame.url)
  if (actual.protocol !== 'file:' || ![owner.localPage].includes(actual.pathname)) throw new Error('仅允许本地页面操作')
  return owner
}
function handle(name, callback) {
  ipcMain.handle(name, (event, ...args) => {
    const owner = trusted(event)
    if (owner.restoringAccount && ['agent:start', 'workspace:run', 'workspace:open'].includes(name)) {
      throw new Error('正在恢复接管账户，请稍候')
    }
    return callback(...args, event)
  })
}
function openPage(name = 'index.html', options = {}) {
  const mainShell=name==='index.html'&&!options.designApp
  const win = new BrowserWindow({ width: 1500, height: 940, minWidth: 1040, minHeight: 700, title: options.title || 'rpa-agent', backgroundColor:currentAppearance().resolvedTheme==='dark'?'#1c1c1e':'#f5f5f7',
    icon:path.join(__dirname,'assets/app.png'),
    ...(mainShell?{titleBarStyle:'hidden',titleBarOverlay:{color:currentAppearance().resolvedTheme==='dark'?'#242426':'#ececef',symbolColor:currentAppearance().resolvedTheme==='dark'?'#f5f5f7':'#1d1d1f',height:36}}:{}),
    ...(options.designApp ? {modal:false,show:false} : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: false, webSecurity: true } })
  windows.add(win)
  win.isMainShell=mainShell
  if(mainShell){
    win.setMenu(null)
    win.webContents.on('before-input-event',(event,input)=>{
      if(input.type!=='keyDown')return
      const key=String(input.key).toLowerCase(),command=input.control||input.meta
      if(command&&[',','1','2'].includes(key)){event.preventDefault();win.webContents.send(key===','?'app:settings':'app:view',key==='1'?'home':'taskMonitor')}
      else if(command&&!input.alt&&!input.shift&&key==='o'){event.preventDefault();win.webContents.send('app:open-application')}
      else if(command&&key==='r'){event.preventDefault();win.webContents.reload()}
      else if(command&&input.shift&&key==='i'){event.preventDefault();win.webContents.toggleDevTools()}
      else if(key==='f11'){event.preventDefault();win.setFullScreen(!win.isFullScreen())}
    })
  }
  win.designApp=options.designApp||null
  win.designApplication=options.application||null
  win.designTaskName=options.taskName||''
  win.designServiceItem=options.serviceItem
  win.designInitialFlowCode=options.initialFlowCode
  win.designAccountTakeover=options.accountTakeover||null
  win.designMonitorAccount=options.monitorAccount||null
  win.designExecutor=options.executor||'';win.designTakeover=options.takeover||null
  win.localPage = new URL(pathToFileURL(path.join(root, name)).href).pathname
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.on('will-attach-webview', event => event.preventDefault())
  const ownerId=win.webContents.id
  win.on('closed', () => { windows.delete(win);for(const [id,owner] of workspaceOwners)if(owner===ownerId)workspaceOwners.delete(id) })
  if(options.designApp){
    win.setMenu(null)
    let closeAllowed=false,checkingClose=false
    win.on('close',event=>{
      if(closeAllowed)return
      event.preventDefault();if(checkingClose)return;checkingClose=true
      ;(async()=>{
        if([...productionRuns].some(id=>workspaceOwners.get(id)===ownerId)){await dialog.showMessageBox(win,{type:'info',message:'执行器正在运行流程，请等待本次运行结束。'});return}
        if([...sessions.values()].some(current=>workspaceOwners.get(current.id)===ownerId&&harness.active.has(current.id))){
          await dialog.showMessageBox(win,{type:'info',message:'Agent 仍在运行，请先停止或等待当前任务结束。'});return
        }
        const allowed=await win.webContents.executeJavaScript('typeof confirmNavigation!=="function"||confirmNavigation()').catch(()=>true)
        if(allowed&&!win.isDestroyed()){
          if (options.beforeClose && [...sessions.values()].some(current => workspaceOwners.get(current.id) === ownerId &&
              (productionRuns.has(current.id) || harness.active.has(current.id)))) {
            await dialog.showMessageBox(win, { type: 'info', message: '请等待流程运行结束后关闭窗口。' })
            return
          }
          win.restoringAccount = !!options.beforeClose
          await options.beforeClose?.()
          closeAllowed=true
          win.close()
        }
      })().catch(error => {
        if (!win.isDestroyed()) return dialog.showMessageBox(win, {
          type: 'error', message: '恢复申报户状态失败', detail: error.message + '\n请再次关闭窗口以重试。'
        })
      }).finally(()=>{win.restoringAccount=false;checkingClose=false})
    })
  }
  win.loadFile(path.join(root, name),options.designApp?{query:{designApp:options.designApp}}:undefined)
  return win
}
function registerIpc() {
  const accountLoadRequests=new WeakMap()
  async function loadWorkspaceAccounts(current) {
    const request={}
    accountLoadRequests.set(current,request)
    try {
      const tasks=await adapters.tasks(current)
      const requested=current.taskCode || (current.accountSelectionSet?'':current.takeoverTaskCode||current.monitorAccount?.taskCode)
      const taskCode=tasks.some(task=>task.taskCode===requested)?requested:''
      if(accountLoadRequests.get(current)===request&&(current.taskCode||'')!==taskCode){
        current.taskCode=taskCode
        store.save(current)
      }
      return {tasks,taskCode}
    } catch(error) { return {error:error.message} }
  }
  const savingWorkspaces = new Set()
  handle('design:ready',event=>{
    const win=BrowserWindow.fromWebContents(event.sender)
    if(!win?.designApp)throw new Error('仅流程设计窗口可通知加载完成')
    win.show();return true
  })
  handle('design:connect',async (baseUrl,event)=>{
    const identity=ensureIdentity(activeUserId()),win=BrowserWindow.fromWebContents(event.sender)
    if(!win?.designApp)throw new Error('仅流程设计窗口可选择执行器')
    const selected=executor.normalizeBaseUrl(baseUrl)
    connection({scope:{executor:selected}})
    if(win.designExecutor&&win.designExecutor!==selected)throw new Error('请新开设计窗口连接其他执行器')
    const status=await control.disconnectedStatus(selected)
    if(!userAuth.isCurrent(identity)||win.isDestroyed())throw new Error('登录用户或窗口已变化')
    if(win.designExecutor&&win.designExecutor!==selected)throw new Error('请新开设计窗口连接其他执行器')
    if(![0,1].includes(status.status))throw new Error('无法连接该执行器：'+status.text)
    win.designExecutor=selected
    const title=(win.designApplication.appName||win.designApp)+'（连接至 '+selected.replace(/^https?:\/\//,'')+'）'
    win.setTitle(title);return {executor:selected,title,status:status.text}
  })
  handle('auth:status',event=>{
    if(userAuth.status())try{userAuth.requireIdentity()}catch(_){invalidateUserSession()}
    return {user:userAuth.status(),baseUrl:settings.userLogin?.baseUrl||DEFAULT_USER_API,username:settings.userLogin?.username||'',
      rememberPassword:!!settings.userLogin?.rememberPassword,password:!userAuth.status()&&mainWindow&&!mainWindow.isDestroyed()&&event.sender.id===mainWindow.webContents.id&&settings.userLogin?.rememberPassword?settings.userLogin.password||'':''}
  })
  handle('auth:forget-password',()=>{
    const previous=settings.userLogin
    if(!previous)return true
    settings.userLogin={baseUrl:previous.baseUrl,username:previous.username}
    try{saveSettings()}catch(error){settings.userLogin=previous;throw error}
    return true
  })
  handle('auth:login',async input=>{
    if(userAuth.pending)throw new Error('正在登录，请稍候')
    assertIdle();invalidateUserSession()
    const user=await userAuth.login(input)
    const previous=settings.userLogin
    settings.userLogin={baseUrl:user.baseUrl,username:user.username,...(input.rememberPassword===true?{rememberPassword:true,password:String(input.password)}:{})}
    try{saveSettings()}catch(error){settings.userLogin=previous;invalidateUserSession();throw error}
    broadcastUser();return user
  })
  handle('auth:logout',()=>{assertIdle();invalidateUserSession();return true})
  handle('app:bootstrap', event => ({ name: 'rpa-agent', version: app.getVersion(), designTakeover:BrowserWindow.fromWebContents(event.sender)?.designTakeover, designExecutor:BrowserWindow.fromWebContents(event.sender)?.designExecutor, designApplication:BrowserWindow.fromWebContents(event.sender)?.designApplication, designTaskName:BrowserWindow.fromWebContents(event.sender)?.designTaskName, designServiceItem:BrowserWindow.fromWebContents(event.sender)?.designServiceItem, designInitialFlowCode:BrowserWindow.fromWebContents(event.sender)?.designInitialFlowCode, platforms: [], platformId: activeUserId(), executorPlatformId:'',user:userAuth.status(),
    connected: !!userAuth.status(),
    activeSessions: [...sessions.values()].filter(item => item.scope.platformId === activeUserId() && (harness.active.has(item.id)||productionRuns.has(item.id)||BrowserWindow.fromWebContents(event.sender)?.designTakeover?.sessionId===item.id) &&
      (!workspaceOwners.has(item.id)||workspaceOwners.get(item.id)===event.sender.id) &&
      (!BrowserWindow.fromWebContents(event.sender)?.designApp||item.scope.appCode===BrowserWindow.fromWebContents(event.sender).designApp)).map(item => ({ id: item.id, scope: item.scope })),
    executors: !userAuth.status()?[]:settings.remoteEnabled ? settings.connections.map(item => item.baseUrl) : [executor.DEFAULT_EXECUTOR_BASE_URL],
    executorNames: userAuth.status()&&settings.remoteEnabled?Object.fromEntries(settings.connections.map(item=>[item.baseUrl,item.serviceName||''])):{} }))
  handle('app:menu',async (input,event)=>{
    const win=BrowserWindow.fromWebContents(event.sender)
    if(!win.isMainShell)throw Error('此窗口不显示主菜单')
    const names=['file','edit','view','help'],index=names.indexOf(input?.menu),menu=Menu.getApplicationMenu()?.items[index]?.submenu
    if(index<0||!menu)throw Error('菜单不存在')
    const [width,height]=win.getContentSize(),x=Math.max(0,Math.min(width-1,Math.round(Number(input.x)||0))),y=Math.max(0,Math.min(height-1,Math.round(Number(input.y)||0)))
    return new Promise(resolve=>menu.popup({window:win,x,y,callback:()=>resolve(true)}))
  })
  handle('app:panel', name => {
    ensureIdentity(activeUserId())
    const pages = { monitor: 'monitor.html' }
    if (!pages[name]) throw new Error('未知页面')
    openPage(pages[name]); return true
  })
  handle('clipboard:write', value => { clipboard.writeText(String(value)); return true })
  handle('clipboard:read', () => clipboard.readText())
  handle('design:open', async input => {
    ensureIdentity(activeUserId())
    if(input?.platformId!==activeUserId())throw new Error('登录用户已变化，请刷新应用列表')
    const service=createBusinessService(request=>userRequest(request))
    const application=await service.invoke('application',{appCode:input.appCode})
    openPage('index.html',{designApp:application.appCode,application,title:application.appName||application.appCode})
    return true
  })
  handle('app:confirm-navigation', async event => {
    const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender)||mainWindow, { type: 'question', title: '未保存的步骤',
      message: '当前步骤有未保存内容。已更新的草稿会保留在会话中；尚未更新的输入会丢失。',
      buttons: ['留在当前流程', '继续切换'], defaultId: 0, cancelId: 0 })
    return result.response === 1
  })
  handle('business:action', async (name, input, event) => {
    input ||= {}
    const identity = ensureIdentity(activeUserId())
    if (input.platformId !== activeUserId()) throw new Error('登录用户已变化，请刷新后重试')
    const service = createBusinessService(request => userRequest(request,identity))
    if (name === 'releaseToProduction') {
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (owner?.designApp && owner.designApp !== input.appCode) throw new Error('只能同步当前窗口的应用')
      if (savingWorkspaces.size) throw new Error('正在保存步骤，请稍后同步生产')
      if (!input.syncOnly && [...sessions.values()].some(current => workspaceOwners.has(current.id) && current.scope.platformId === identity.id && current.scope.appCode === input.appCode &&
        !current.readOnly && digest(current.dsl) !== digest(current.savedBaseline))) throw new Error('该应用有未保存的步骤草稿，请先保存再同步生产')
    }
    const write = service.isWrite(name)
    if (write) { assertIdle(); businessWriting = true }
    try {
      const result = await service.invoke(name, input)
      if (name === 'releaseToProduction' && userAuth.isCurrent(identity)) {
        for (const win of windows) if (!win.isDestroyed()) win.webContents.send('application:released', input.appCode)
      }
      if (name === 'deleteFlow' || name === 'saveFlow' && input.mode === 'edit' || name === 'saveApplication' && input.appCode) {
        for (const [id, current] of sessions) if (current.scope.platformId === identity.id && current.scope.appCode === input.appCode &&
          (name === 'saveApplication' || current.scope.flowCode === input.flowCode)) sessions.delete(id)
        await closeMcp()
      }
      return result
    } finally { if (write) businessWriting = false }
  })
  handle('business:export-applications', async input => {
    if (input.platformId !== activeUserId()) throw new Error('登录用户已变化，请重新导出')
    const identity=ensureIdentity(activeUserId())
    const content = require('./services/table-export').applicationCsv(input.rows)
    const selected = await dialog.showSaveDialog({ defaultPath: 'RPA应用列表-当前页.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] })
    if (selected.canceled) return { canceled: true }
    if(!userAuth.isCurrent(identity))throw new Error('登录用户已变化，请重新导出')
    fs.writeFileSync(selected.filePath, content, 'utf8'); return { canceled: false, count: input.rows.length }
  })
  handle('monitor:open-flow', async input => {
    if (!input || !String(input.appName || '').trim() || !String(input.taskName || '').trim()) throw new Error('缺少应用或任务名称')
    const identity=ensureIdentity(activeUserId()),service=createBusinessService(request=>userRequest(request,identity))
    const row=input.rowId&&monitorSnapshot?.identity===identity?monitorSnapshot.rows.get(String(input.rowId)):null
    if(input.rowId&&(!row||row.appName!==input.appName))throw new Error('任务已变化，请刷新任务监控')
    const monitorAccount=row?.taskCode?{taskCode:row.taskCode,taskName:row.accountNumber||row.taskCode,accountNumber:row.accountNumber}:null
    let application
    if(input.appCode){
      try{application=await service.invoke('application',{appCode:String(input.appCode)})}
      catch(error){if(error.message!=='应用不存在或无权访问')throw error}
    }
    if(!application){
      const matches=[]
      for(let page=1;;page++){
        if(page>100)throw new Error('应用匹配结果过多，请从应用列表手工查找')
        const result=await service.invoke('applications',{page,size:100,keyword:String(input.appName).trim()})
        matches.push(...result.rows.filter(row=>row.appName===String(input.appName).trim()))
        if(matches.length>1)throw new Error('存在同名应用，无法唯一定位，请从应用列表手工选择')
        if(!result.hasNext)break
      }
      if(matches.length!==1)throw new Error('当前登录用户未找到对应应用，请检查应用名称或访问权限')
      application=matches[0]
    }
    if(!userAuth.isCurrent(identity))throw new Error('登录用户已变化，请重新打开任务')
    openPage('index.html',{designApp:application.appCode,application,taskName:String(input.taskName).trim(),monitorAccount,title:application.appName||application.appCode})
    return true
  })
  handle('platforms:load', () => {ensureIdentity(activeUserId());return platforms.list()})
  registerTakeoverHandlers({handle,ensureIdentity,activeUserId,userAuth,getSettings:()=>settings,saveSettings,getSnapshot:()=>monitorSnapshot,userRequest,createBusinessService,takeoverContexts,takeovers,assertIdle,refreshUndeclaredData,adapters,harness,openPage,workspaceOwners,requireSession,BrowserWindow,
    broadcastTakeoverStats(stats) {
      for (const win of windows) if (!win.isDestroyed() && win.isMainShell) win.webContents.send('monitor:takeover-stats', stats)
    },
    broadcastAccountStatus(update) {
      for (const win of windows) if (!win.isDestroyed()) win.webContents.send('monitor:account-status', update)
    }})
  handle('platforms:save', async input => {
    ensureIdentity(activeUserId());assertIdle()
    const result = await platforms.save(input)
    
    return result
  })
  handle('platform:select', async id => {
    ensureIdentity(activeUserId());assertIdle()
    const identity = await platforms.authenticate(id)
    settings.platformId = id; saveSettings()
    return { name: identity.name, username: identity.username }
  })
  handle('platform:request', input => {
    if (input.path.startsWith('robot/flow/step/save') || input.path.startsWith('/robot/flow/step/save')) throw new Error('步骤保存请使用工作区保存入口')
    return userRequest(input)
  })
  handle('appearance:get', currentAppearance)
  handle('appearance:save', input => {
    const value=validateAppearance(input), previous=settings.appearance
    settings.appearance=value
    try{saveSettings()}catch(error){settings.appearance=previous;throw error}
    nativeTheme.themeSource=value.mode
    broadcastAppearance()
    return currentAppearance()
  })
  handle('settings:get', () => {ensureIdentity(activeUserId());return ({ ...settings, accountTakeoverTotals:undefined, modelApiKey: '', localDebugToken: '', hasModelApiKey: !!settings.modelApiKey, hasLocalDebugToken: !!settings.localDebugToken,
    userLogin:settings.userLogin?{baseUrl:settings.userLogin.baseUrl,username:settings.userLogin.username,rememberPassword:!!settings.userLogin.rememberPassword}:undefined,
    connections: settings.connections.map(item => ({ baseUrl: item.baseUrl, runtimeUrl: item.runtimeUrl, serviceName: item.serviceName||'', debugToken: '', hasDebugToken: !!item.debugToken })), monitor: undefined })})
  handle('settings:save', async input => {
    ensureIdentity(activeUserId())
    assertIdle(); await closeMcp()
    validateModelSettings(input)
    const connections = (input.connections || []).map(item => {
      const baseUrl = executor.normalizeBaseUrl(item.baseUrl)
      const runtimeUrl = item.runtimeUrl?.trim()
      return { baseUrl, serviceName:String(item.serviceName||'').trim().slice(0,80), ...(runtimeUrl?{runtimeUrl:executor.normalizeBaseUrl(runtimeUrl)}:{}),
        debugToken: String(item.debugToken || '').trim() || settings.connections.find(old=>old.baseUrl===baseUrl)?.debugToken || '' }
    })
    if (input.remoteEnabled && !connections.length) throw new Error('请添加远程执行器')
    if (new Set(connections.map(item => item.baseUrl)).size !== connections.length) throw new Error('执行器地址重复')
    Object.assign(settings, { modelBaseUrl: String(input.modelBaseUrl || '').trim(), modelName: String(input.modelName || '').trim(),
      additionalModelNames: configuredModelNames({additionalModelNames:input.additionalModelNames}),
      modelApiKey: input.clearModelApiKey ? '' : input.modelApiKey || settings.modelApiKey,
      localDebugToken: String(input.localDebugToken || '').trim() || settings.localDebugToken, remoteEnabled: input.remoteEnabled === true, connections })
    saveSettings(); sessions.clear()
    for(const win of windows)if(!win.isDestroyed())win.webContents.send('models:changed',configuredModelNames(settings))
    return true
  })
  handle('executor:status', baseUrl => {ensureIdentity(activeUserId());return control.disconnectedStatus(executor.normalizeBaseUrl(baseUrl))})
  handle('executor:service-name',async baseUrl=>{
    const identity=ensureIdentity(activeUserId())
    const selected=connection({scope:{executor:executor.normalizeBaseUrl(baseUrl)}})
    if(!settings.remoteEnabled || (selected.debugToken?.length||0)<16)return selected.serviceName||''
    let status
    try { status=await require('./services/runtime-control').request(selected,'/api/agent/status') }
    catch (_) { status=null }
    if(!userAuth.isCurrent(identity))return ''
    return (typeof status?.platformName==='string'?status.platformName.trim().slice(0,80):'')||selected.serviceName||''
  })
  handle('executor:control', async (action, platformId) => {
    ensureIdentity(activeUserId())
    assertIdle()
    if (settings.remoteEnabled) throw new Error('远程执行器请在远端管理')
    if (action === 'stop') { await control.stop(); return { text: '已停止' } }
    if (!['start', 'switch'].includes(action)) throw new Error('未知执行器操作')
    const config = 'D:\\seebon\\rpa\\application.properties'
    const identity=ensureIdentity(activeUserId())
    await platforms.exclusive(() => activatePlatform({ stop: control.stop, authenticate: () => {const active=ensureIdentity(identity.id);if(active!==identity)throw new Error('登录用户已变化，请重试');return active},
      writeConfig: identity => {
        const content = fs.readFileSync(config, 'utf8')
        fs.writeFileSync(config + '.tmp', updateProperties(content, { 'rpa.server': identity.url, 'rpa.token': identity.token,
          'rpa.ide-platform-id': identity.id, 'rpa.ide-platform-username': identity.username, custId: identity.custId || '', custName: identity.custName || '' }))
        fs.renameSync(config + '.tmp', config)
      }, start: () => control.start(settings.localDebugToken), onStarted() {} }, identity.id))
    return { text: '已启动' }
  })
  handle('executor:logs', async () => {
    ensureIdentity(activeUserId())
    const directory = 'D:\\seebon\\rpa\\logs'
    const files = fs.readdirSync(directory).filter(file => file.endsWith('.log')).map(file => ({ file: path.join(directory, file), time: fs.statSync(path.join(directory, file)).mtimeMs })).sort((a, b) => b.time - a.time)
    if (!files.length) throw new Error('没有执行日志')
    const error = await shell.openPath(files[0].file)
    if (error) throw new Error(error)
    return true
  })
  handle('workspace:open', async (input,event) => {
    if (businessWriting) throw new Error('正在保存业务配置，请稍后打开流程')
    const identity = ensureIdentity(activeUserId())
    const baseUrl = executor.normalizeBaseUrl(input.executor)
    const owner=BrowserWindow.fromWebContents(event.sender)
    if(owner.designApp&&(!owner.designExecutor||owner.designExecutor!==baseUrl||owner.designApp!==String(input.appCode)))throw new Error('请使用本窗口已连接的执行器和应用')
    const scope = { platformId: identity.id, platformUrl: identity.url, username: identity.username, executor: baseUrl,
      appCode: String(input.appCode), flowCode: String(input.flowCode) }
    const source=input.sourceSessionId?requireSession(input.sourceSessionId):null
    let calledName
    if(source){
      if(workspaceOwners.get(source.id)!==event.sender.id)throw new Error('请在原流程窗口打开子流程')
      if(source.scope.appCode!==scope.appCode||source.scope.executor!==scope.executor)throw new Error('子流程必须属于当前应用和执行器')
      let step
      const visit=steps=>{for(const item of steps){if(item.stepCode===input.stepCode)step=item;visit(item.children||item.body||[])}}
      visit(source.dsl.steps)
      if(!step||!['subFlow','finalFlow'].includes(step.actionCode))throw new Error('请选择调用流程步骤')
      calledName=step.actionArgs?.flowName
      if(typeof calledName!=='string'||!calledName.trim()||calledName.includes('${'))throw new Error('调用流程名称为空或使用动态变量，无法确定要打开的子流程')
    }
    connection({ scope })
    const stub = { scope }
    const [flows,appPage,commandData] = await Promise.all([
      adapters.flows(stub),
      api(stub, { path: 'robot/app/page', body: { page: 1, start: 0, size: 100, query: [{ property: 'appCode', value: scope.appCode }] } }),
      adapters.commands(stub)
    ])
    ensureIdentity(scope.platformId)
    let flow
    if(source){
      let matches=flows.filter(item=>item.flowName===calledName)
      if(matches.length!==1)throw new Error(matches.length?'存在同名子流程，请先整理流程名称':'未找到调用的子流程：'+calledName)
      flow=matches[0];scope.flowCode=flow.flowCode
      const existing=[...sessions.values()].find(item=>(item.id===source.id||input.openSessionIds?.includes(item.id))&&workspaceOwners.get(item.id)===event.sender.id&&digest(item.scope)===digest(scope))
      if(existing)return {session:sessionSnapshot(existing),commands:commandData.items,tasks:[],tasksPending:true}
    }else flow = flows.find(item => item.flowCode === scope.flowCode)
    if (!flow) throw new Error('流程不属于当前应用')
    const rows = nestDebugSteps(await adapters.steps(stub,flow))
    // Application metadata supplies appArgs required by executor context initialisation.
    const apps = Array.isArray(appPage) ? appPage : appPage?.rows || appPage?.records || appPage?.list || []
    const application = apps.find(item => item.appCode === scope.appCode)
    const windowApplication = owner.designApplication?.appCode === scope.appCode ? owner.designApplication : null
    const appName = [application?.appName, windowApplication?.appName, source?.appName, flow.appName]
      .map(name => typeof name === 'string' ? name.trim() : '')
      .find(name => name && name !== scope.appCode)
    const metadata = { ...windowApplication, ...application, ...flow, appName,
      appArgs: application?.appArgs ?? windowApplication?.appArgs ?? flow.appArgs }
    const dsl = buildDebugDsl(scope.appCode,scope.flowCode,metadata,rows,undefined,{draft:true})
    const current = store.create(scope, dsl)
    current.appName = appName
    current.readOnly = flow.readOnly===true
    if(source)current.taskCode=source.taskCode||''
    if (owner.designAccountTakeover) {
      current.takeoverTaskCode = owner.designAccountTakeover.taskCode
    }
    const monitorAccount=owner.designMonitorAccount||source?.monitorAccount||
      (owner.designTakeover?.taskCode?{taskCode:owner.designTakeover.taskCode}:null)
    if(monitorAccount){
      current.monitorAccount=clone(monitorAccount)
    }
    current.editorRows = rows
    current.savedBaseline = clone(dsl)
    sessions.set(current.id, current)
    workspaceOwners.set(current.id,event.sender.id)
    store.save(current)
    const accounts=input.deferTasks?{tasks:[]}:await loadWorkspaceAccounts(current)
    return { session: sessionSnapshot(current), tasks: accounts.tasks||{error:accounts.error}, tasksPending:!!input.deferTasks, commands: commandData.items }
  })
  handle('workspace:tasks',async (id,event)=>{
    const current=requireSession(id)
    if(workspaceOwners.get(id)!==event.sender.id)throw new Error('请在对应流程窗口读取申报户')
    return loadWorkspaceAccounts(current)
  })
  handle('workspace:execution-evidence', (id, evidenceId, event) => {
    const current = requireSession(id)
    if (workspaceOwners.get(id) !== event.sender.id) throw new Error('请在对应流程窗口查看执行证据')
    const runs = current.runs.filter(run => run.evidenceState !== 'deleted')
    const local = runs.find(run => run.artifactId === evidenceId)
    try {
      if (evidenceId) return executionEvidence.get(current.scope, evidenceId)
      const archived = executionEvidence.list(current.scope)
      const unsaved = runs.filter(run => run.evidenceArchiveError && !archived.some(entry => entry.id === run.artifactId))
      return [...unsaved.map(run => ({ ...executionEvidence.metadata(run, current.scope), warning: run.evidenceArchiveError })), ...archived].slice(0, 5)
    } catch (error) {
      if (evidenceId && local) return { result: harness.readArtifact(current, evidenceId), warning: error.message }
      if (evidenceId) throw error
      return runs.map(run => ({ ...executionEvidence.metadata(run, current.scope), warning: error.message }))
    }
  })
  handle('workspace:delete-execution-evidence', async (id, evidenceId, event) => {
    const current = requireSession(id)
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (workspaceOwners.get(id) !== event.sender.id) throw new Error('请在对应流程窗口删除执行证据')
    const entry = executionEvidence.list(current.scope).find(item => item.id === evidenceId) ||
      current.runs.find(run => run.artifactId === evidenceId && run.evidenceState !== 'deleted' && run.evidenceArchiveError)
    if (!entry) throw new Error('未找到本次执行证据')
    const result = await dialog.showMessageBox(owner, {
      type: 'warning', title: '删除执行证据', message: '删除所选执行的本地证据？',
      detail: '本次保存的 DSL、执行步骤、CTX、DOM 和截图将被删除。',
      buttons: ['取消', '删除证据'], defaultId: 0, cancelId: 0
    })
    if (result.response !== 1) return false
    if (requireSession(id) !== current || workspaceOwners.get(id) !== event.sender.id) throw new Error('流程已切换，请重新打开证据')
    executionEvidence.remove(current.scope, evidenceId, sessions)
    return true
  })
  handle('workspace:dsl',async (id,event)=>{
    const current=requireSession(id),signature=digest(adapters.executionDependencies(current))
    const draft=clone(current.dsl)
    const windowApplication=BrowserWindow.fromWebContents(event.sender)?.designApplication
    if((!draft.appName||draft.appName===draft.appCode)&&windowApplication?.appCode===draft.appCode&&windowApplication.appName){
      draft.appName=windowApplication.appName
    }
    const result=await adapters.bundle(current,draft,{inspect:true})
    requireSession(id)
    if(signature!==digest(adapters.executionDependencies(current)))throw new Error('流程配置在加载期间已变化，请重新查看 DSL')
    return {dsl:require('./services/dsl-document').buildDslDocument(result),diagnostics:result.inspectionDiagnostics||[]}
  })
  handle('workspace:attach', async (id,event) => {
    const current = requireSession(id)
    if(workspaceOwners.has(id)&&workspaceOwners.get(id)!==event.sender.id)throw new Error('该流程会话正在另一个窗口中打开，请在原窗口继续操作')
    workspaceOwners.set(id,event.sender.id)
    const commands=(await adapters.commands(current)).items
    const accounts=await loadWorkspaceAccounts(current)
    return { session: sessionSnapshot(current), commands, tasks: accounts.tasks||{error:accounts.error} }
  })
  handle('workspace:close',async id=>{
    const current=requireSession(id)
    if(productionRuns.has(id))throw new Error('请等待执行器本次运行结束，再关闭步骤页')
    if(harness.active.has(id))throw new Error('请先停止或等待当前轮次结束，再关闭步骤页')
    if(mcpSessionId===id)await closeMcp()
    if(harness.active.has(id))throw new Error('当前轮次尚未结束，请稍后关闭')
    sessions.delete(id);workspaceOwners.delete(id)
    return true
  })
  handle('workspace:generate-flow', async input => {
    assertIdle()
    if (!settings.modelBaseUrl || !settings.modelName) throw new Error('请先配置模型 API；当前未创建流程')
    const identity = ensureIdentity(activeUserId())
    if (!input.appCode || !String(input.flowName || '').trim() || !input.serviceItem || !input.declareSystem || !input.runSupport) throw new Error('请填写应用、流程名称、服务项目、申报系统和运行载体')
    const read = () => userRequest({ path: 'robot/flow/list', body: { appCode: input.appCode } })
    businessWriting = true
    try {
      const before = await read()
      if (before.some(row => String(row.flowName || '').trim() === input.flowName.trim())) throw new Error('流程名称不能重复，请刷新列表')
      await userRequest({ path: 'robot/flow/add', params: { ...input, flowName: input.flowName.trim(), flowType: 1 } })
      const added = (await read()).filter(item => !before.some(old => old.flowCode === item.flowCode) && item.flowName === input.flowName.trim())
      if (added.length !== 1) throw new Error('流程已创建但无法唯一确定，请刷新列表并打开；请勿重复创建')
      return { flowCode: added[0].flowCode, request: '根据服务项目创建流程步骤。仅生成候选，不运行、不保存。\n' + JSON.stringify(input) }
    } finally { businessWriting = false }
  })
  handle('workspace:recording-preview', async (id, input) => {
    const current = requireSession(id)
    if (harness.active.has(id) || current.readOnly) throw new Error('当前流程不可编辑')
    const rows = await api(current, { path: 'policy/saasRobotFlowStep/findStepListByDeskId', method: 'GET', params: { id: input.recordingId } })
    if (!Array.isArray(rows) || !rows.length) throw new Error('录制记录没有步骤')
    const recording = buildDebugDsl(current.scope.appCode, current.scope.flowCode, current.dsl, nestDebugSteps(rows))
    return require('./services/step-edit').importRecordedSteps(current.dsl, recording, input)
  })
  handle('workspace:paste-preview', (id, input) => {
    const current = requireSession(id)
    if (harness.active.has(id) || current.readOnly) throw new Error('当前流程不可编辑')
    return require('./services/step-edit').importRecordedSteps(current.dsl, { steps: [input.step] }, input)
  })
  handle('workspace:argument-image', async id => {
    requireSession(id)
    const selected = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '参数图片', extensions: ['png', 'jpg', 'jpeg'] }] })
    if (selected.canceled) return null
    if (fs.statSync(selected.filePaths[0]).size > 100 * 1024) throw new Error('参数图片不能超过100KiB')
    const bytes = fs.readFileSync(selected.filePaths[0])
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const jpeg = bytes[0] === 255 && bytes[1] === 216
    if (!png && !jpeg) throw new Error('不是有效的 PNG / JPEG 图片')
    return 'data:image/' + (png ? 'png' : 'jpeg') + ';base64,' + bytes.toString('base64')
  })
  handle('workspace:update', async (id, input) => {
    const current = requireSession(id)
    if(productionRuns.has(id))throw new Error('运行期间不能修改流程或账户')
    if (harness.active.has(id)) throw new Error('运行期间不能修改流程或账户')
    if (current.readOnly && Object.hasOwn(input,'dsl')) throw new Error('只读流程只读，不能直接修改步骤；可选择账户运行调试并生成建议补丁')
    if (input.dsl) {
      const codes = []; const visit = steps => steps.forEach(step => { codes.push(step.actionCode); visit(step.body || step.children || []) }); visit(input.dsl.steps || [])
      const rows = validateCandidate(current, input.dsl, await adapters.commands(current, codes), { draft: true })
      current.dsl = buildDebugDsl(current.scope.appCode, current.scope.flowCode, input.dsl, rows, undefined, { draft: true })
      current.revision++; current.proposal = null
    }
    if (input.taskCode !== undefined) {
      if (current.takeoverTaskCode && input.taskCode && input.taskCode !== current.takeoverTaskCode) throw new Error('接管窗口仅允许使用被接管的申报户')
      if (input.taskCode!==''&&!(await adapters.tasks(current)).some(item => item.taskCode === input.taskCode)) throw new Error('账户不属于当前应用')
      current.taskCode = input.taskCode
      current.accountSelectionSet = true
    }
    harness.event(current, 'workspace/updated', { revision: current.revision }); return current
  })
  handle('workspace:candidate', async (id, action, review, event) => {
    if(!event){event=review;review=undefined}
    const current = requireSession(id)
    if(workspaceOwners.get(id)!==event.sender.id)throw new Error('请在补丁所属的流程窗口操作')
    if(productionRuns.has(id))throw new Error('请等待执行器本次运行结束')
    if (harness.active.has(id)) throw new Error('请等待本轮结束')
    const workflow=createPatchWorkflow({
      assertAvailable(target){
        if(businessWriting)throw new Error('正在保存业务配置，请稍后重试')
        requireSession(target.id)
        if(productionRuns.has(target.id)||harness.active.has(target.id))throw new Error('请等待目标流程运行结束')
        const owner=workspaceOwners.get(target.id)
        if(owner&&owner!==event.sender.id)throw new Error('目标流程正在其他窗口编辑，请在原窗口操作')
        if(target.serverChanged)throw new Error('服务器基线已变化，请重新打开流程后生成补丁')
      },
      targetFor:(source,proposal)=>adapters.validateSubflow(source,proposal),
      async validate(target,dsl){
        const codes=[];const visit=steps=>steps.forEach(step=>{codes.push(step.actionCode);visit(step.body||step.children||[])});visit(dsl.steps)
        validateCandidate(target,dsl,await adapters.commands(target,codes))
      }
    })
    if(action==='review')return workflow.review(current)
    if (action === 'apply') {
      const {target,changedStepCodes}=await workflow.apply(current,review?.reviewId)
      workspaceOwners.set(target.id,event.sender.id)
      harness.event(current,'candidate/apply',{revision:current.revision,targetFlowCode:target.scope.flowCode,changedStepCodes,message:'补丁已应用到本地草稿，尚未保存'})
      if(target!==current){
        harness.event(target,'workspace/updated',{revision:target.revision,changedStepCodes})
        await closeMcp()
      }
      return sessionSnapshot(target)
    } else if (action !== 'discard') throw new Error('未知候选操作')
    if(review?.reviewId&&digest(current.proposal)!==review.reviewId)throw new Error('补丁已变化，请重新操作')
    current.proposal = null
    harness.event(current, 'candidate/' + action, { revision: current.revision }); return current
  })
  handle('workspace:save', async id => {
    const current = requireSession(id)
    if (businessWriting || savingWorkspaces.has(id)) throw new Error('正在保存业务配置，请稍后重试')
    if(productionRuns.has(id))throw new Error('请等待执行器本次运行结束')
    if (harness.active.has(id)) throw new Error('请等待本轮结束')
    if (current.readOnly) throw new Error('只读流程只读')
    if (current.serverChanged) throw new Error('恢复的会话与服务器基线不同，请新建会话并手工合并后保存')
    savingWorkspaces.add(id)
    try {
      const raw = await adapters.steps(current,current.scope.flowCode)
      const baseline = raw.length ? buildDebugDsl(current.scope.appCode, current.scope.flowCode, current.savedBaseline, nestDebugSteps(raw),undefined,{draft:true}) : { ...current.savedBaseline, steps: [] }
      if (digest(baseline) !== digest(current.savedBaseline)) throw new Error('服务器步骤已被修改，请重新打开并合并变更')
      const codes = []; const visit = steps => steps.forEach(step => { codes.push(step.actionCode); visit(step.body || step.children || []) }); visit(current.dsl.steps)
      await api(current, { path: 'robot/flow/step/save', params: { flowCode: current.scope.flowCode }, body: toSaveRows(current, await adapters.commands(current, codes)) })
      for (const parent of current.editorRows || []) for (const row of [parent, ...(parent.list || [])]) delete row.sourceStepCode
      current.savedBaseline = clone(current.dsl); current.serverChanged = false
      harness.event(current, 'workspace/saved', { revision: current.revision, message: '配置已保存；保存不代表业务验证通过' }); return current
    } finally { savingWorkspaces.delete(id) }
  })
  const runSavedFlow=async id=>{
    const current=requireSession(id)
    if (businessWriting) throw new Error('正在保存业务配置，请稍后重试')
    if (takeovers.size) throw new Error('正在切换远程执行器调试模式，请稍候')
    if(current.serverChanged||digest(current.dsl)!==digest(current.savedBaseline))throw new Error('请先保存步骤配置，再运行服务器流程')
    if(!current.taskCode)throw new Error('请先选择申报账户')
    return harness.runOnly(current,async()=>{
    let release,submitted=false,responded=false
    try{
      const taskCode=current.taskCode,flowCode=current.scope.flowCode,baseUrl=current.scope.executor
      if(!(await adapters.tasks(current)).some(task=>task.taskCode===taskCode))throw new Error('账户不属于当前应用')
      connection(current)
      release=harness.leases.acquire(baseUrl,id)
      current.productionRun={state:'running',taskCode,flowCode,startedAt:new Date().toISOString()}
      current.executionUncertain={executor:baseUrl,source:'production',taskCode,flowCode,reason:'常规运行已提交，等待执行器结果'}
      harness.event(current,'production/started',{taskCode,flowCode})
      submitted=true
      const response=await executor.request(baseUrl,{path:'/api/robot/start/remoteTaskFlow/'+encodeURIComponent(taskCode)+'/'+encodeURIComponent(flowCode),method:'GET',timeout:30*60*1000})
      responded=true
      if(response?.code&&Number(response.code)!==200)throw new Error(response.message||response.msg||'执行器运行失败')
      const details=response&&Object.hasOwn(response,'data')?response.data:response
      current.executionUncertain=null
      current.productionRun={...current.productionRun,state:'completed',completedAt:new Date().toISOString(),artifactId:harness.artifact(current,details)}
      harness.event(current,'production/completed',{flowCode})
      return {flowCode,taskCode,details}
    }catch(error){
      if(submitted){
        if(responded)current.executionUncertain=null
        else{harness.leases.quarantine(current.scope.executor,id);harness.recoveries.set(id,current)}
        current.productionRun={...current.productionRun,state:responded?'failed':'unknown',error:error.message}
        harness.event(current,'production/failed',{error:error.message})
      }
      throw error
    }finally{release?.();if(submitted)harness.event(current,'production/settled')}
    })
  }
  handle('workspace:run',runSavedFlow)
  registerDevelopmentHandlers({handle,takeovers,productionRuns,getState:()=>({settings,businessWriting}),requireSession,runSavedFlow,attachHtml,
    attachFile:(current,input)=>attachFile(current,input,harness,nativeImage),harness,connection,control,sessionSnapshot})
  handle('mcp:control', async (id, enabled) => {
    const current = requireSession(id)
    await closeMcp()
    if (!enabled) return { enabled: false }
    const { createMcpBridge } = require('./services/mcp')
    mcp = createMcpBridge({ registry: harness.registry, invoke: (name, args, signal) => {
      requireSession(id)
      if(productionRuns.has(id))throw new Error('请等待执行器本次运行结束，再使用Agent调试')
      return harness.start(current, '外部 MCP：' + name, { directTool: { name, args }, executionConsent: true, signal })
    } })
    mcpSessionId = id
    return mcp.start()
  })
  const ensureTaskSources=()=>{
    if(settings.monitor?.legacyPaymentsMigrated)return
    const file=path.join(app.getPath('userData'),'platform-accounts.json')
    let records=[]
    try{if(fs.existsSync(file))records=JSON.parse(fs.readFileSync(file,'utf8'))}catch(_){records=null}
    const next=migrateLegacyPayments(settings.monitor,records,codec.decrypt)
    const previous=settings.monitor;settings.monitor=next
    try{saveSettings()}catch(error){settings.monitor=previous;throw error}
  }
  handle('undeclared:get-settings', () => {ensureIdentity(activeUserId());ensureTaskSources();return publicMonitorSettings(settings.monitor)})
  handle('app:task-sources',()=>{
    ensureIdentity(activeUserId())
    if(!mainWindow||mainWindow.isDestroyed())throw new Error('请打开主窗口，在系统设置中配置任务数据源')
    mainWindow.restore();mainWindow.show();mainWindow.focus();mainWindow.webContents.send('app:task-sources');return true
  })
  handle('undeclared:save-settings', input => {
    ensureIdentity(activeUserId())
    ensureTaskSources()
    const previous=settings.monitor;settings.monitor = prepareMonitorSettings(settings.monitor, input)
    try{saveSettings()}catch(error){settings.monitor=previous;throw error}
    return publicMonitorSettings(settings.monitor)
  })
  handle('undeclared:refresh', async () => {
    if (monitorAnalysisRuns.size) throw new Error('任务分析正在进行，请先停止分析再刷新')
    if (takeovers.size) throw new Error('申报户正在接管，请稍后刷新')
    const identity=ensureIdentity(activeUserId())
    ensureTaskSources()
    const result=await refreshUndeclaredData(settings.monitor)
    if(!userAuth.isCurrent(identity))throw new Error('用户已退出，请重新登录')
    if(takeovers.size)throw new Error('申报户正在接管，本次刷新结果已丢弃')
    if(monitorAnalysisRuns.size)throw new Error('任务分析已启动，刷新结果未替换正在分析的任务列表')
    for(const row of result.rows){
      const old=monitorSnapshot?.identity.id===identity.id?monitorSnapshot.rows.get(row.id):null
      if(old&&monitorFacts(old)===monitorFacts(row))for(const key of monitorAnalysisFields)if(Object.hasOwn(old,key))row[key]=clone(old[key])
    }
    monitorSnapshot={identity,at:Date.now(),rows:new Map(result.rows.map(row=>[row.id,clone(row)]))}
    return { ...result, analysisSnapshot:monitorSnapshot.at }
  })
  registerOperationsHandlers({handle,ensureIdentity,activeUserId,userAuth,getSettings:()=>settings,getSnapshot:()=>monitorSnapshot,monitorAnalysisRuns,createStore:()=>new SessionStore(path.join(app.getPath('userData'),'task-analysis'),codec)})
  handle('undeclared:export', async input => {
    const identity=ensureIdentity(activeUserId())
    const output = buildTaskExport(input)
    const selected = await dialog.showSaveDialog({ defaultPath: output.filename })
    if (selected.canceled) return { canceled: true }
    if(!userAuth.isCurrent(identity))throw new Error('登录用户已变化，请重新导出')
    fs.writeFileSync(selected.filePath, output.content, 'utf8'); return { canceled: false, applicationCount: output.applicationCount }
  })
}
async function closeMcp() { if (mcp) { const previous = mcp; mcp = null; mcpSessionId = null; await previous.stop() } }

app.whenReady().then(() => {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  settings = readSettings()
  settings.appearance=validateAppearance(settings.appearance)
  nativeTheme.themeSource=settings.appearance.mode
  nativeTheme.on('updated',broadcastAppearance)
  const { createLongforAuth } = require('./services/longfor-auth')
  platforms = createPlatformService({ filePath: path.join(app.getPath('userData'), 'platform-accounts.json'), safeStorage,
    defaults: () => [], longforAuth: createLongforAuth(partition => electronSession.fromPartition(partition)) })
  store = new SessionStore(path.join(app.getPath('userData'), 'sessions'), codec)
  executionEvidence = new ExecutionEvidence(path.join(app.getPath('userData'), 'execution-evidence'), codec, store)
  harness = new Harness({ store, registry: createTools(adapters),leases:executorLeases,nativeRuns:productionRuns,
    complete: (input, signal, context) => completeChat(
      {...settings,modelName:context?.modelName||settings.modelName}, settings.modelApiKey,
      addImageParts(input,context?.session,context?.imageIds,harness), fetch, signal),
    emit: event => { for (const win of windows) if (!win.isDestroyed() && event.sessionId && sessions.get(event.sessionId)?.scope.platformId === activeUserId()) win.webContents.send('agent:event', event) },
    cancelExecution: (current, context) => robot(current, { path: '/api/robot/debug/runs/active/cancel', method: 'POST',
      timeout: 15000, body: { appCode: current.scope.appCode, flowCode: current.scope.flowCode, taskCode: context?.taskCode || current.taskCode } }) })
  for (const unfinished of store.unfinished()) harness.recover(unfinished)
  registerIpc()
  mainWindow = openPage()
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [{label:'主页',accelerator:'CommandOrControl+1',click:()=>mainWindow.webContents.send('app:view','home')},{label:'打开',accelerator:'CommandOrControl+O',click:()=>mainWindow.webContents.send('app:open-application')},{type:'separator'},{role:'quit',label:'退出'}] },
    { label: '编辑', submenu: [{role:'undo',label:'撤销'},{role:'redo',label:'重做'},{type:'separator'},{role:'cut',label:'剪切'},{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'}] },
    { label: '视图', submenu: [{label:'任务监控',accelerator:'CommandOrControl+2',click:()=>mainWindow.webContents.send('app:view','taskMonitor')},{label:'系统设置',accelerator:'CommandOrControl+,',click:()=>mainWindow.webContents.send('app:settings')},{type:'separator'},{role:'reload',label:'重新加载'},{role:'togglefullscreen',label:'全屏'},{role:'toggleDevTools',label:'开发者工具'}] },
    { label: '帮助', submenu: [{label:'关于 rpa-agent',click:()=>dialog.showMessageBox(mainWindow,{type:'info',title:'rpa-agent',message:'rpa-agent '+app.getVersion(),detail:'RPA 流程开发与任务监控工作台'})}] }
  ]))
  mainWindow.setMenu(null)
}).catch(error => { dialog.showErrorBox('rpa-agent 启动失败', error.message); app.quit() })
app.on('before-quit', event => {
  if (!busy()) { closeMcp().catch(() => {}); return }
  event.preventDefault()
  for(const run of monitorAnalysisRuns.values())run.controller.abort()
  Promise.allSettled([...sessions.values()].map(current => harness.stop(current))).then(() => {
    // Pending requests must settle before quitting so encrypted checkpoints reflect actual termination.
    const timer = setInterval(() => { if (!busy()) { clearInterval(timer); app.quit() } }, 200)
  })
})
app.on('window-all-closed', () => app.quit())
