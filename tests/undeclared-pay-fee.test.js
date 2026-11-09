const assert = require('node:assert/strict')
const { test } = require('node:test')
const http = require('node:http')
const { fetchUndeclaredData, previousOperateMonth, platformPaymentServers } = require('../src/services/undeclared-monitor')

test('pay fee records use fixed query, mapped columns and appNames filtering; sources fail independently', async t => {
  let failClient = false
  let failPayFee = false
  let failCustomers = false
  let customerBody
  let customerQueries = 0
  let payFeeBody
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    res.setHeader('Content-Type', 'application/json')
    if (req.url.startsWith('/api/oauth/token')) {
      res.end(JSON.stringify({ access_token: 'test-token' }))
      return
    }
    assert.equal(req.headers.authorization, 'Bearer test-token')
    if (req.url === '/api/robot/app/client/list') {
      res.statusCode = failClient ? 500 : 200
      res.end(JSON.stringify({ data: [{ id: 1, appName: '武汉-社保', noDeclaredCount: 3 }] }))
    } else if (req.url === '/api/policy/customer/payFee/page') {
      assert.equal(req.method, 'POST')
      payFeeBody = JSON.parse(body)
      res.statusCode = failPayFee ? 500 : 200
      res.end(JSON.stringify({ code: failPayFee ? 500 : 200, data: { records: [
        { id: 1, addrName: '武汉', businessType: 1, custId: 123, accountNumber: '00123', robotStatusName: '待缴费', paySystemName: '税务系统' },
        { id: 2, addrName: '武汉', businessType: '2', custId: 456, accountNumber: '00456', robotStatusName: '处理中', paySystemName: '公积金系统' },
        { id: 3, addrName: '北京', businessType: 1 },
        { id: 4, addrName: '武汉', businessType: 1, appName: '其他应用' }
      ] } }))
    } else if (req.url === '/api/policy/sys/customer/page') {
      customerQueries++
      assert.equal(req.method, 'POST')
      customerBody = JSON.parse(body)
      res.statusCode = failCustomers ? 500 : 200
      res.end(JSON.stringify({ data: { rows: [{ id: '123', name: '客户甲' }, { id: 456, name: '客户乙' }] } }))
    } else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const localServer = `http://127.0.0.1:${server.address().port}`
  const baseServer = 'https://rpa.internal.nfstone.com'
  t.mock.method(require('node:https'), 'request', (url, options, callback) => {
    assert.equal(url.origin, baseServer)
    return http.request(new URL(url.pathname + url.search, localServer), options, callback)
  })
  const config = { keywords: ['武汉-社保', '武汉-公积金'], servers: [{ baseServer, username: 'test', password: 'test' }], payFeeServers: [{ baseServer, accessToken: 'test-token' }] }
  const result = await fetchUndeclaredData(config)
  assert.deepEqual(customerBody, {
    page: 1, start: 0, size: 500,
    query: [{ property: 'searchText', value: '' }, { property: 'statuses', value: [] }],
    sidx: '', sort: ''
  })
  assert.deepEqual(payFeeBody, {
    page: 1, start: 0, size: 100,
    query: [
      { property: 'businessType', value: null }, { property: 'accountNumber', value: [] },
      { property: 'addrId', value: null }, { property: 'minOperateMonth', value: '' },
      { property: 'maxOperateMonth', value: '' }, { property: 'minCreateDate', value: '' },
      { property: 'maxCreateDate', value: '' }, { property: 'minPayDate', value: '' },
      { property: 'maxPayDate', value: '' }, { property: 'statuses', value: [] },
      { property: 'robotStatuses', value: [11, 21, 31, 25] }
    ], sidx: '', sort: ''
  })
  assert.equal(result.rows.length, 4)
  assert.deepEqual(result.warnings, [])
  assert.equal(new Set(result.rows.map(row => row.id)).size, 4)
  assert.deepEqual(result.rows.find(row => row.id === 'server-0-pay-fee-1'), {
    id: 'server-0-pay-fee-1', isPayFeeTask: true, analysisSourceKey:require('../src/services/undeclared-monitor').analysisSourceKey({baseServer}),clientId:undefined,addrId:undefined,businessType:1,addrName:'武汉',baseServer, appName: '武汉-社保', customerName: '客户甲', customerId: '123',
    accountNumber: '00123', taskStatus: '待缴费', execCount: null, appCode: '',taskCode:'',machineCode:'',flowCode:'', taskDetails: [{ name: '缴费', count: 1 }], noDeclaredCount: 1, auditCount: 0, remark: '税务系统'
  })
  assert.equal(result.rows.at(-1).appName, '武汉-公积金')
  assert.equal(result.rows.at(-1).customerName, '客户乙')
  const beforeShared = customerQueries
  const shared = await fetchUndeclaredData({ ...config, servers: [...config.servers, { ...config.servers[0], baseServer: localServer }], payFeeServers: [...config.payFeeServers, { baseServer: localServer, accessToken: 'test-token' }] })
  assert.equal(customerQueries - beforeShared, 1)
  assert.equal(shared.rows.length, 8)
  assert.equal(shared.rows.find(row => row.id === 'server-1-pay-fee-1').customerName, '客户甲')
  const beforeMissing = customerQueries
  const noNfstone = await fetchUndeclaredData({ ...config, servers: [{ ...config.servers[0], baseServer: localServer }], payFeeServers: [{ baseServer: localServer, accessToken: 'test-token' }] })
  assert.equal(customerQueries, beforeMissing)
  assert.equal(noNfstone.rows.find(row => row.id === 'server-0-pay-fee-1').customerName, '123')
  assert.match(noNfstone.warnings[0], /nfstone/)
  failCustomers = true
  const missingCustomers = await fetchUndeclaredData(config)
  assert.equal(missingCustomers.rows.length, 4)
  assert.equal(missingCustomers.rows.find(row => row.id === 'server-0-pay-fee-1').customerName, '123')
  assert.equal(missingCustomers.warnings.length, 1)
  assert.match(missingCustomers.warnings[0], /客户名称/)
  failCustomers = false
  failPayFee = true
  const clientOnly = await fetchUndeclaredData(config)
  assert.equal(clientOnly.rows.length, 1)
  assert.equal(clientOnly.warnings.length, 1)
  failPayFee = false
  failClient = true
  const payFeeOnly = await fetchUndeclaredData(config)
  assert.equal(payFeeOnly.rows.length, 3)
  assert.equal(payFeeOnly.warnings.length, 1)
  failPayFee = true
  await assert.rejects(fetchUndeclaredData(config))
})

