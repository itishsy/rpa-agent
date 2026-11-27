'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { atomicWriteFileSync } = require('./atomic-file')

const folders = ['sessions', 'execution-evidence', 'task-analysis', 'codex-runs']

async function verifyCacheDirectory(directory) {
  for (const folder of folders) {
    const target = path.join(directory, folder, '.rpa-agent-probe-' + randomUUID())
    try {
      atomicWriteFileSync(target, 'probe')
      atomicWriteFileSync(target, 'replacement')
    } finally { await fs.unlink(target).catch(() => {}) }
  }
}

function normalizeDirectory(value, defaultDirectory) {
  if (typeof value !== 'string') throw new Error('请填写缓存目录')
  const input = value.trim()
  if (!input) return path.resolve(defaultDirectory)
  if (!path.isAbsolute(input)) throw new Error('缓存目录必须为完整的绝对路径')
  return path.resolve(input)
}

function contains(parent, child) {
  const relative = path.relative(parent, child)
  return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

async function prepareDirectory(value, defaultDirectory, sourceDirectory) {
  const target = normalizeDirectory(value, defaultDirectory)
  await fs.mkdir(target, { recursive: true })
  const directory = await fs.realpath(target)
  const source = await fs.realpath(sourceDirectory)
  if (directory !== source) {
    for (const folder of folders) {
      const from = path.join(source, folder), to = path.join(directory, folder)
      if (contains(from, directory) || contains(to, source)) {
        throw new Error('缓存目录不能与现有缓存子目录重叠，请选择其他目录')
      }
    }
  }
  const probe = path.join(directory, '.rpa-agent-write-' + randomUUID())
  await fs.writeFile(probe, '', { flag: 'wx' })
  await fs.unlink(probe)
  await verifyCacheDirectory(directory)
  return directory
}

async function exists(file) {
  try { await fs.lstat(file); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

async function initializeCacheDirectory(settings, defaultDirectory, persist) {
  const source = path.resolve(settings.cacheActiveDirectory || defaultDirectory)
  const desired = normalizeDirectory(settings.cacheDirectory || '', defaultDirectory)
  if (path.relative(source, desired) === '') return { directory: source, warning: '' }
  let staging
  const swapped = []
  try {
    const target = await prepareDirectory(desired, defaultDirectory, source)
    if (path.relative(source, target) === '') return { directory: source, warning: '' }
    staging = await fs.mkdtemp(path.join(target, '.rpa-agent-migration-'))
    const incoming = path.join(staging, 'incoming'), backup = path.join(staging, 'previous')
    await fs.mkdir(incoming); await fs.mkdir(backup)
    for (const folder of folders) {
      const from = path.join(source, folder), to = path.join(incoming, folder)
      if (await exists(from)) {
        await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false,
          filter: async file => {
            if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('缓存中包含目录链接，请先确认数据位置')
            return true
          } })
      } else await fs.mkdir(to)
    }
    for (const folder of folders) {
      const destination = path.join(target, folder), previous = path.join(backup, folder)
      const hadPrevious = await exists(destination)
      if (hadPrevious) await fs.rename(destination, previous)
      const entry = { destination, previous, hadPrevious, installed: false }
      swapped.push(entry)
      await fs.rename(path.join(incoming, folder), destination)
      entry.installed = true
    }
    const previousActive = settings.cacheActiveDirectory
    settings.cacheActiveDirectory = target
    try { await persist() }
    catch (error) { settings.cacheActiveDirectory = previousActive; throw error }
    // Keep source data and any pre-existing destination data available for recovery.
    return { directory: target, warning: '' }
  } catch (error) {
    for (const entry of swapped.reverse()) {
      if (entry.installed) await fs.rename(entry.destination, path.join(staging, 'incoming', path.basename(entry.destination)))
      if (entry.hadPrevious) await fs.rename(entry.previous, entry.destination)
    }
    return { directory: source, warning: '缓存目录切换未完成，继续使用原目录。' + error.message }
  }
}

module.exports = { normalizeDirectory, prepareDirectory, initializeCacheDirectory, verifyCacheDirectory }
