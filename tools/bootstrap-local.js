'use strict'
// Optional offline bootstrap: copies only the dependency closure selected by this
// package from an existing npm installation. No runtime imports use that source.
const fs = require('node:fs')
const path = require('node:path')
const target = path.resolve(__dirname, '..')
const source = path.resolve(process.argv[2] || path.join(target, '..', 'rpa-ide'))
const manifest = require(path.join(target, 'package.json'))
const sourceLock = JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'), 'utf8'))
const packages = { '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies, devDependencies: manifest.devDependencies } }
function resolvePackage(from, name) {
  let current = from
  for (;;) {
    const candidate = (current ? current + '/' : '') + 'node_modules/' + name
    if (sourceLock.packages[candidate]) return candidate
    const index = current.lastIndexOf('/node_modules/')
    if (!current) break
    current = index < 0 ? '' : current.slice(0, index)
  }
  return null
}
function include(key) {
  if (packages[key]) return
  const entry = sourceLock.packages[key]
  packages[key] = entry
  for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
    const resolved = resolvePackage(key, name)
    if (resolved) include(resolved)
    else if (!entry.optionalDependencies?.[name]) throw new Error('Dependency missing: ' + name + ' from ' + key)
  }
  for (const name of Object.keys(entry.peerDependencies || {})) {
    const resolved = resolvePackage(key, name)
    if (resolved) include(resolved)
  }
}
for (const [name, expected] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
  const key = 'node_modules/' + name
  if (sourceLock.packages[key]?.version !== expected) throw new Error('Local version mismatch: ' + name)
  include(key)
}
for (const key of Object.keys(packages).filter(Boolean)) {
  const from = path.join(source, key), to = path.join(target, key)
  if (!fs.existsSync(from)) { if (packages[key].optional) continue; throw new Error('Missing package files: ' + key) }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true, filter: file => file === from || path.basename(file) !== 'node_modules' })
}
fs.writeFileSync(path.join(target, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages }, null, 2) + '\n')
// npm creates these on an online install. Provide the Windows entrypoints too.
const bin = path.join(target, 'node_modules', '.bin'); fs.mkdirSync(bin, { recursive: true })
for (const [name, script] of [['electron', '../electron/cli.js'], ['electron-builder', '../electron-builder/cli.js']]) {
  fs.writeFileSync(path.join(bin, name + '.cmd'), '@echo off\r\nnode "%~dp0' + script.replaceAll('/', '\\') + '" %*\r\n')
}
console.log('Prepared ' + (Object.keys(packages).length - 1) + ' locked packages from local installation.')
