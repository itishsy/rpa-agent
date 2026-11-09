const http = require('http')
const https = require('https')
const { createHash } = require('crypto')

// 主进程内存缓存，页面切换与定时刷新均可复用；不落盘保存 token。
const tokenCache = new Map()
const pendingRefreshes = new Map()

// 同一配置的并发刷新共用一次完整查询；不同配置互不影响。
// 只合并进行中的请求，完成后的手动或定时刷新仍会获取最新数据。
function refreshUndeclaredData(config) {
  const key = createHash('sha256').update(JSON.stringify(config)).digest('hex')
  if (pendingRefreshes.has(key)) return pendingRefreshes.get(key)
  const pending = fetchUndeclaredData(config).finally(() => {
    if (pendingRefreshes.get(key) === pending) pendingRefreshes.delete(key)
  })
  pendingRefreshes.set(key, pending)
  return pending
}

function cachedLogin(server) {
  const key = JSON.stringify([buildApiUrl(server.baseServer, 'oauth/token'), toText(server.username),server.authMode||'interface'])
  const fingerprint = createHash('sha256').update(toText(server.password)).digest('hex')
  let entry = tokenCache.get(key)
  if (!entry || entry.fingerprint !== fingerprint) {
    entry = { fingerprint }
    entry.promise = login(server).catch(error => {
      if (tokenCache.get(key) === entry) tokenCache.delete(key)
      throw error
    })
    tokenCache.set(key, entry)
  }
  return { key, entry }
}

async function fetchClientList(server) {
  return authenticatedRequest(server, 'robot/app/client/list', { keyWord: '', status: [], machineCode: '', clientId: null })
}

const CUSTOMER_BASE_SERVER = 'https://rpa.internal.nfstone.com'

async function fetchCustomerNames(server) {
  const payload = await authenticatedRequest({ ...server, baseServer: CUSTOMER_BASE_SERVER }, 'policy/sys/customer/page', {
    page: 1, start: 0, size: 500,
    query: [
      { property: 'searchText', value: '' },
      { property: 'statuses', value: [] }
    ],
    sidx: '', sort: ''
  })
  const customers = payload && payload.data && Array.isArray(payload.data.rows) ? payload.data.rows : []
  return new Map(customers.filter(customer => customer && toText(customer.id) && toText(customer.name))
    .map(customer => [toText(customer.id), toText(customer.name)]))
}

function previousOperateMonth(now = new Date()) {
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}`
}

async function fetchPayFeeList(server) {
  if (!toText(server.accessToken)&&server.authMode!=='payment') throw new Error('缴费数据源缺少登录凭据')
  const size = 100
  const records = []
  for (let page = 1; ; page += 1) {
    const payload = await authenticatedRequest(server, 'policy/customer/payFee/page', {
      page, start: (page - 1) * size, size,
      query: [
        { property: 'businessType', value: null },
        { property: 'accountNumber', value: [] },
        { property: 'addrId', value: null },
        { property: 'minOperateMonth', value: '' },
        { property: 'maxOperateMonth', value: '' },
        { property: 'minCreateDate', value: '' },
        { property: 'maxCreateDate', value: '' },
        { property: 'minPayDate', value: '' },
        { property: 'maxPayDate', value: '' },
        { property: 'statuses', value: [] },
        { property: 'robotStatuses', value: [11, 21, 31, 25] }
      ],
      sidx: '', sort: ''
    })
    const batch = findRecordArray(payload, ['addrName', 'businessType', 'custId', 'robotStatusName', 'paySystemName'])
    records.push(...batch)
    const data = payload && payload.data
    const total = Number(data && (data.total ?? data.totalCount))
    if (batch.length < size || (Number.isFinite(total) && total > 0 && records.length >= total)) break
  }
  return { data: { records } }
}

async function authenticatedRequest(server, endpoint, body = {}, options = {}) {
  if (server.accessToken) {
    return requestJson(buildApiUrl(server.baseServer, endpoint), {
      ...options,
      headers: {
        Authorization: `Bearer ${server.accessToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(body)
    })
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { key, entry } = cachedLogin(server)
    const accessToken = await entry.promise
    try {
      return await requestJson(buildApiUrl(server.baseServer, endpoint), {
        ...options,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(body)
      })
    } catch (error) {
      if (error.statusCode !== 401 && String(error.businessCode) !== '401') throw error
      // 只淘汰本次使用的 token，避免并发的旧请求清除新登录的缓存。
      if (tokenCache.get(key) === entry) tokenCache.delete(key)
      if (attempt === 1) throw error
    }
  }
}

