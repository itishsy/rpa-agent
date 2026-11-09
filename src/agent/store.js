'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

const clone = value => JSON.parse(JSON.stringify(value))
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]))
  return value
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /password|passwd|token|secret|cookie|authorization|credential|身份证|手机号/i.test(key) ? '[REDACTED]' : redact(item)]))
  if (typeof value !== 'string') return value
  return value.replace(/(Bearer\s+)[\w.\-]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|password|secret|key)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/\b1[3-9]\d{9}\b/g, '[PHONE]').replace(/\b\d{17}[\dXx]\b/g, '[ID]')
}

class SessionStore {
  constructor(directory, codec) { this.directory = directory; this.codec = codec; fs.mkdirSync(directory, { recursive: true }) }
  file(id) {
    if (!/^[a-f\d-]{36}$/.test(id)) throw new Error('会话编号无效')
    return path.join(this.directory, id + '.session')
  }
  save(session) {
    const target = this.file(session.id)
    fs.writeFileSync(target + '.tmp', this.codec.encrypt(JSON.stringify(session)), { mode: 0o600 })
    fs.renameSync(target + '.tmp', target)
  }
  read(id, scope) {
    const session = JSON.parse(this.codec.decrypt(fs.readFileSync(this.file(id), 'utf8')))
    if (digest(session.scope) !== digest(scope)) throw new Error('会话不属于当前平台、账户、执行器或流程')
    return session
  }
  artifactFile(sessionId, artifactId) {
    this.file(sessionId); this.file(artifactId)
    const directory = path.join(this.directory, sessionId + '-artifacts')
    fs.mkdirSync(directory, { recursive: true })
    return path.join(directory, artifactId + '.enc')
  }
  writeArtifact(sessionId, artifactId, value) {
    const target = this.artifactFile(sessionId, artifactId)
    const text = JSON.stringify(value)
    fs.writeFileSync(target + '.tmp', this.codec.encrypt(text))
    fs.renameSync(target + '.tmp', target)
    return { external: true, bytes: Buffer.byteLength(text) }
  }
  readArtifact(sessionId, artifactId) {
    return JSON.parse(this.codec.decrypt(fs.readFileSync(this.artifactFile(sessionId, artifactId), 'utf8')))
  }
  deleteArtifact(sessionId, artifactId) {
    fs.rmSync(this.artifactFile(sessionId, artifactId), { force: true })
  }
  list(scope) {
    return fs.readdirSync(this.directory).filter(file => file.endsWith('.session')).flatMap(file => {
      try { const s = this.read(file.slice(0, -8), scope); return [{ id: s.id, title: s.title, state: s.state, updatedAt: s.updatedAt }] }
      catch (_) { return [] }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  unfinished() {
    return fs.readdirSync(this.directory).filter(file => /^[a-f\d-]{36}\.session$/.test(file)).flatMap(file => {
      // Corrupt checkpoints are an error, rather than silently losing an execution hold.
      const session = JSON.parse(this.codec.decrypt(fs.readFileSync(path.join(this.directory, file), 'utf8')))
      return ['running', 'waiting_approval', 'stopping'].includes(session.state) || session.executionUncertain ? [session] : []
    })
  }
  create(scope, dsl) {
    const session = { id: randomUUID(), scope: clone(scope), title: '新会话', state: 'idle', revision: 0,
      dsl: clone(dsl), proposal: null, rules: [], runs: [], plan: [], messages: [], events: [], artifacts: {},
      updatedAt: new Date().toISOString(), sequence: 0 }
    this.save(session)
    return session
  }
}
module.exports = { SessionStore, clone, digest, redact }
