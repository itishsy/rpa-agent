'use strict'
const fs = require('node:fs')
const path = require('node:path')

function disableTsfIme(commandLine, platform = process.platform) {
  if (platform !== 'win32') return false
  const features = String(commandLine.getSwitchValue('disable-features') || '')
    .split(',').map(value => value.trim()).filter(Boolean)
  if (!features.includes('TSFImeSupport')) features.push('TSFImeSupport')
  commandLine.appendSwitch('disable-features', [...new Set(features)].join(','))
  return true
}

function createStartupRecorder(userDataDirectory, dependencies = {}) {
  const appendFileSync = dependencies.appendFileSync || fs.appendFileSync
  const mkdirSync = dependencies.mkdirSync || fs.mkdirSync
  const now = dependencies.now || (() => new Date())
  const logFile = path.join(userDataDirectory, 'startup.log')
  return message => {
    try {
      mkdirSync(userDataDirectory, { recursive: true })
      const text = String(message || '').replace(/\s+/g, ' ').slice(0, 2000)
      appendFileSync(logFile, `${now().toISOString()} ${text}\n`, 'utf8')
    } catch (_) {}
  }
}

function configureCrashReporter({ app, crashReporter, userDataDirectory, recordStartup, platform = process.platform }) {
  if (platform !== 'win32') return ''
  try {
    const crashDumps = path.join(userDataDirectory, 'crash-dumps')
    fs.mkdirSync(crashDumps, { recursive: true })
    app.setPath('crashDumps', crashDumps)
    crashReporter.start({ productName: 'rpa-agent', companyName: 'Seebon', submitURL: '', uploadToServer: false, compress: false })
    return crashDumps
  } catch (error) {
    recordStartup(`crash reporter disabled: ${error.message}`)
    return ''
  }
}

module.exports = { disableTsfIme, createStartupRecorder, configureCrashReporter }