const DEFAULT_BASE_SERVERS = [
  'https://rpa.internal.nfstone.com',
  'https://hrdcrpa.onewo.com',
  'https://gwp0-m7.longfor.com/rpa-client-auth/api'
]

function toText(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function toNumber(value) {
  const result = Number(value)
  return Number.isFinite(result) ? result : 0
}

function normalizeBaseServer(value) {
  return toText(value).replace(/\/+$/, '')
}
function analysisSourceKey(server) {
  return createHash('sha256').update(JSON.stringify([normalizeBaseServer(server.baseServer),String(server.username || '')])).digest('hex')
}

function buildApiUrl(baseServer, path) {
  const base = normalizeBaseServer(baseServer)
  if (!base) throw new Error('base_server 不能为空')
  const apiBase = /\/api$/i.test(base) ? base : `${base}/api`
  return `${apiBase}/${toText(path).replace(/^\/+/, '')}`
}

function normalizeKeywords(value) {
  const source = Array.isArray(value) ? value : [value]
  return Array.from(new Set(source
    .flatMap(item => toText(item).split(/[,，]/))
    .map(item => item.trim())
    .filter(Boolean)))
}

function findRecordArray(payload, expectedFields) {
  const visited = new Set()
  function walk(value) {
    if (value && typeof value === 'object') {
      if (visited.has(value)) return null
      visited.add(value)
    }
    if (Array.isArray(value)) {
      const records = value.filter(item => item && typeof item === 'object' && !Array.isArray(item))
      if (records.some(record => expectedFields.some(field => Object.prototype.hasOwnProperty.call(record, field)))) return records
      for (const item of value) {
        const nested = walk(item)
        if (nested) return nested
      }
      return null
    }
    if (value && typeof value === 'object') {
      for (const key of ['rows', 'list', 'content', 'data', 'result', 'records']) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          const nested = walk(value[key])
          if (nested) return nested
        }
      }
      for (const nestedValue of Object.values(value)) {
        const nested = walk(nestedValue)
        if (nested) return nested
      }
    }
    return null
  }
  return walk(payload) || []
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url)
    const requestBody = options.body || ''
    const transport = requestUrl.protocol === 'http:' ? http : https
    const request = transport.request(requestUrl, {
      method: options.method || 'POST',
      signal: options.signal,
      timeout: 60 * 1000,
      headers: {
        Accept: 'application/json',
        ...options.headers,
        ...(requestBody ? { 'Content-Length': Buffer.byteLength(requestBody) } : {})
      }
    }, response => {
      let responseBody = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        responseBody += chunk
        if (Buffer.byteLength(responseBody) > (options.maxBytes || 64 * 1024 * 1024)) request.destroy(new Error('查询结果超过读取上限，请缩小范围'))
      })
      response.on('error', reject)
      response.on('end', () => {
        let payload
        try {
          payload = responseBody ? JSON.parse(responseBody) : {}
        } catch (error) {
          const failure = new Error(`响应不是有效 JSON（HTTP ${response.statusCode}）`)
          failure.statusCode = response.statusCode
          reject(failure)
          return
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const failure = new Error(payload.error_description || payload.message || payload.data || `HTTP ${response.statusCode}`)
          failure.statusCode = response.statusCode
          failure.businessCode = payload.code
          reject(failure)
          return
        }
        if (payload && payload.code && String(payload.code) !== '200' && String(payload.code) !== '0') {
          const failure = new Error(payload.message || payload.data || `业务状态码 ${payload.code}`)
          failure.statusCode = response.statusCode
          failure.businessCode = payload.code
          reject(failure)
          return
        }
        resolve(payload)
      })
    })
    request.on('timeout', () => request.destroy(new Error('请求超时（60 秒）')))
    request.on('error', reject)
    request.end(requestBody)
  })
}

