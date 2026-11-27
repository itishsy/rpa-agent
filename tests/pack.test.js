'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { outputDirectory } = require('../tools/pack')

test('pack wrapper finds custom and default Windows output directories', () => {
  const packageJson = { build: { directories: { output: 'release/default' } } }
  assert.equal(outputDirectory(['--config.directories.output=release/custom'], packageJson), 'release/custom')
  assert.equal(outputDirectory(['--config.directories.output', 'release/spaced'], packageJson), 'release/spaced')
  assert.equal(outputDirectory([], packageJson), 'release/default')
})
