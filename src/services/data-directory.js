'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { atomicWriteFileSync } = require('./atomic-file')

function configuredDataDirectory(marker, fallback, legacyMarker) {
  const selected = fs.existsSync(marker) ? marker : legacyMarker && fs.existsSync(legacyMarker) ? legacyMarker : null
  if (!selected) return fallback
  const value = JSON.parse(fs.readFileSync(selected, 'utf8')).directory
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('启动配置中的数据目录无效：' + selected)
  return value
}
function verifyDataDirectory(directory) {
  const file = path.join(directory, '.rpa-settings-probe-' + randomUUID())
  try { atomicWriteFileSync(file, 'create'); atomicWriteFileSync(file, 'replace') }
  finally { try { fs.unlinkSync(file) } catch (_) {} }
}
function relocateDataDirectory(directory, target, marker) {
  target = path.resolve(target)
  if (target.toLowerCase() === path.resolve(directory).toLowerCase()) throw new Error('请选择不同的数据目录')
  verifyDataDirectory(target)
  const created = []
  try {
    // Keep the OSCrypt key with the encrypted settings across application restarts.
    for (const name of ['Local State', 'settings.enc', 'platform-accounts.json']) {
      const source = path.join(directory, name), destination = path.join(target, name)
      if (fs.existsSync(destination)) throw new Error('所选目录已有配置，请选择新的空目录，避免覆盖：' + destination)
      if (fs.existsSync(source)) { atomicWriteFileSync(destination, fs.readFileSync(source)); created.push(destination) }
    }
    atomicWriteFileSync(marker, JSON.stringify({ directory: target, previousDirectory: directory }))
    return { directory: target, previousDirectory: directory }
  } catch (error) {
    for (const file of created) { try { fs.unlinkSync(file) } catch (_) {} }
    throw error
  }
}

function prepareDataDirectory({ directory, marker, fallbackDirectories = [] }) {
  try { verifyDataDirectory(directory); return { directory } }
  catch (error) {
    for (const target of fallbackDirectories) {
      try { return relocateDataDirectory(directory, target, marker) }
      catch (_) { /* Preserve existing destination data and allow manual recovery. */ }
    }
    return { directory, error }
  }
}

async function recoverDataDirectory({ directory, marker, dialog, fallbackDirectories = [] }) {
  const prepared = prepareDataDirectory({ directory, marker, fallbackDirectories })
  if (!prepared.error) return prepared
  const error = prepared.error
  for (;;) {
    const answer = await dialog.showMessageBox({ type: 'error', title: '配置目录不可写',
      message: '当前程序无法保存配置，请选择新的数据目录。',
      detail: error.message + '\n配置将复制到新目录，原数据保留。缓存和历史证据随后迁移。',
      buttons: ['选择数据目录', '退出'], defaultId: 0, cancelId: 1 })
    if (answer.response !== 0) throw error
    const selection = await dialog.showOpenDialog({ title: '选择 rpa-agent 数据目录', properties: ['openDirectory', 'createDirectory'] })
    if (selection.canceled || !selection.filePaths[0]) continue
    try {
      return relocateDataDirectory(directory, selection.filePaths[0], marker)
    } catch (failure) {
      await dialog.showMessageBox({ type: 'error', title: '数据目录切换失败', message: failure.message })
    }
  }
}
module.exports = { configuredDataDirectory, prepareDataDirectory, recoverDataDirectory, verifyDataDirectory }