test('payment records beyond the first page are included', async t => {
  const pages = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/robot/app/client/list') {
      res.end(JSON.stringify({ data: [] }))
    } else if (req.url === '/api/policy/customer/payFee/page') {
      const query = JSON.parse(body)
      pages.push([query.page, query.start, query.query.find(item => item.property === 'minOperateMonth').value])
      const offset = query.start
      const records = Array.from({ length: Math.min(105 - offset, 100) }, (_, index) => ({
        id: offset + index + 1, addrName: '武汉', businessType: 1,
        robotStatusName: '待缴费', accountNumber: String(offset + index + 1)
      }))
      res.end(JSON.stringify({ data: { total: 105, records } }))
    } else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const baseServer = `http://127.0.0.1:${server.address().port}`
  const result = await fetchUndeclaredData({
    keywords: ['武汉-社保'],
    servers: [{ baseServer, accessToken: 'test-token' }],
    payFeeServers: [{ baseServer, accessToken: 'test-token' }]
  })
  assert.deepEqual(pages, [[1, 0, ''], [2, 100, '']])
  assert.equal(result.rows.length, 105)
  assert.equal(result.rows.at(-1).id, 'server-0-pay-fee-105')
})

test('previous operate month handles year boundary', () => {
  assert.equal(previousOperateMonth(new Date(2026, 0, 13)), '2025-12')
  assert.equal(previousOperateMonth(new Date(2026, 9, 13)), '2026-09')
})

test('payment platforms use each cached platform token in order', async t => {
  const calls = []
  const platformService = {
    list: () => [
      { id: 'one', name: '平台一', status: '已缓存，使用前校验' },
      { id: 'missing', name: '未登录', status: '未登录' },
      { id: 'two', name: '平台二', status: '待校验 / 刷新' }
    ],
    authenticate: async id => {
      calls.push(id)
      return { url: `https://${id}.example.com/api`, token: `token-${id}` }
    }
  }
  const payment = await platformPaymentServers(platformService)
  assert.deepEqual(calls, ['one', 'two'])
  assert.deepEqual(payment.servers, [
    { baseServer: 'https://one.example.com/api', accessToken: 'token-one' },
    { baseServer: 'https://two.example.com/api', accessToken: 'token-two' }
  ])
  assert.deepEqual(payment.warnings, [])
})

