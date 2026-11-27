'use strict'
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { finalizePackage } = require('./finalize-windows-launcher')

function outputDirectory(argumentsList, packageJson) {
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument.startsWith('--config.directories.output=')) {
      return argument.slice('--config.directories.output='.length)
    }
    if (argument === '--config.directories.output' && argumentsList[index + 1]) return argumentsList[index + 1]
  }
  return packageJson.build?.directories?.output || 'release'
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..')
  const packageJson = require(path.join(root, 'package.json'))
  const argumentsList = process.argv.slice(2)
  const builder = path.join(root, 'node_modules', 'electron-builder', 'cli.js')
  const built = spawnSync(process.execPath, [builder, '--dir', ...argumentsList], { cwd: root, stdio: 'inherit' })
  if (built.status !== 0) process.exit(built.status || 1)
  const packageDirectory = path.resolve(root, outputDirectory(argumentsList, packageJson), 'win-unpacked')
  const result = finalizePackage(packageDirectory)
  console.log(result.skipped ? `Windows launcher skipped: ${result.reason}` : `Windows launcher created: ${result.executable}`)
}

module.exports = { outputDirectory }
