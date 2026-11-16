'use strict'

{
  const dialog = $('applicationSearch')
  const input = $('applicationSearchInput')
  const results = $('applicationSearchResults')
  const status = $('applicationSearchStatus')
  let matches = [], active = -1, timer, generation = 0, opening = false
  let selectionMoved = false

  function select(index, scroll = false) {
    if (!matches.length) return
    active = (index + matches.length) % matches.length
    for (const [position, option] of [...results.children].entries()) {
      option.setAttribute('aria-selected', String(position === active))
    }
    const option = results.children[active]
    input.setAttribute('aria-activedescendant', option.id)
    if (scroll) option.scrollIntoView({ block: 'nearest' })
  }

  function renderResults(entries, selectedMatch) {
    matches = entries
    active = -1
    results.replaceChildren()
    input.removeAttribute('aria-activedescendant')
    for (const [index, match] of matches.entries()) {
      const option = document.createElement('li')
      option.id = 'application-search-option-' + index
      option.setAttribute('role', 'option')
      option.textContent = match.label
      option.title = match.label
      option.onpointermove = () => {
        selectionMoved = true
        select(index)
      }
      option.onclick = () => openMatch(index)
      results.append(option)
    }
    results.hidden = !matches.length
    input.setAttribute('aria-expanded', String(!!matches.length))
    select(Math.max(0, matches.indexOf(selectedMatch)))
  }

  async function openMatch(index) {
    const match = matches[index]
    const platformId = window.currentUser?.id
    if (!dialog.open || opening || !match || !platformId) return
    opening = true
    input.readOnly = true
    status.textContent = '正在打开 ' + match.label + '…'
    try {
      if (match.field) {
        setView('taskMonitor')
        window.taskMonitor.filterByName(match.field, match.keyword)
      } else {
        await invoke('design:open', { platformId, appCode: match.appCode })
      }
      if (dialog.open) dialog.close()
    } catch (error) {
      if (dialog.open) status.textContent = '打开失败。' + error.message
    } finally {
      opening = false
      input.readOnly = false
    }
  }

  async function search(keyword, request) {
    try {
      const result = await invoke('business:action', 'applications', {
        platformId: window.currentUser?.id, keyword, page: 1, size: 100
      })
      if (!dialog.open || request !== generation) return
      const query = keyword.toLocaleLowerCase()
      const rank = name => name === query ? 0 : name.startsWith(query) ? 1 : 2
      const applications = result.rows
        .filter(row => row.appCode && typeof row.appName === 'string' && row.appName.toLocaleLowerCase().includes(query))
        .sort((a, b) => rank(a.appName.toLocaleLowerCase()) - rank(b.appName.toLocaleLowerCase()) ||
          a.appName.localeCompare(b.appName, 'zh-CN'))
        .map(row => ({ appCode: row.appCode, appName: row.appName, label: row.appName }))
      renderResults([...applications, ...matches], selectionMoved ? matches[active] : undefined)
      status.textContent = result.hasNext ? '继续输入以缩小范围' : ''
    } catch (error) {
      if (dialog.open && request === generation) status.textContent = '应用列表搜索失败。' + error.message
    }
  }

  function scheduleSearch(event) {
    clearTimeout(timer)
    const request = ++generation
    const keyword = input.value.trim()
    selectionMoved = false
    renderResults(keyword && !event.isComposing ? [
      { field: 'appName', keyword, label: '任务监控 · 应用名称包含「' + keyword + '」' },
      { field: 'customerName', keyword, label: '任务监控 · 客户名称包含「' + keyword + '」' }
    ] : [])
    status.textContent = keyword && !event.isComposing ? '正在搜索…' : ''
    if (keyword && !event.isComposing) timer = setTimeout(() => search(keyword, request), 180)
  }

  input.addEventListener('input', scheduleSearch)
  input.addEventListener('compositionend', scheduleSearch)
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || opening) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      selectionMoved = true
      select(active + (event.key === 'ArrowDown' ? 1 : -1), true)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      openMatch(active)
    }
  })
  dialog.addEventListener('cancel', event => { if (opening) event.preventDefault() })
  dialog.addEventListener('click', event => {
    if (event.target !== dialog || opening) return
    const bounds = dialog.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close()
  })
  dialog.addEventListener('close', () => {
    clearTimeout(timer)
    generation++
    renderResults([])
    input.value = ''
    status.textContent = ''
  })
  desktop.on('app:open-application', () => {
    if (!window.currentUser) {
      $('userLoginName').focus()
      return
    }
    if (!dialog.open) dialog.showModal()
    input.focus()
  })
}