test('pay fee requests use platform tokens instead of interface-setting credentials', async t => {
  let logins = 0
  const paymentTokens = []
  const server = http.createServer((req, res) => {
    req.resume()
    res.setHeader('Content-Type', 'application/json')
    if (req.url.startsWith('/api/oauth/token')) {
      logins++
      res.end(JSON.stringify({ access_token: 'interface-token' }))
    } else if (req.url === '/api/robot/app/client/list') {
      assert.equal(req.headers.authorization, 'Bearer interface-token')
      res.end(JSON.stringify({ data: [] }))
    } else if (req.url === '/api/policy/customer/payFee/page') {
      paymentTokens.push(req.headers.authorization)
      const id = paymentTokens.length
      res.end(JSON.stringify({ data: { records: [
        { id, addrName: '武汉', businessType: 1, custId: id, accountNumber: String(id), robotStatusName: '待缴费' }
      ] } }))
    } else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const baseServer = `http://127.0.0.1:${server.address().port}`
  const result = await fetchUndeclaredData({
    keywords: ['武汉-社保'],
    servers: [{ baseServer, username: 'interface', password: 'password' }],
    payFeeServers: [
      { baseServer, accessToken: 'platform-one' },
      { baseServer, accessToken: 'platform-two' }
    ]
  })
  assert.equal(logins, 1)
  assert.deepEqual(paymentTokens, ['Bearer platform-one', 'Bearer platform-two'])
  assert.equal(result.rows.length, 2)
})

test('payment query never falls back to interface settings credentials', async t => {
  const calls = []
  const server = http.createServer(async (req, res) => {
    calls.push(req.url)
    req.resume()
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/robot/app/client/list') {
      res.end(JSON.stringify({ data: [] }))
    } else if (req.url === '/api/policy/customer/payFee/page') {
      res.end(JSON.stringify({ data: { records: [] } }))
    } else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const baseServer = `http://127.0.0.1:${server.address().port}`
  await fetchUndeclaredData({
    keywords: ['武汉-社保'],
    servers: [{ baseServer, accessToken: 'interface-token' }]
  })
  assert.deepEqual(calls, ['/api/robot/app/client/list'])
})

test('one platform authentication failure does not prevent later payment queries', async () => {
  const payment = await platformPaymentServers({
    list: () => [
      { id: 'broken', name: '故障平台', status: '待校验 / 刷新' },
      { id: 'ready', name: '正常平台', status: '已缓存，使用前校验' }
    ],
    authenticate: async id => {
      if (id === 'broken') throw new Error('Token 失效')
      return { url: 'https://ready.example.com/api', token: 'ready-token' }
    }
  })
  assert.deepEqual(payment.servers, [{ baseServer: 'https://ready.example.com/api', accessToken: 'ready-token' }])
  assert.match(payment.warnings[0], /故障平台.*Token 失效/)
})

test('configured payment data source logs in independently without platform management and supports payment-only refresh',async t=>{
  let logins=0,payments=0
  const server=http.createServer(async(req,res)=>{
    req.resume();const url=new URL(req.url,'http://mock');res.setHeader('Content-Type','application/json')
    if(url.pathname==='/api/oauth/token'){
      logins++;assert.equal(url.searchParams.get('username'),'payment-user');assert.equal(url.searchParams.has('accData'),false)
      assert.equal(url.searchParams.get('password'),require('../src/services/platform-service').encryptLoginPassword('payment-password'))
      res.end(JSON.stringify({access_token:'configured-payment-token'}))
    }else if(url.pathname==='/api/policy/customer/payFee/page'){
      payments++;assert.equal(req.headers.authorization,'Bearer configured-payment-token');res.end(JSON.stringify({data:{records:[],total:0}}))
    }else{res.statusCode=404;res.end('{}')}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const config={keywords:['武汉-社保'],servers:[],paymentServers:[{baseServer:'http://127.0.0.1:'+server.address().port,username:'payment-user',password:'payment-password'}]}
  await fetchUndeclaredData(config);await fetchUndeclaredData(config)
  assert.equal(logins,1);assert.equal(payments,2)
})
