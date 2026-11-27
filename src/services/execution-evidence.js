'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { atomicWriteFileSync } = require('./atomic-file')
const { digest, redact } = require('../agent-core/store')

const LIMIT = 5
const flowKey = ({ platformId, platformUrl, username, appCode, flowCode }) =>
  digest({ platformId, platformUrl, username, appCode, flowCode })
const newest = (a, b) => String(b.recordedAt || b.at || '').localeCompare(String(a.recordedAt || a.at || '')) ||
  (b.order || 0) - (a.order || 0)

function sanitizeResult(result) {
  const safe = redact(result)
  // PNG bytes are binary evidence encoded as text, not text to redact.
  if (Array.isArray(result.snapshots)) result.snapshots.forEach((snapshot, snapshotIndex) => {
    if (!Array.isArray(snapshot?.screenshots?.items)) return
    snapshot.screenshots.items.forEach((image, imageIndex) => {
      if (image?.contentType === 'image/png' && typeof image.base64 === 'string' && /^[A-Za-z0-9+/=]+$/.test(image.base64)) {
        safe.snapshots[snapshotIndex].screenshots.items[imageIndex].base64 = image.base64
      }
    })
  })
  return safe
}

class ExecutionEvidence {
  constructor(directory, codec, sessions) {
    this.directory = directory
    this.codec = codec
    this.sessions = sessions
  }
  folder(scope) { return path.join(this.directory, flowKey(scope)) }
  read(file) { return JSON.parse(this.codec.decrypt(fs.readFileSync(file, 'utf8'))) }
  write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    atomicWriteFileSync(file, this.codec.encrypt(JSON.stringify(value)))
  }
  payload(folder, id) {
    if (!/^[a-f\d-]{36}$/.test(id)) throw new Error('执行证据编号无效')
    return path.join(folder, id + '.enc')
  }
  metadata(run, scope) {
    return {
      id: run.artifactId, executionCode: run.result?.executionCode, at: run.result?.startedAt || run.at, recordedAt: run.at,
      taskCode: run.taskCode, executor: scope.executor, conclusion: run.conclusion,
      executionScope: run.executionScope, revision: run.revision
    }
  }
  list(scope) {
    const folder = this.folder(scope)
    const index = path.join(folder, 'index.enc')
    if (fs.existsSync(index)) return this.read(index)
    const legacy = [], key = flowKey(scope)
    for (const session of this.sessions.savedSessions()) {
      if (flowKey(session.scope) !== key) continue
      for (const run of session.runs || []) {
        if (run.artifactId && run.evidenceState !== 'deleted') legacy.push({ sessionId: session.id, artifact: session.artifacts?.[run.artifactId],
          entry: this.metadata(run, session.scope), result: run.result })
      }
    }
    legacy.sort((a, b) => newest(a.entry, b.entry))
    const entries = []
    for (const { sessionId, artifact, entry, result: summary } of legacy) {
      if (entries.some(item => item.id === entry.id)) continue
      let result = summary
      try {
        if (artifact) result = artifact.external ? this.sessions.readArtifact(sessionId, entry.id) : artifact
      } catch (error) {
        entry.warning = '原始证据读取失败：' + error.message
      }
      this.write(this.payload(folder, entry.id), { result, dsl: result?.dsl })
      entries.push(entry)
      if (entries.length === LIMIT) break
    }
    this.write(index, entries)
    return entries
  }
  record(scope, run, result, dsl) {
    const folder = this.folder(scope)
    const previous = this.list(scope)
    const entry = { ...this.metadata(run, scope), order: (Math.max(0, ...previous.map(item => item.order || 0)) + 1) }
    const entries = [entry, ...previous.filter(item => item.id !== entry.id)].sort(newest).slice(0, LIMIT)
    if (!entries.includes(entry)) return
    this.write(this.payload(folder, entry.id), { result: sanitizeResult(result), dsl: redact(dsl) })
    this.write(path.join(folder, 'index.enc'), entries)
    for (const old of previous) {
      if (!entries.some(item => item.id === old.id)) fs.rmSync(this.payload(folder, old.id), { force: true })
    }
  }
  get(scope, id) {
    if (!this.list(scope).some(entry => entry.id === id)) throw new Error('这次执行已不在当前流程的最近五次记录中')
    return this.read(this.payload(this.folder(scope), id))
  }
  remove(scope, id, activeSessions) {
    const folder = this.folder(scope)
    const file = this.payload(folder, id)
    const entries = this.list(scope)
    const key = flowKey(scope)
    // A record can also exist in the original session, including from an older app version.
    for (const saved of this.sessions.savedSessions()) {
      const session = activeSessions.get(saved.id) || saved
      if (flowKey(session.scope) !== key) continue
      const runs = (session.runs || []).filter(run => run.artifactId === id)
      const artifact = session.artifacts?.[id]
      if (!runs.length && !artifact) continue
      if (artifact?.external) this.sessions.deleteArtifact(session.id, id)
      delete session.artifacts[id]
      for (const run of runs) {
        run.evidenceState = 'deleted'
        delete run.evidenceArchiveError
      }
      for (const call of session.turn?.calls || []) {
        if (call.resultRecord?.artifactId === id) call.resultRecord.evidenceState = 'deleted'
      }
      for (const event of session.events || []) {
        if (event.data?.artifactId === id) delete event.data.artifactId
      }
      this.sessions.save(session)
    }
    fs.rmSync(file, { force: true })
    this.write(path.join(folder, 'index.enc'), entries.filter(entry => entry.id !== id))
  }
}

module.exports = { ExecutionEvidence }
