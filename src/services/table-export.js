'use strict'
function applicationCsv(rows) {
  if (!Array.isArray(rows) || rows.length > 1000) throw new Error('应用导出数据无效')
  const columns = [['appName','应用名称'],['appCode','应用编码'],['flowCount','流程数'],['version','版本号'],['status','发布状态'],['releaseTime','发布时间'],['updateTime','更新时间'],['updateName','更新人'],['appRemark','备注'],['robotName','类型'],['province','所在省']]
  const cell = value => {
    let text = String(value ?? '')
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text
    return '"' + text.replaceAll('"','""') + '"'
  }
  return '\ufeff' + [columns.map(column=>cell(column[1])).join(','),...rows.map(row=>columns.map(column=>cell(row[column[0]])).join(','))].join('\r\n') + '\r\n'
}
module.exports = { applicationCsv }
