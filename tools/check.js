'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
let count = 0
function visit(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name)
    if (item.isDirectory()) visit(file)
    else if (file.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
      count++
    }
  }
}
visit(path.join(root, 'src')); visit(path.join(root, 'tests'))
const pkg = require(path.join(root, 'package.json'))
if (pkg.name !== 'rpa-agent' || Object.keys(pkg.dependencies).some(name => /vue|react|vite|webpack/i.test(name))) throw new Error('Unexpected framework dependency')
console.log('Syntax and framework-free package checks passed: ' + count + ' JavaScript files.')
