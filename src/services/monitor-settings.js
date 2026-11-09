'use strict'
const { normalizeKeywords } = require('./undeclared-monitor')
function normalizedServer(value) {
  const url = new URL(String(value || '').trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('监控服务地址须为不含凭据或查询参数的 HTTP(S) 地址')
  return url.href.replace(/\/+$/, '')
}
function prepareMonitorSettings(current = {}, input = {}) {
  const paymentServers=input.paymentServers===undefined?current.paymentServers||[]:input.paymentServers
  const payments=prepareServers(current.paymentServers||[],paymentServers)
  return {...current,migrationWarnings:[],keywords:normalizeKeywords(input.keywords),servers:prepareServers(current.servers||[],input.servers),paymentServers:payments}
}
function prepareServers(previous,input){
  if (!Array.isArray(input) || input.length > 30) throw new Error('任务数据源配置必须为数组，每类最多30项')
  const keys = new Set()
  const servers = input.map(item => {
    const baseServer = normalizedServer(item.baseServer), username = String(item.username || '').trim()
    if (!username) throw new Error('请填写监控用户名')
    const key = JSON.stringify([baseServer, username])
    if (keys.has(key)) throw new Error('监控服务与账号不能重复')
    keys.add(key)
    const old = previous.find(server => normalizedServer(server.baseServer) === baseServer && server.username === username)
    const password = item.clearPassword ? '' : String(item.password || old?.password || '')
    return { baseServer, username, password }
  })
  return servers
}
function publicMonitorSettings(settings = {}) {
  const publicServers=items=>(items||[]).map(item=>({
    baseServer: item.baseServer, username: item.username, hasPassword: !!item.password
  }))
  return {keywords:normalizeKeywords(settings.keywords),servers:publicServers(settings.servers),paymentServers:publicServers(settings.paymentServers),migrationWarnings:settings.migrationWarnings||[]}
}
function migrateLegacyPayments(current={},records=[],decrypt){
  if(current.legacyPaymentsMigrated)return current
  const paymentServers=[...(current.paymentServers||[])],migrationWarnings=[...(current.migrationWarnings||[])]
  if(!Array.isArray(records)){records=[];migrationWarnings.push('旧平台账户格式异常，请重新填写缴费任务数据源。')}
  for(const record of records){
    if(!record?.url||!record.username)continue
    let baseServer
    try{baseServer=normalizedServer(record.url)}catch(_){migrationWarnings.push('已跳过地址无效的旧账户，请检查缴费任务数据源。');continue}
    const username=String(record.username).trim()
    if(paymentServers.some(item=>normalizedServer(item.baseServer)===baseServer&&item.username===username))continue
    let password=''
    try{password=record.passwordEncrypted?decrypt(record.passwordEncrypted):''}catch(_){migrationWarnings.push('部分旧账户密码无法读取，请重新填写缴费任务数据源密码。')}
    paymentServers.push({baseServer,username,password})
  }
  return {...current,paymentServers,migrationWarnings:[...new Set(migrationWarnings)],legacyPaymentsMigrated:true}
}
module.exports = { prepareMonitorSettings, publicMonitorSettings, normalizedServer, migrateLegacyPayments }
