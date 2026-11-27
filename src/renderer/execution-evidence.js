'use strict'
let evidenceOpenRequest = 0

function evidenceText(tag, text, className = '') {
  const node = document.createElement(tag)
  node.textContent = text
  if (className) node.className = className
  return node
}

function evidencePicker(label, options) {
  const wrapper = evidenceText('label', label)
  const picker = document.createElement('select')
  picker.setAttribute('aria-label', label)
  options.forEach((text, index) => picker.add(new Option(text, String(index))))
  wrapper.append(picker)
  return { wrapper, picker }
}

function showExecutionRecording(panel, recording, executionCode) {
  const reasons = { DURATION_LIMIT: '已达到录制时长上限', SIZE_LIMIT: '已达到录像大小上限', CAPTURE_FAILED: '录屏中途失败' }
  if (recording?.status !== 'AVAILABLE' || !recording.frames?.length ||
      recording.contentType !== 'video/x-msvideo' || !/^[A-Za-z0-9+/=]+$/.test(recording.base64 || '')) {
    const message = recording?.status === 'UNAVAILABLE' && recording.requested
      ? '已请求录屏，但执行器未返回录像。请核对执行器版本及录屏能力。'
      : recording?.status === 'CAPTURE_FAILED' ? '本次录屏失败，执行器未取得桌面画面。'
        : recording && recording.status !== 'DISABLED' ? '本次录屏未取得可播放画面，请检查执行器录屏状态。' : '本次调试未开启录屏。'
    panel.append(evidenceText('p', message, 'muted'))
    return () => {}
  }
  const binary = atob(recording.base64), frames = recording.frames
  const controls = document.createElement('div')
  controls.className = 'row'
  const play = evidenceText('button', '播放')
  play.type = 'button'
  const seek = document.createElement('input')
  seek.type = 'range'; seek.min = '0'; seek.max = String(frames.length - 1); seek.value = '0'
  seek.setAttribute('aria-label', '录像时间轴')
  const download = evidenceText('a', '下载录像 AVI')
  download.href = 'data:video/x-msvideo;base64,' + recording.base64
  download.download = String(executionCode || 'dsl-debug').replace(/[^a-zA-Z0-9_-]/g, '_') + '.avi'
  const label = evidenceText('p', '', 'muted')
  const image = document.createElement('img')
  image.alt = '执行器主桌面录屏'
  image.className = 'execution-recording-frame'
  let timer, playing = false, disposed = false, frameIndex = 0
  const pause = () => { clearTimeout(timer); playing = false; play.textContent = '播放' }
  const show = () => {
    const frame = frames[frameIndex]
    if (!Number.isSafeInteger(frame.offset) || !Number.isSafeInteger(frame.length) || frame.offset < 0 ||
        frame.length < 1 || frame.offset + frame.length > binary.length) {
      pause(); label.textContent = '录像画面数据不完整。'; return false
    }
    image.src = 'data:image/jpeg;base64,' + btoa(binary.slice(frame.offset, frame.offset + frame.length))
    seek.value = String(frameIndex)
    label.textContent = [(frame.elapsedMs / 1000).toFixed(1) + ' / ' + (recording.durationMs / 1000).toFixed(1) + ' 秒',
      '主桌面', recording.fps + ' FPS', frame.flowCode, frame.stepCode,
      reasons[recording.stopReason]].filter(Boolean).join(' · ')
    return true
  }
  const advance = () => {
    if (disposed || !playing) return
    if (frameIndex >= frames.length - 1) { pause(); return }
    const delay = Math.max(1, frames[frameIndex + 1].elapsedMs - frames[frameIndex].elapsedMs)
    timer = setTimeout(() => { frameIndex++; if (show()) advance() }, delay)
  }
  play.onclick = () => {
    if (playing) { pause(); return }
    if (frameIndex === frames.length - 1) frameIndex = 0
    playing = true; play.textContent = '暂停'
    if (show()) advance()
  }
  seek.oninput = () => { pause(); frameIndex = Number(seek.value); show() }
  controls.append(play, seek, download)
  panel.append(controls, label, image)
  show()
  return () => { disposed = true; pause(); image.removeAttribute('src') }
}

