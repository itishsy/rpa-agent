'use strict'
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
app.commandLine.appendSwitch('disable-features', 'TSFImeSupport')
app.setPath('userData', process.argv[2])
app.whenReady().then(() => {
  try {
    const text = safeStorage.decryptString(Buffer.from(fs.readFileSync(process.argv[3], 'utf8'), 'base64'))
    JSON.parse(text)
    console.log('DECRYPT_OK')
    app.exit(0)
  } catch (_) { console.log('DECRYPT_FAILED'); app.exit(1) }
})
