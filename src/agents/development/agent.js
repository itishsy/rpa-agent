'use strict'
const { AgentRunner, ExecutorLeases } = require('../../agent-core/runner')
const { developmentProfile } = require('./policy')

// The compatibility name is retained for the existing workspace and extensions.
class Harness extends AgentRunner {
  constructor(options) { super({...options,profile:developmentProfile}) }
}
module.exports = {Harness,ExecutorLeases}
