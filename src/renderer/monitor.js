function createTaskMonitor(monitorRoot = document) {
    let analyzing=false,analysisStopped=false,analysisSnapshot=null
    let disposed=false,savingSources=false

    const ipcRenderer = window.desktop
    const { normalizeFilter, filterRows, filterLabels } = window.desktop.filter
    const FILTER_STORAGE_KEY = 'undeclared-result-filter'
    const REFRESH_INTERVAL = 30 * 60 * 1000
    let nextRefreshAt = 0
    let refreshTimer = null
    let countdownTimer = null
    let refreshing = false
    let refreshQueued = false
    let allRows = []
    let monitoredApplications = []
    let lastUpdatedAt = null
    let lastWarningCount = 0
    let lastRefreshFailed = false
    let exporting = false
    let appliedFilter = loadFilter()

    const elements = {
      filterButton: monitorRoot.getElementById('filterButton'),
      filterForm: monitorRoot.getElementById('filterForm'),
      filterSummary: monitorRoot.getElementById('filterSummary'),
      filterRules: monitorRoot.getElementById('filterRules'),
      addFilterRuleButton: monitorRoot.getElementById('addFilterRuleButton'),
      filterPayFee: monitorRoot.getElementById('filterPayFee'),
      clearFilterButton: monitorRoot.getElementById('clearFilterButton'),
      settingsButton: monitorRoot.getElementById('settingsButton'),
      refreshButton: monitorRoot.getElementById('refreshButton'),
      exportButton: monitorRoot.getElementById('exportButton'),
      settingsForm: monitorRoot.getElementById('settingsForm'),
      sourceMessage:monitorRoot.getElementById('sourceSettingsMessage'),
      keywords: monitorRoot.getElementById('keywords'),
      serverRows: monitorRoot.getElementById('serverRows'),
      addServerButton: monitorRoot.getElementById('addServerButton'),
      rowCount: monitorRoot.getElementById('rowCount'),
      totalIncomplete: monitorRoot.getElementById('totalIncomplete'),
      refreshStatus: monitorRoot.getElementById('refreshStatus'),
      message: monitorRoot.getElementById('message'),
      tableBody: monitorRoot.getElementById('tableBody'),
      empty: monitorRoot.getElementById('empty')
    }

    const applicationEditor=createMonitorApplications(monitorRoot.getElementById('monitorAppsEditor'),elements.keywords)
    function loadFilter() {
      try { return normalizeFilter(JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) || '{}')) }
      catch (_) { return normalizeFilter() }
    }

    function saveFilter() {
      try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(appliedFilter)) } catch (_) {}
    }

    function showMessage(text, type) {
      elements.message.textContent = text || ''
      elements.message.className = `message${text ? ` show ${type}` : ''}`
    }
    function openTaskSources(){
      if(monitorRoot===document)ipcRenderer.invoke('app:task-sources').catch(error=>showMessage(error.message,'error'))
      else document.dispatchEvent(new Event('open-task-data-sources'))
    }

    function formatTime(value) {
      return new Date(value).toLocaleString('zh-CN', { hour12: false })
    }

    function formatRemaining(milliseconds) {
      const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
      const minutes = Math.floor(seconds / 60)
      const remainSeconds = seconds % 60
      return `${minutes}分${String(remainSeconds).padStart(2, '0')}秒`
    }

    function updateCountdown() {
      if (!nextRefreshAt || refreshing) return
      elements.refreshStatus.textContent = `下次刷新：${formatRemaining(nextRefreshAt - Date.now())}`
    }

    function scheduleRefresh() {
      clearTimeout(refreshTimer)
      nextRefreshAt = Date.now() + REFRESH_INTERVAL
      refreshTimer = setTimeout(refreshData, REFRESH_INTERVAL)
      updateCountdown()
    }

    function appendCell(row, value, className) {
      const cell = document.createElement('td')
      if (className) cell.className = className
      cell.textContent = value === null || value === undefined || value === '' ? '—' : String(value)
      row.appendChild(cell)
      return cell
    }
    function appendCompactCell(row,value,className){
      const cell=document.createElement('td');cell.className=className||''
      const text=document.createElement('span');text.className='monitor-cell-text';text.textContent=value===null||value===undefined||value===''?'—':String(value);text.title=text.textContent
      cell.append(text);row.append(cell);return cell
    }

    function formatTaskStatus(item) {
      const status = String(item.taskStatus || '').trim()
      const comment = String(item.taskComment || '').trim()
      return status === '已停用' && comment ? `${status}（${comment}）` : status
    }

    function appendTaskDetails(row, item) {
      const cell = document.createElement('td')
      cell.className = 'task-details'
      const pending = Math.max(0, Number(item.noDeclaredCount) || 0)
      const audit = Math.max(0, Number(item.auditCount) || 0)
      const details = (Array.isArray(item.taskDetails) ? item.taskDetails : [])
        .filter(detail => String(detail.name || '').trim() && Number(detail.count) > 0)
      const detailTotal = details.reduce((sum, detail) => sum + Number(detail.count), 0)
      const summary = document.createElement('div');summary.className = 'task-summary'
      cell.append(summary)
      // Business links already contain their counts; show a separate total only
      // when detail data is absent or does not cover the source's pending count.
      if (!details.length || detailTotal !== pending) {
        if (pending > 0 || details.length) {
          const count = document.createElement('span');count.className = 'task-count'
          count.textContent = `待处理（${pending}）`
          count.title = details.length ? `来源待处理合计 ${pending}，业务明细合计 ${detailTotal}；明细可能尚未同步` : '业务明细暂未提供'
          summary.append(count)
        }
      }
      if (audit > 0) {
        const badge = document.createElement('span');badge.className = 'task-audit'
        badge.textContent = `审核中（${audit}）`;badge.title = '审核中的任务数，与待处理业务明细分别展示'
        summary.append(badge)
      }
      if (!summary.childElementCount) summary.remove()
      const links=document.createElement('span');links.className='task-links';cell.appendChild(links)
      if (!details.length) {
        links.remove()
        if (!pending && !audit) cell.textContent = '无未完成任务'
      }
      details.forEach(detail => {
        const label = `${detail.name}（${detail.count}）`
        const link = document.createElement('a')
        link.href = '#'
        link.textContent = label
        link.title = `查看${detail.name}相关流程，待处理 ${detail.count} 项`
        link.addEventListener('click', async event => {
          event.preventDefault()
          if(link.getAttribute('aria-busy')==='true')return
          link.setAttribute('aria-busy','true')
          try { await ipcRenderer.invoke('monitor:open-flow', {
            baseServer: item.baseServer,
            appCode: item.appCode,
            appName: item.appName,
            taskName: detail.name, taskCode: item.taskCode
          }) } catch (error) { showMessage(error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,''), 'error') }
          finally{link.removeAttribute('aria-busy')}
        })
        links.appendChild(link)
      })
      row.appendChild(cell)
    }

    function renderRows(rows) {
      elements.tableBody.innerHTML = ''
      elements.empty.style.display = rows.length ? 'none' : 'block'
      elements.empty.textContent = '暂无数据'
      rows.forEach(item => {
        const row = document.createElement('tr')
        appendCompactCell(row, item.appName,'monitor-app')
        appendCompactCell(row, item.customerName)
        appendCompactCell(row, item.accountNumber,'monitor-account')
        const status=appendCompactCell(row, formatTaskStatus(item),'monitor-status')
        status.firstElementChild.classList.add('task-status-badge',item.taskStatus==='正在执行'?'running':item.taskStatus==='已停用'?'disabled':item.taskStatus==='已启用'?'enabled':'neutral')
        appendTaskDetails(row, item)
        appendCompactCell(row, item.incompleteReason || '尚未分析','monitor-reason')
        appendCompactCell(row, item.remark,'monitor-remark')
        appendCell(row, item.execCount, 'execution-count')
        const actions=document.createElement('td'),takeover=document.createElement('button');actions.className='monitor-actions';takeover.className='button monitor-takeover';takeover.textContent='Agent接管';takeover.onclick=async()=>{takeover.disabled=true;try{await openAgentTakeover(item.id)}catch(error){showMessage(error.message,'error')}finally{takeover.disabled=false}};actions.append(takeover);row.append(actions)
        elements.tableBody.appendChild(row)
      })
      elements.rowCount.textContent = rows.length.toLocaleString('zh-CN')
      elements.totalIncomplete.textContent = rows.reduce((sum, item) => sum + (Number(item.noDeclaredCount) || 0), 0).toLocaleString('zh-CN')
    }

    function renderFilterSummary() {
      elements.filterSummary.replaceChildren()
      const labels = filterLabels(appliedFilter)
      if (!labels.length) return
      const chip = document.createElement('span')
      chip.className = 'filter-chip'
      chip.textContent = `已应用 ${labels.length} 项过滤`
      chip.title = labels.join('；')
      elements.filterSummary.appendChild(chip)
    }

    function renderFilteredRows() {
      renderRows(filterRows(allRows, appliedFilter))
      renderFilterSummary()
    }

    function setFilterInputs(filter) {
      elements.filterRules.replaceChildren()
      const rules = filter.rules.length ? filter.rules : [{ field: 'appName', operator: 'contains', keyword: '' }]
      rules.forEach(addFilterRule)
      elements.filterPayFee.checked = filter.includePayFee
    }

    function addFilterRule(rule = {}) {
      const row = document.createElement('div')
      row.className = 'filter-rule'
      const field = document.createElement('select')
      field.className = 'filter-field'
      field.setAttribute('aria-label', '选择字段')
      ;[['appName', '应用'], ['customerName', '客户名称'], ['taskStatus', '任务状态']].forEach(([value, label]) => {
        const option = document.createElement('option')
        option.value = value
        option.textContent = label
        field.appendChild(option)
      })
      field.value = rule.field || 'appName'
      const operator = document.createElement('select')
      operator.className = 'filter-operator'
      operator.setAttribute('aria-label', '选择条件')
      ;[['contains', '包含'], ['notContains', '不包含']].forEach(([value, label]) => {
        const option = document.createElement('option')
        option.value = value
        option.textContent = label
        operator.appendChild(option)
      })
      operator.value = rule.operator || 'contains'
      const keyword = document.createElement('input')
      keyword.className = 'filter-keyword'
      keyword.setAttribute('aria-label', '关键字')
      keyword.autocomplete = 'off'
      keyword.placeholder = '输入关键字，多个用逗号分隔'
      keyword.value = rule.keyword || ''
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'button remove-rule'
      remove.textContent = '删除'
      remove.addEventListener('click', () => row.remove())
      row.append(field, operator, keyword, remove)
      elements.filterRules.appendChild(row)
    }

    function collectFilterRules() {
      return Array.from(elements.filterRules.querySelectorAll('.filter-rule')).map(row => ({
        field: row.querySelector('.filter-field').value,
        operator: row.querySelector('.filter-operator').value,
        keyword: row.querySelector('.filter-keyword').value
      }))
    }

    function addServerRow(server = {}) {
      const row = document.createElement('div')
      row.className = 'server-row'
      const kind=document.createElement('select');kind.className='server-kind';kind.setAttribute('aria-label','任务类型')
      kind.add(new Option('申报任务','normal'));kind.add(new Option('缴费任务','payment'));kind.value=server.kind||'normal'
      const baseServer = document.createElement('input')
      baseServer.className = 'server-base'
      baseServer.placeholder = 'https://example.com'
      baseServer.value = server.baseServer || ''
      const username = document.createElement('input')
      username.className = 'server-username'
      username.placeholder = 'username'
      username.value = server.username || ''
      const password = document.createElement('input')
      password.className = 'server-password'
      password.type = 'password'
      password.autocomplete = 'new-password'
      password.placeholder = server.hasPassword ? '已保存，留空不修改' : 'password'
      const removeButton = document.createElement('button')
      removeButton.type = 'button'
      removeButton.className = 'button remove-server'
      removeButton.textContent = '删除'
      removeButton.addEventListener('click', () => row.remove())
      baseServer.setAttribute('aria-label','服务地址');username.setAttribute('aria-label','登录账户');password.setAttribute('aria-label','密码')
      row.append(kind,baseServer, username, password, removeButton)
      elements.serverRows.appendChild(row)
    }

    function collectServers(kind) {
      return Array.from(elements.serverRows.querySelectorAll('.server-row')).filter(row=>row.querySelector('.server-kind').value===kind).map(row => ({
        baseServer: row.querySelector('.server-base').value,
        username: row.querySelector('.server-username').value,
        password: row.querySelector('.server-password').value
      }))
    }

    async function refreshData() {
      if(disposed)return
      if(analyzing){scheduleRefresh();return}
      if (refreshing) {
        refreshQueued = true
        elements.refreshStatus.textContent = '当前请求完成后将按新设置刷新'
        return
      }
      clearTimeout(refreshTimer)
      refreshing = true
      elements.exportButton.disabled = true
      elements.refreshButton.disabled = true
      elements.refreshButton.textContent = '刷新中…'
      elements.refreshStatus.textContent = '正在读取客户应用列表'
      elements.refreshStatus.classList.add('loading')
      showMessage('', '')
      let needsConfiguration = false
      try {
        const config=await ipcRenderer.invoke('undeclared:get-settings')
        if(disposed)return
        monitoredApplications=monitorApplicationNames(config.keywords)
        const keywords=Array.isArray(config.keywords)?config.keywords.join('').trim():String(config.keywords||'').trim()
        if(!keywords||!config.servers?.length&&!config.paymentServers?.length){
          needsConfiguration=true;lastRefreshFailed=!!lastUpdatedAt;nextRefreshAt=0
          allRows=[];lastUpdatedAt=null;renderFilteredRows()
          elements.refreshStatus.textContent='等待配置任务数据源'
          elements.empty.style.display=elements.tableBody.children.length?'none':'block'
          elements.empty.textContent='请在系统设置的“任务监控设置”中填写监控应用和数据源登录账户。'
          showMessage('请前往系统设置 → 任务监控设置，保存后即可查看任务。','warning')
          const configure=document.createElement('button');configure.textContent='前往任务监控设置';configure.className='button';configure.onclick=openTaskSources;elements.empty.append(document.createElement('br'),configure)
          return
        }
        const result = await ipcRenderer.invoke('undeclared:refresh')
        if(disposed)return
        allRows = result.rows || []
        analysisSnapshot=result.analysisSnapshot
        lastUpdatedAt = result.updatedAt
        lastWarningCount = (result.warnings || []).length
        lastRefreshFailed = false
        renderFilteredRows()
        elements.refreshStatus.textContent = `已更新：${formatTime(result.updatedAt)}`
        if (result.warnings && result.warnings.length) showMessage(result.warnings.join('\n'), 'warning')
      } catch (error) {
        lastRefreshFailed = true
        elements.empty.style.display = elements.tableBody.children.length ? 'none' : 'block'
        elements.empty.textContent = '数据读取失败，请检查系统设置中的任务监控设置后重试。'
        elements.refreshStatus.textContent = '刷新失败'
        showMessage(String(error?.message||error).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,''), 'error')
      } finally {
        refreshing = false
        if(typeof renderOverview==='function')renderOverview()
        elements.exportButton.disabled = exporting || !lastUpdatedAt
        elements.refreshButton.disabled = false
        elements.refreshButton.textContent = '立即刷新'
        elements.refreshStatus.classList.remove('loading')
        if (refreshQueued) {
          refreshQueued = false
          setTimeout(refreshData, 0)
        } else if (!needsConfiguration&&!disposed) {
          scheduleRefresh()
        }
      }
    }

    async function exportCurrentTasks() {
      if (refreshing || exporting || !lastUpdatedAt) return
      exporting = true
      elements.exportButton.disabled = true
      elements.exportButton.textContent = '导出中…'
      try {
        const result = await ipcRenderer.invoke('undeclared:export', {
          rows: filterRows(allRows, appliedFilter), updatedAt: lastUpdatedAt,
          filterLabels: filterLabels(appliedFilter), warningCount: lastWarningCount, refreshFailed: lastRefreshFailed
        })
        if (!result.canceled && !lastWarningCount && !lastRefreshFailed) showMessage(`已导出 ${result.applicationCount} 个应用的未完成任务汇总。`, 'success')
      } catch (error) { showMessage(error.message || '导出失败，请重试', 'error') }
      finally {
        exporting = false
        elements.exportButton.disabled = refreshing || !lastUpdatedAt
        elements.exportButton.textContent = '导出当前任务'
      }
    }

    elements.exportButton.addEventListener('click', exportCurrentTasks)

    async function loadSettings() {
      const settings = await ipcRenderer.invoke('undeclared:get-settings')
      if(disposed)return
      elements.keywords.value = Array.isArray(settings.keywords) ? settings.keywords.join(', ') : String(settings.keywords || '')
      monitoredApplications=monitorApplicationNames(settings.keywords);applicationEditor.saved()
      elements.serverRows.innerHTML = ''
      ;(settings.servers || []).forEach(addServerRow)
      ;(settings.paymentServers||[]).forEach(server=>addServerRow({...server,kind:'payment'}))
      if(elements.sourceMessage&&settings.migrationWarnings?.length)elements.sourceMessage.textContent=settings.migrationWarnings.join(' ')
    }

    elements.filterButton.addEventListener('click', () => {
      const open = elements.filterForm.classList.toggle('open')
      elements.filterButton.setAttribute('aria-expanded', String(open))
      if (open) {
        setFilterInputs(appliedFilter)
      }
    })
    elements.filterForm.addEventListener('submit', event => {
      event.preventDefault()
      appliedFilter = normalizeFilter({
        rules: collectFilterRules(),
        includePayFee: elements.filterPayFee.checked
      })
      saveFilter()
      renderFilteredRows()
      elements.filterForm.classList.remove('open')
      elements.filterButton.setAttribute('aria-expanded', 'false')
    })
    elements.addFilterRuleButton.addEventListener('click', () => addFilterRule())
    elements.clearFilterButton.addEventListener('click', () => {
      appliedFilter = normalizeFilter()
      setFilterInputs(appliedFilter)
      saveFilter()
      renderFilteredRows()
    })
    elements.settingsButton?.addEventListener('click',openTaskSources)
    elements.addServerButton.addEventListener('click', () => addServerRow())
    monitorRoot.getElementById('analyzeButton').addEventListener('click', async event => {
      const button = event.currentTarget
      if(refreshing || analyzing)return
      analyzing=true
      analysisStopped=false
      const stop=monitorRoot.getElementById('stopAnalysis');stop.hidden=false;stop.disabled=false
      button.disabled = true
      elements.refreshButton.disabled = true
      button.title='正在分析当前筛选范围内的未完成任务'
      // Context-isolated preload functions return cloned rows. Keep references
      // to the page's own rows so conclusions actually update the table.
      const selectedIds=new Set(filterRows(allRows,appliedFilter).map(row=>row.id))
      const rows = allRows.filter(row=>selectedIds.has(row.id)&&(Number(row.noDeclaredCount)>0||Number(row.auditCount)>0))
      let succeeded=0,failed=0
      if(!rows.length)button.title='当前筛选范围没有待分析任务'

      try {
        for (const [index, row] of rows.entries()) {
          if (disposed || analysisStopped) break
          if (!(Number(row.noDeclaredCount) > 0 || Number(row.auditCount) > 0)) continue
          const currentRequestId=crypto.randomUUID()
          button.textContent = `分析中 ${index + 1}/${rows.length}`
          try { const result=await ipcRenderer.invoke('monitor:analyze', { id: row.id,snapshotAt:analysisSnapshot,requestId:currentRequestId });if(analysisStopped||disposed)break;row.incompleteReason=result.reason;row.analyzedAt=result.analyzedAt;row.analysisModel=result.modelName;if(result.analysis?.state==='failed')failed++;else succeeded++ }
          catch (error) { row.incompleteReason = analysisStopped?'分析已停止，尚未形成结论':`分析失败：${String(error.message).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'')}`;if(!analysisStopped)failed++ }
          if(disposed)break
          if (!disposed) renderFilteredRows()
        }
        if(!disposed&&rows.length)button.title=`${analysisStopped?'分析已停止':'分析结束'}：完成 ${succeeded} 项，失败 ${failed} 项。结果见未完成原因列。`
      } finally { analyzing=false;stop.hidden=true; button.disabled = false; button.textContent = '分析Agent'; elements.refreshButton.disabled = false }
    })
    monitorRoot.getElementById('stopAnalysis').addEventListener('click',async event=>{
      analysisStopped=true;event.currentTarget.disabled=true
      try{await ipcRenderer.invoke('monitor:analysis-stop')}catch(error){showMessage(error.message,'error')}
    })
    elements.refreshButton.addEventListener('click', refreshData)
    elements.settingsForm.addEventListener('submit', async event => {
      event.preventDefault()
      if(savingSources||disposed)return
      if(!applicationEditor.commit())return
      savingSources=true
      applicationEditor.setBusy(true)
      const save=elements.settingsForm.querySelector('[type=submit]');save.disabled=true
      if(elements.sourceMessage)elements.sourceMessage.textContent='正在保存…'
      try {
        const settings = await ipcRenderer.invoke('undeclared:save-settings', {
          keywords: monitorApplicationNames(elements.keywords.value),
          servers: collectServers('normal'),paymentServers:collectServers('payment')
        })
        if(disposed)return
        elements.keywords.value=monitorApplicationNames(settings.keywords).join(', ')
        monitoredApplications=monitorApplicationNames(settings.keywords);applicationEditor.saved()
        elements.serverRows.innerHTML = ''
        ;(settings.servers || []).forEach(addServerRow)
        ;(settings.paymentServers||[]).forEach(server=>addServerRow({...server,kind:'payment'}))
        if(elements.sourceMessage)elements.sourceMessage.textContent='任务监控设置已保存，正在刷新任务。'
        await refreshData()
        if(!disposed&&elements.sourceMessage)elements.sourceMessage.textContent=lastRefreshFailed?'任务数据源已保存，但刷新失败，请查看任务监控中的错误信息。':'任务监控设置已保存，任务已刷新。'
      } catch (error) {
        if(!disposed){const message=String(error?.message||error).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'');if(elements.sourceMessage)elements.sourceMessage.textContent=message;else showMessage(message,'error')}
      }finally{savingSources=false;save.disabled=false;applicationEditor.setBusy(false)}
    })

    window.addEventListener('beforeunload', () => {
      if(analyzing)ipcRenderer.invoke('monitor:analysis-stop').catch(()=>{})
      clearTimeout(refreshTimer)
      clearInterval(countdownTimer)
    })

    renderFilterSummary()
    setFilterInputs(appliedFilter)
    countdownTimer = setInterval(updateCountdown, 1000)
    loadSettings().then(refreshData).catch(error => showMessage(error.message || String(error), 'error'))
  

return {elements,refreshData,exportCurrentTasks,dispose(){disposed=true;if(analyzing)ipcRenderer.invoke('monitor:analysis-stop').catch(()=>{});clearTimeout(refreshTimer);clearInterval(countdownTimer)},get monitoredApplications(){return [...monitoredApplications]},get allRows(){return allRows},get lastUpdatedAt(){return lastUpdatedAt},get refreshing(){return refreshing},get lastRefreshFailed(){return lastRefreshFailed}}
}
if(document.getElementById("tableBody"))window.taskMonitor=createTaskMonitor()
