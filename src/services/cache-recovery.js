'use strict'
const { verifyCacheDirectory, prepareDirectory, initializeCacheDirectory } = require('./cache-directory')

// Validate with this Electron process, not a shell running under another token.
async function recoverCacheDirectory({ state, settings, defaultDirectory, persist, dialog }) {
  for (;;) {
    try { await verifyCacheDirectory(state.directory); return state }
    catch (error) {
      const answer = await dialog.showMessageBox({ type: 'error', title: '缓存目录不可写',
        message: '当前程序无法写入缓存目录，请选择其他目录。',
        detail: error.message + '\n现有会话和执行证据将复制到新目录，原数据保留。',
        buttons: ['选择缓存目录', '退出'], defaultId: 0, cancelId: 1 })
      if (answer.response !== 0) throw new Error('缓存目录不可写，已取消启动。' + error.message)
      const selected = await dialog.showOpenDialog({ title: '选择可写缓存目录', properties: ['openDirectory', 'createDirectory'] })
      if (selected.canceled || !selected.filePaths[0]) continue
      const previous = { cacheDirectory: settings.cacheDirectory, cacheActiveDirectory: settings.cacheActiveDirectory }
      try {
        settings.cacheDirectory = await prepareDirectory(selected.filePaths[0], defaultDirectory, state.directory)
        settings.cacheActiveDirectory = state.directory
        const next = await initializeCacheDirectory(settings, defaultDirectory, persist)
        if (next.warning) throw new Error(next.warning)
        state = next
      } catch (failure) {
        Object.assign(settings, previous)
        await dialog.showMessageBox({ type: 'error', title: '缓存迁移未完成', message: failure.message })
      }
    }
  }
}
module.exports = { recoverCacheDirectory }
