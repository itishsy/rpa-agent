'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

function isFile(file) {
  try { return fs.statSync(file).isFile() } catch (_) { return false }
}

function nativeFromWrapper(wrapper, processArch = process.arch) {
  const arch = processArch === 'arm64' ? 'arm64' : 'x64'
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const packageRoot = path.join(path.dirname(wrapper), 'node_modules', '@openai', 'codex')
  const platformName = 'codex-win32-' + arch
  const candidates = [
    path.join(packageRoot, 'node_modules', '@openai', platformName, 'vendor', triple, 'bin', 'codex.exe'),
    path.join(packageRoot, 'node_modules', '@openai', platformName, 'vendor', triple, 'codex', 'codex.exe'),
    path.join(packageRoot, 'vendor', triple, 'bin', 'codex.exe'),
    path.join(packageRoot, 'vendor', triple, 'codex', 'codex.exe')
  ]
  try {
    const requireFromCli = createRequire(path.join(packageRoot, 'package.json'))
    const platformPackage = requireFromCli.resolve('@openai/' + platformName + '/package.json')
    candidates.unshift(
      path.join(path.dirname(platformPackage), 'vendor', triple, 'bin', 'codex.exe'),
      path.join(path.dirname(platformPackage), 'vendor', triple, 'codex', 'codex.exe')
    )
  } catch (_) {}
  return candidates.find(isFile)
}

function versionedDesktopExecutables(binRoot) {
  try {
    return fs.readdirSync(binRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(binRoot, entry.name, 'codex.exe'))
      .filter(isFile)
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
  } catch (_) { return [] }
}

function automaticDirectories(env, platform) {
  const directories = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)
  if (platform !== 'win32') return directories
  if (env.LOCALAPPDATA) {
    directories.push(
      path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'),
      path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin')
    )
  }
  if (env.APPDATA) directories.push(path.join(env.APPDATA, 'npm'))
  return [...new Set(directories.map(directory => path.resolve(directory)))]
}

function desktopCandidates(env) {
  if (!env.LOCALAPPDATA) return []
  const binRoot = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
  return [
    ...versionedDesktopExecutables(binRoot),
    path.join(binRoot, 'codex.exe'),
    path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')
  ]
}

function resolveCodexExecutable(configured = '', options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const processArch = options.arch || process.arch
  const executable = configured.trim()
  const names = executable ? [executable] : platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.ps1'] : ['codex']
  const directories = automaticDirectories(env, platform)
  const pathDirectoryCount = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).length
  const searchDirectories = !executable && platform === 'win32' ? directories.slice(0, pathDirectoryCount) : directories
  for (const name of names) {
    const candidates = path.isAbsolute(name) ? [name] : searchDirectories.map(directory => path.join(directory, name))
    for (const candidate of candidates) {
      if (!isFile(candidate)) continue
      if (platform === 'win32' && /\.(cmd|ps1)$/i.test(candidate)) {
        const native = nativeFromWrapper(candidate, processArch)
        if (native) return native
        continue
      }
      return candidate
    }
  }
  if (!executable && platform === 'win32') {
    if (env.APPDATA) {
      for (const wrapperName of ['codex.cmd', 'codex.ps1']) {
        const wrapper = path.join(env.APPDATA, 'npm', wrapperName)
        if (!isFile(wrapper)) continue
        const native = nativeFromWrapper(wrapper, processArch)
        if (native) return native
      }
    }
    const desktop = desktopCandidates(env).find(isFile)
    if (desktop) return desktop
  }
  throw new Error('未找到 Codex CLI，请安装并登录 Codex，或在 Agent 引擎设置中指定 codex.exe 的完整路径')
}

module.exports = { resolveCodexExecutable }