async function login(server) {
  const username = toText(server.username)
  const password = toText(server.password)
  if (!username || !password) throw new Error('用户名或密码未配置')

  const loginUrl = new URL(buildApiUrl(server.baseServer, 'oauth/token'))
  loginUrl.searchParams.set('client_id', 'rpa')
  loginUrl.searchParams.set('client_secret', '123')
  loginUrl.searchParams.set('grant_type', 'password')
  if(server.authMode==='payment'){
    loginUrl.searchParams.set('username',username)
    loginUrl.searchParams.set('password',require('./platform-service').encryptLoginPassword(password))
  }else{
    loginUrl.searchParams.set('accData', username)
    loginUrl.searchParams.set('encData', password)
  }
  const payload = await requestJson(loginUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  })
  const accessToken = toText(payload.access_token || (payload.data && payload.data.access_token))
  if (!accessToken) throw new Error('登录响应中没有 access_token')
  return accessToken
}

function executionCount(record){
  if(record.execCount==null||String(record.execCount).trim()==='')return null
  if(!['number','string'].includes(typeof record.execCount))return null
  const count=Number(record.execCount)
  return Number.isInteger(count)&&count>=0?count:null
}
function normalizeRows(payload, server, serverIndex, appNames) {
  const allowedAppNames = new Set(appNames)
  return findRecordArray(payload, [
    'appName', 'customerName', 'accountNumber', 'taskStatus', 'noDeclaredNumber', 'noDeclaredCount', 'auditCount'
  ]).filter(record => (
    (toNumber(record.noDeclaredCount) > 0 || toNumber(record.auditCount) > 0) && allowedAppNames.has(toText(record.appName))
  )).map((record, index) => ({
    id: `server-${serverIndex}-${toText(record.id) || toText(record.clientId) || index}`,
    baseServer: normalizeBaseServer(server.baseServer),
    analysisSourceKey:analysisSourceKey(server),
    appName: toText(record.appName),
    clientId: record.clientId, addrId: record.addrId, businessType: record.businessType,
    customerName: toText(record.customerName),
    customerId: toText(record.custId ?? record.customerId),
    accountNumber: toText(record.accountNumber || record.accNumber),
    accNumber: toText(record.accNumber || record.accountNumber),
    appCode: toText(record.appCode),
    taskCode: toText(record.taskCode),
    machineCode:toText(record.machineCode),flowCode:toText(record.flowCode),
    taskStatus: toText(record.taskStatus),
    taskComment: toText(record.taskComment),
    execCount: executionCount(record),
    noDeclaredCount: toNumber(record.noDeclaredCount),
    auditCount: toNumber(record.auditCount),
    noDeclaredNumber: toNumber(record.noDeclaredNumber)
  }))
}

function normalizePayFeeRows(payload, server, serverIndex, appNames, customerNames = new Map()) {
  const allowedAppNames = new Set(appNames)
  const businessTypes = { 1: '社保', 2: '公积金' }
  return findRecordArray(payload, ['addrName', 'businessType', 'custId', 'robotStatusName', 'paySystemName'])
    .map((record, index) => ({
      id: `server-${serverIndex}-pay-fee-${toText(record.id) || index}`,
      isPayFeeTask: true,
      analysisSourceKey:analysisSourceKey(server),
      clientId: record.clientId, addrId:record.addrId, businessType:record.businessType, addrName:record.addrName,
      baseServer: normalizeBaseServer(server.baseServer),
      appName: `${toText(record.addrName)}-${businessTypes[toText(record.businessType)] || ''}`,
      customerName: customerNames.get(toText(record.custId)) || toText(record.custId),
      customerId: toText(record.custId),
      accountNumber: toText(record.accountNumber),
      taskStatus: toText(record.robotStatusName),
      execCount: executionCount(record),
      appCode: toText(record.appCode),
      taskCode:toText(record.taskCode),machineCode:toText(record.machineCode),flowCode:toText(record.flowCode),
      taskDetails: [{ name: '缴费', count: 1 }],
      noDeclaredCount: 1,
      auditCount: 0,
      remark: toText(record.paySystemName)
    }))
    .filter(row => allowedAppNames.has(row.appName))
}

