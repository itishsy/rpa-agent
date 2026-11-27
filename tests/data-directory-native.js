'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')

if (process.versions.electron) {
  const { app, dialog } = require('electron')
  const fixture = JSON.parse(process.env.RPA_DATA_DIRECTORY_FIXTURE)
  delete process.env.RPA_AGENT_TEST_DATA
  delete process.env.RPA_AGENT_DATA_DIR
  delete process.env.RPA_AGENT_CACHE_DIR
  app.setPath('appData', fixture.source)
  app.setPath('home', fixture.home)
  const open = fs.openSync
  fs.openSync = (file, ...args) => {
    if (String(file).startsWith(fixture.source) && String(file).includes('.rpa-settings-probe-')) {
      throw Object.assign(new Error('Restricted application data directory'), { code: 'EPERM', syscall: 'open' })
    }
    return open(file, ...args)
  }
  dialog.showMessageBox = async options => { throw new Error('Unexpected startup dialog: ' + options.message) }
  const deadline = setTimeout(() => app.exit(1), 30000)
  app.on('browser-window-created', (_, window) => {
    window.webContents.once('did-finish-load', async () => {
      try {
        assert.equal(app.getPath('userData'), fixture.target)
        assert.equal(fs.readFileSync(path.join(fixture.target, 'sessions', 'retained.fixture'), 'utf8'), 'retained evidence')
        assert.equal(fs.readFileSync(path.join(fixture.source, 'rpa-agent-electron', 'sessions', 'retained.fixture'), 'utf8'), 'retained evidence')
        const state = await window.webContents.executeJavaScript('desktop.invoke("app:bootstrap")')
        assert.equal(state.connected, false)
        assert.ok(fs.existsSync(path.join(fixture.target, 'settings.enc')))
        console.log('Directory recovery opened the native window and saved configuration.')
        clearTimeout(deadline)
        app.exit(0)
      } catch (error) {
        console.error(error.stack)
        clearTimeout(deadline)
        app.exit(1)
      }
    })
  })
  require('../src/main')
} else {
  if (process.platform !== 'win32') throw new Error('This regression requires Windows Electron file access checks')
  const { spawnSync } = require('node:child_process')
  const root = path.resolve(__dirname, '..')
  const fixtureRoot = fs.mkdtempSync(path.join(root, 'artifacts', 'directory-recovery-'))
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-readonly-profile-'))
  const home = path.join(fixtureRoot, 'home')
  const target = path.join(home, 'AppData', 'LocalLow', 'rpa-agent-electron')
  const marker = path.join(target + '-startup', 'data-directory.json')
  fs.mkdirSync(path.join(source, 'rpa-agent-electron', 'sessions'), { recursive: true })
  fs.mkdirSync(path.dirname(marker), { recursive: true })
  fs.writeFileSync(marker, JSON.stringify({ directory: path.join(source, 'rpa-agent-electron') }))
  fs.writeFileSync(path.join(source, 'rpa-agent-electron', 'sessions', 'retained.fixture'), 'retained evidence')
  const env = { ...process.env, RPA_DATA_DIRECTORY_FIXTURE: JSON.stringify({ source, home, target }) }
  delete env.ELECTRON_RUN_AS_NODE
  for (let launch = 0; launch < 2; launch++) {
    const result = spawnSync(require('electron'), ['--no-sandbox', __filename], { cwd: root, env,
      windowsHide: true, encoding: 'utf8', timeout: 40000 })
    assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr)
    assert.equal(JSON.parse(fs.readFileSync(marker)).directory, target)
  }
  const resolvedSource = path.resolve(source)
  if (!resolvedSource.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected fixture cleanup path')
  fs.rmSync(resolvedSource, { recursive: true, force: true })
  console.log('Native data-directory recovery passed: initial migration, configuration save, history retention and restart.')
}