function evidenceSnapshots(result) {
  const snapshots = Array.isArray(result.snapshots) ? result.snapshots : []
  const timeline = Array.isArray(result.DOMs) ? result.DOMs : []
  if (!snapshots.length) return timeline.map(item => ({ ...item, pages: item.pages || [] }))
  const byId = new Map(timeline.filter(item => item.snapshotId).map(item => [item.snapshotId, item]))
  return snapshots.map((snapshot, index) => {
    const entry = snapshot.snapshotId ? byId.get(snapshot.snapshotId) : timeline[index]
    const pages = entry?.pages?.length ? entry.pages : snapshot.doms?.length ? snapshot.doms : snapshot.dom ? [snapshot.dom] : []
    return { ...snapshot, pages }
  })
}

function showEvidenceDom(panel, snapshots, index) {
  const pages = snapshots[index]?.pages || []
  if (!pages.length) {
    panel.append(evidenceText('p', '此快照没有 DOM。', 'muted'))
    return
  }
  const { wrapper, picker } = evidencePicker('页面或框架', pages.map(page => {
    const location = page.framePath ? '框架 ' + page.framePath : '主文档'
    return [page.windowHandle, location, page.url].filter(Boolean).join(' · ')
  }))
  const source = evidenceText('pre', '', 'evidence-dom')
  const render = () => {
    let page = pages[Number(picker.value)]
    if (page.status === 'UNCHANGED' && !page.content) {
      for (let prior = index - 1; prior >= 0; prior--) {
        const saved = snapshots[prior].pages.find(item => item.content && item.url === page.url &&
          item.windowHandle === page.windowHandle && item.framePath === page.framePath)
        if (saved) { page = saved; break }
      }
    }
    source.textContent = page.content ? (page.truncated ? '［内容已截断］\n' : '') + page.content
      : page.status === 'EVICTED' ? '此快照的 DOM 内容未保留。' : '此页面没有可用的 DOM 内容。'
  }
  picker.onchange = render
  panel.append(wrapper, source)
  render()
}