function compareUndeclaredRows(left, right) {
  const leftSocialSecurity = toText(left.appName).includes('社保')
  const rightSocialSecurity = toText(right.appName).includes('社保')
  return Number(rightSocialSecurity) - Number(leftSocialSecurity) ||
    toNumber(right.noDeclaredCount) - toNumber(left.noDeclaredCount)
}

function serviceItemTasks(payload) {
  return findRecordArray(payload, ['serviceItemName', 'noDeclaredCount'])
    .filter(item => toText(item.serviceItemName) && toNumber(item.noDeclaredCount) > 0)
    .map(item => ({ name: toText(item.serviceItemName), count: toNumber(item.noDeclaredCount),...(item.serviceItem!=null?{serviceItem:item.serviceItem}:{}) }))
}

function loginTypeRemarks(payload) {
  const parts = []
  function visit(value) {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value.args)) {
      for (const arg of value.args) {
        if (arg && /LoginType$/.test(toText(arg.argsKey)) && toText(arg.fieldName) &&
          !/税务(?:系统)?登录方式/.test(toText(arg.fieldName)) && toText(arg.argsValue)) {
          parts.push(`${toText(arg.fieldName)}：${toText(arg.argsValue)}`)
        }
      }
    }
    for (const key of ['data', 'rows', 'list', 'content', 'result', 'records']) if (value[key]) visit(value[key])
  }
  visit(payload)
  return [...new Set(parts)].join('，')
}

async function enrichRemarks(rows, server, fetch = authenticatedRequest) {
  // 每轮刷新、每个平台账号独立缓存，最多四个请求并行。
  const cache = new Map()
  const get = (endpoint, format) => {
    if (!cache.has(endpoint)) cache.set(endpoint, fetch(server, endpoint).then(format))
    return cache.get(endpoint)
  }
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (next < rows.length) {
      const row = rows[next++]
      const parts = []
      if (row.appCode && row.taskCode && row.accNumber) {
        try {
          const details = await get('robot/app/client/showServiceItemFlow/' + [row.appCode, row.taskCode, row.accNumber].map(encodeURIComponent).join('/'), serviceItemTasks)
          row.taskDetails = details
        } catch (_) { parts.push('增减员数加载失败') }
      } else parts.push('增减员数缺少查询标识')
      if (row.taskCode) {
        try { parts.push(await get('robot/app/client/getRobotTaskConfigInfo/' + encodeURIComponent(row.taskCode), loginTypeRemarks)) }
        catch (_) { parts.push('登录方式加载失败') }
      } else parts.push('登录方式缺少任务编号')
      row.remark = parts.filter(Boolean).join('，')
    }
  }))
  return rows
}

