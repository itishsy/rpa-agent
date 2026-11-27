'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

async function codexEnvironment(cacheDirectory, baseEnv = process.env, userHome = os.homedir(), homeDirectory = '') {
  const profile = path.resolve(cacheDirectory, 'codex-runs', 'profile')
  await fs.mkdir(profile, { recursive: true, mode: 0o700 })
  const env = { ...baseEnv }
  const homeKey = Object.keys(env).find(name => name.toUpperCase() === 'CODEX_HOME')
  let home = homeKey && env[homeKey]?.trim() ? path.resolve(env[homeKey]) : path.join(userHome, '.codex')
  // Keep logins created by older RPA Agent versions usable when no default file login exists.
  if (!homeKey && !homeDirectory) {
    const exists = file => fs.access(file).then(() => true, () => false)
    if (!await exists(path.join(home, 'auth.json')) && await exists(path.join(profile, 'auth.json'))) home = profile
  }
  if (homeDirectory) home = path.resolve(homeDirectory)
  for (const name of Object.keys(env)) {
    if (['CODEX_HOME', 'CODEX_SQLITE_HOME', 'ELECTRON_RUN_AS_NODE'].includes(name.toUpperCase())) delete env[name]
  }
  return { ...env, CODEX_HOME: home, CODEX_SQLITE_HOME: profile }
}

async function prepareCodexEnvironment(cacheDirectory, homeDirectory) {
  const env = await codexEnvironment(cacheDirectory, process.env, os.homedir(), homeDirectory)
  if (process.platform !== 'win32') return env
  const directory = path.join(env.CODEX_HOME, 'tmp', 'arg0-windows')
  try {
    await fs.mkdir(directory, { recursive: true })
    const probe = await fs.mkdtemp(path.join(directory, 'rpa-probe-'))
    await fs.rmdir(probe)
  } catch (error) {
    if (!['EACCES', 'EPERM'].includes(error.code)) throw error
    throw new Error('Codex 无法写入启动目录 ' + directory + '。请在系统设置 → Agent 引擎中填写可写的 Codex 数据目录（例如 ' + path.join(env.CODEX_SQLITE_HOME, 'codex-home') + '），保存后检查登录状态。')
  }
  return env
}

module.exports = { codexEnvironment, prepareCodexEnvironment }