async function showDebugExecutionDetails(sessionId, artifactId, initialTab = 'steps') {
  if (current?.id !== sessionId) return
  const request = ++evidenceOpenRequest
  let entries = await invoke('workspace:execution-evidence', sessionId, null)
  if (request !== evidenceOpenRequest || current?.id !== sessionId || document.body.dataset.currentView !== 'workspace') return

  const title = evidenceText('h2', '执行证据')
  title.id = 'executionEvidenceTitle'
  $('executionEvidenceDialog')?.close()
  $('executionEvidenceDialog')?.remove()
  const dialog = document.createElement('dialog')
  dialog.id = 'executionEvidenceDialog'
  dialog.setAttribute('aria-labelledby', title.id)
  const header = document.createElement('div')
  header.className = 'panel-heading'
  const close = evidenceText('button', '关闭')
  close.type = 'button'
  close.onclick = () => dialog.close()
  header.append(title, close)
  dialog.append(header)
  dialog.addEventListener('close', () => dialog.remove(), { once: true })

  const { wrapper, picker } = evidencePicker('执行记录', entries.map(entry =>
    (entry.executionCode || '未返回执行编码') + ' · ' + shortTime(entry.at)))
  picker.id = 'executionEvidenceRun'
  picker.disabled = !entries.length
  const remove = evidenceText('button', '删除证据', 'danger')
  remove.type = 'button'
  remove.disabled = !entries.length
  const controls = document.createElement('div')
  controls.className = 'row'
  controls.append(wrapper, remove)
  const summary = evidenceText('p', '', 'muted')
  summary.id = 'executionEvidenceSummary'
  summary.setAttribute('aria-live', 'polite')
  const tabs = document.createElement('div')
  tabs.className = 'evidence-tabs'
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', '证据类型')
  const panel = document.createElement('section')
  panel.id = 'executionEvidencePanel'
  panel.setAttribute('role', 'tabpanel')
  panel.tabIndex = 0
  const flow = current.dsl
  const tabNames = [['dsl', 'DSL'], ['steps', '执行步骤'], ['ctx', 'CTX'], ['dom', 'DOM'], ['screenshots', '截图'], ['recording', '录屏']]
  let activeTab = initialTab, data, snapshots = [], snapshotIndex = 0, loading = 0
  let releaseRecording = () => {}
  dialog.addEventListener('close', () => releaseRecording(), { once: true })
  const buttons = tabNames.map(([key, label], index) => {
    const button = evidenceText('button', label)
    button.type = 'button'
    button.id = 'evidence-tab-' + key
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-controls', panel.id)
    button.onclick = () => { activeTab = key; render() }
    button.onkeydown = event => {
      const position = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: tabNames.length - 1 }[event.key]
      if (position === undefined) return
      event.preventDefault()
      const target = buttons[(position + buttons.length) % buttons.length]
      target.click()
      target.focus()
    }
    return button
  })
  tabs.append(...buttons)
  dialog.append(controls, summary, tabs, panel)

  function render() {
    releaseRecording()
    releaseRecording = () => {}
    tabNames.forEach(([key], index) => {
      const selected = key === activeTab
      buttons[index].setAttribute('aria-selected', String(selected))
      buttons[index].tabIndex = selected ? 0 : -1
      if (selected) panel.setAttribute('aria-labelledby', buttons[index].id)
    })
    panel.replaceChildren()
    panel.scrollTop = 0
    if (!data) return
    const result = data.result || {}
    const empty = message => panel.append(evidenceText('p', message, 'muted'))
    if (activeTab === 'dsl') {
      const dsl = data.dsl || result.dsl
      if (dsl) panel.append(createInlineJsonTree(dsl).root)
      else empty('这次执行未保存 DSL 快照。')
    } else if (activeTab === 'recording') {
      releaseRecording = showExecutionRecording(panel, result.recording, result.executionCode)
    } else if (activeTab === 'steps') {
      const rows = debugExecutionResult.displaySteps(result, data.dsl || result.dsl).filter(row =>
        ['SUCCEEDED', 'FAILED', 'IGNORED', 'CANCELLED', 'BRANCH'].includes(row.status))
      if (!rows.length) { empty('没有实际执行的步骤记录。'); return }
      table(panel, [
        { label: '步骤名称', format: row => row.stepName || row.stepCode },
        { label: '所属流程', format: row => row.flowName || (row.flowCode === flow.flowCode ? flow.flowName : row.flowCode) },
        { label: '执行状态', format: row => debugExecutionResult.statusLabel(row.status) },
        { label: '时间', format: row => shortTime(row.time || row.endTime || row.startTime) },
        { label: '执行信息', format: row => row.message || row.error || row.errorStack }
      ], rows)
    } else {
      if (snapshots.length) {
        const phases = { INITIAL: '开始', BEFORE: '执行前', AFTER: '执行后', CHECKPOINT: '检查点', FAILURE: '失败', FINAL: '结束', BRANCH: '分支' }
        const selection = evidencePicker('快照', snapshots.map((item, index) => {
          const phase = item.phase === 'POINT' ? '指定采证 · ' + phases[item.timing] : phases[item.phase] || item.phase
          return [phase || '快照 ' + (index + 1), item.stepName || item.stepCode, item.phase === 'POINT' ? item.flowCode : null].filter(Boolean).join(' · ')
        }))
        selection.picker.value = String(snapshotIndex)
        selection.picker.onchange = () => { snapshotIndex = Number(selection.picker.value); render(); panel.querySelector('select')?.focus() }
        panel.append(selection.wrapper)
      }
      if (result.unreachedCapturePoints?.length) {
        empty('未到达采证点：' + result.unreachedCapturePoints.map(point =>
          point.flowCode + ' / ' + point.stepCode + '（' + (point.timing === 'BEFORE' ? '执行前' : '执行后') + '）').join('、'))
      }
      const snapshot = snapshots[snapshotIndex] || result
      if (activeTab === 'ctx') {
        const ctx = snapshot.ctx
        if (Array.isArray(ctx?.variables)) {
          if (ctx.variables.length) {
            const variables = document.createElement('div')
            table(variables, [
              { label: '变量', format: item => item.key || item.name },
              { key: 'type', label: '类型' },
              { label: '值', format: item => typeof item.value === 'object' ? JSON.stringify(item.value) : item.value }
            ], ctx.variables)
            panel.append(variables)
          } else empty('此快照没有可用的 CTX 变量。')
        } else if (ctx) panel.append(createInlineJsonTree(ctx).root)
        else empty('此快照没有 CTX。')
      } else if (activeTab === 'dom') {
        showEvidenceDom(panel, snapshots, snapshotIndex)
      } else {
        const items = snapshot.screenshots?.items || []
        const images = items.filter(item => item.contentType === 'image/png' && /^[A-Za-z0-9+/=]+$/.test(item.base64 || ''))
        images.forEach((item, index) => {
          const img = document.createElement('img')
          img.src = 'data:image/png;base64,' + item.base64
          img.alt = '执行截图 ' + (index + 1)
          panel.append(img)
        })
        if (!images.length) empty('此快照没有可用的截图。')
      }
    }
  }

  async function load() {
    const token = ++loading
    const entry = entries[Number(picker.value)]
    data = null
    summary.textContent = entry ? '正在读取执行证据…' : '当前流程暂无执行证据。'
    render()
    if (!entry) return
    try {
      const evidence = await invoke('workspace:execution-evidence', sessionId, entry.id)
      if (!dialog.open || token !== loading) return
      data = evidence
      snapshots = evidenceSnapshots(data.result || {})
      const failure = snapshots.findLastIndex(item => item.phase === 'FAILURE')
      const result = data.result || {}
      const outcome = debugExecutionResult.conclusion(result, debugExecutionResult.displaySteps(result, data.dsl || result.dsl))
      snapshotIndex = outcome.status === 'FAILED' && failure >= 0 ? failure : Math.max(0, snapshots.length - 1)
      const scopeLabel = { full: '当前完整 DSL', selected: '仅选中步骤', candidate: '候选 DSL', resume: '失败现场续跑' }[entry.executionScope]
      summary.textContent = [scopeLabel, outcome.content, entry.warning || data.warning].filter(Boolean).join(' · ')
      render()
    } catch (error) {
      if (dialog.open && token === loading) summary.textContent = '执行证据读取失败：' + error.message
    }
  }

  const selected = entries.findIndex(entry => entry.id === artifactId)
  if (artifactId && selected < 0) throw new Error('这次执行已不在当前流程的最近五次记录中')
  picker.value = String(Math.max(0, selected))
  picker.onchange = load
  remove.onclick = async () => {
    const index = Number(picker.value)
    const entry = entries[index]
    if (!entry) return
    remove.disabled = picker.disabled = true
    try {
      const deleted = await invoke('workspace:delete-execution-evidence', sessionId, entry.id)
      if (!deleted || !dialog.open) return
      document.querySelectorAll('button[data-debug-artifact]').forEach(button => {
        if (button.dataset.debugArtifact === entry.id) button.remove()
      })
      entries = entries.filter(item => item.id !== entry.id)
      picker.replaceChildren(...entries.map((item, position) => new Option(
        (item.executionCode || '未返回执行编码') + ' · ' + shortTime(item.at), String(position))))
      picker.selectedIndex = Math.min(index, entries.length - 1)
      await load()
      if (current?.id === sessionId) await refreshSnapshot()
    } catch (error) {
      if (dialog.open) summary.textContent = '删除证据失败：' + error.message
    } finally {
      remove.disabled = picker.disabled = !entries.length
    }
  }
  document.body.append(dialog)
  dialog.showModal()
  await load()
}