async function fetchUndeclaredData(config) {
  const appNames = normalizeKeywords(config.keywords)
  const servers = Array.isArray(config.servers) ? config.servers : []
  const payFeeServers = Array.isArray(config.payFeeServers) ? config.payFeeServers : (config.paymentServers||[]).map(server=>({...server,authMode:'payment'}))
  if (!appNames.length) throw new Error('请至少添加一个监控应用')
  if (!servers.length&&!payFeeServers.length) throw new Error('请至少配置一个任务数据源')

  const rows = []
  const appCodes = new Map()
  const warnings = Array.isArray(config.paymentWarnings) ? [...config.paymentWarnings] : []
  let customerNames = new Map()
  const customerServer = servers.find(server =>
    [CUSTOMER_BASE_SERVER, `${CUSTOMER_BASE_SERVER}/api`].includes(normalizeBaseServer(server.baseServer)))
  try {
    if (!customerServer) throw new Error('请配置 nfstone 平台账号以读取客户名称')
    customerNames = await fetchCustomerNames(customerServer)
  } catch (error) {
    warnings.push(`${CUSTOMER_BASE_SERVER}（客户名称）：${error && error.message ? error.message : '请求失败'}`)
  }
  let successfulRequests = 0
  for (let index = 0; index < servers.length; index += 1) {
    const server = servers[index]
    const label = normalizeBaseServer(server.baseServer) || `第 ${index + 1} 个服务`
    try {
      const payload = await fetchClientList(server)
      const serverRows = normalizeRows(payload, server, index, appNames)
      for (const record of findRecordArray(payload, ['appName', 'appCode'])) {
        const appName = toText(record.appName)
        const appCode = toText(record.appCode)
        if (appName && appCode) appCodes.set(JSON.stringify([normalizeBaseServer(server.baseServer), appName]), appCode)
      }
      await enrichRemarks(serverRows, server)
      rows.push(...serverRows)
      successfulRequests += 1
    } catch (error) {
      warnings.push(`${label}：${error && error.message ? error.message : '请求失败'}`)
    }
  }
  for (let index = 0; index < payFeeServers.length; index += 1) {
    const server = payFeeServers[index]
    const label = normalizeBaseServer(server.baseServer) || `第 ${index + 1} 个平台`
    try {
      const payload = await fetchPayFeeList(server)
      const paymentRows = normalizePayFeeRows(payload, server, index, appNames, customerNames)
      for (const row of paymentRows) {
        if (!row.appCode) row.appCode = appCodes.get(JSON.stringify([row.baseServer, row.appName])) || ''
      }
      rows.push(...paymentRows)
      successfulRequests += 1
    } catch (error) {
      warnings.push(`${label}（缴费数据）：${error && error.message ? error.message : '请求失败'}`)
    }
  }
  if (!successfulRequests) throw new Error(warnings.join('\n'))
  rows.sort(compareUndeclaredRows)
  return { rows, warnings, updatedAt: new Date().toISOString() }
}

async function platformPaymentServers(platformService) {
  const servers = []
  const warnings = []
  let cachedCount = 0
  let platforms
  try { platforms = platformService.list() }
  catch (error) {
    return { servers, warnings: [`读取平台管理失败：${error && error.message ? error.message : '配置错误'}`] }
  }
  for (const platform of platforms) {
    if (platform.status === '未登录') continue
    cachedCount += 1
    try {
      const credentials = await platformService.authenticate(platform.id)
      if (!toText(credentials.url) || !toText(credentials.token)) throw new Error('平台管理缺少 URL 或 access_token')
      servers.push({ baseServer: credentials.url, accessToken: credentials.token })
    } catch (error) {
      warnings.push(`${platform.name}（缴费平台认证）：${error && error.message ? error.message : '认证失败'}`)
    }
  }
  if (!cachedCount) warnings.push('平台管理中暂无已登录平台，未加载缴费数据')
  return { servers, warnings }
}

module.exports = {
  analysisSourceKey,
  analysisAccessToken: async server => server.accessToken || await cachedLogin(server).entry.promise,
  authenticatedRequest,
  platformPaymentServers,
  previousOperateMonth,
  enrichRemarks,
  serviceItemTasks,
  loginTypeRemarks,
  refreshUndeclaredData,
  DEFAULT_BASE_SERVERS,
  buildApiUrl,
  compareUndeclaredRows,
  fetchUndeclaredData,
  findRecordArray,
  login,
  normalizeBaseServer,
  normalizeKeywords,
  normalizePayFeeRows,
  normalizeRows
}
