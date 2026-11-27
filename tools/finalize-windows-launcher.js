'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function compilerPath(environment = process.env) {
  const windows = environment.WINDIR || environment.SystemRoot || 'C:\\Windows'
  const candidates = [
    path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windows, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ]
  return candidates.find(candidate => fs.existsSync(candidate)) || ''
}

function createShortcut(packageDirectory) {
  const source = path.join(__dirname, 'windows-launcher', 'Launch.ps1')
  const script = path.join(packageDirectory, 'Launch.ps1')
  const shortcut = path.join(packageDirectory, '启动 rpa-agent.lnk')
  const legacyScript = path.join(packageDirectory, 'Launch.vbs')
  if (fs.existsSync(legacyScript)) fs.rmSync(legacyScript, { force: true })
  fs.copyFileSync(source, script)
  const windows = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows'
  const powershell = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const escape = value => String(value).replace(/'/g, "''")
  const command = [
    "$w=New-Object -ComObject WScript.Shell",
    `$s=$w.CreateShortcut('${escape(shortcut)}')`,
    `$s.TargetPath='${escape(powershell)}'`,
    `$s.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${escape(script)}"'`,
    `$s.WorkingDirectory='${escape(packageDirectory)}'`,
    `$s.IconLocation='${escape(path.join(packageDirectory, 'rpa-agent-core.exe'))},0'`,
    "$s.Description='启动 rpa-agent'",
    "$s.Save()"
  ].join('; ')
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: packageDirectory, encoding: 'utf8', windowsHide: true
  })
  if (result.status !== 0 || !fs.existsSync(shortcut)) {
    throw new Error('桌面快捷方式生成失败：' + (result.error?.message || result.stderr || result.stdout || 'unknown error'))
  }
  return { script, shortcut }
}

function finalizePackage(packageDirectory, environment = process.env, options = {}) {
  if (process.platform !== 'win32') return { skipped: true, reason: 'not-windows' }
  const directory = path.resolve(packageDirectory)
  const executable = path.join(directory, 'rpa-agent.exe')
  const core = path.join(directory, 'rpa-agent-core.exe')
  if (!fs.existsSync(executable)) throw new Error('未找到待处理的 rpa-agent.exe：' + executable)
  const alreadyFinalized = fs.existsSync(core) && fs.statSync(executable).size < 1024 * 1024
  const shortcut = () => options.createShortcut === false ? {} : createShortcut(directory)
  if (alreadyFinalized && options.force !== true) {
    return { skipped: true, reason: 'already-finalized', executable, core, ...shortcut() }
  }

  const compiler = compilerPath(environment)
  if (!compiler) throw new Error('未找到 .NET Framework C# 编译器，无法生成安全启动器')
  const root = path.resolve(__dirname, '..')
  const source = path.join(__dirname, 'windows-launcher', 'Launcher.cs')
  const icon = path.join(root, 'src', 'assets', 'app.ico')
  const temporary = path.join(directory, '.rpa-agent-launcher.tmp.exe')
  try { fs.rmSync(temporary, { force: true }) } catch (_) {}
  const compiled = spawnSync(compiler, [
    '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
    '/out:' + temporary, '/win32icon:' + icon, source
  ], { cwd: root, encoding: 'utf8', windowsHide: true })
  if (compiled.status !== 0 || !fs.existsSync(temporary)) {
    throw new Error('启动器编译失败：' + (compiled.error?.message || compiled.stderr || compiled.stdout || 'unknown error'))
  }

  if (!alreadyFinalized) {
    if (fs.existsSync(core)) fs.rmSync(core, { force: true })
    fs.renameSync(executable, core)
  }
  try {
    if (alreadyFinalized) fs.rmSync(executable, { force: true })
    fs.renameSync(temporary, executable)
  } catch (error) {
    if (!alreadyFinalized) fs.renameSync(core, executable)
    try { fs.rmSync(temporary, { force: true }) } catch (_) {}
    throw error
  }
  return { skipped: false, executable, core, ...shortcut() }
}

if (require.main === module) {
  const argumentsList = process.argv.slice(2)
  const force = argumentsList.includes('--force')
  const packageDirectory = argumentsList.find(argument => !argument.startsWith('--')) ||
    process.env.RPA_AGENT_PACK_DIR || path.resolve(__dirname, '..', 'release', 'win-unpacked')
  const result = finalizePackage(packageDirectory, process.env, { force })
  console.log(result.skipped ? `Windows launcher skipped: ${result.reason}` : `Windows launcher created: ${result.executable}`)
}

module.exports = { compilerPath, createShortcut, finalizePackage }
