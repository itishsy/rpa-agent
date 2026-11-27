'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { codexEnvironment } = require('../src/services/codex/environment')
const { codexArguments } = require('../src/services/codex/arguments')

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-auth-env-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { root, cache: path.join(root, 'cache'), user: path.join(root, 'user') }
}

test('Codex uses the explicit login home and preserves provider credentials without copying auth files', async t => {
  const f = await fixture(t)
  const auth = path.join(f.root, 'chosen-login')
  const inherited = { Codex_Home: auth, CODEX_SQLITE_HOME: 'other-database', ELECTRON_RUN_AS_NODE: '1',
    OPENAI_API_KEY: 'test-key', PROVIDER_API_KEY: 'test-provider-key' }
  const before = structuredClone(inherited)
  const env = await codexEnvironment(f.cache, inherited, f.user)
  assert.equal(env.CODEX_HOME, auth)
  assert.equal(env.CODEX_SQLITE_HOME, path.join(f.cache, 'codex-runs', 'profile'))
  assert.equal(env.OPENAI_API_KEY, 'test-key')
  assert.equal(env.PROVIDER_API_KEY, 'test-provider-key')
  assert.equal(env.Codex_Home, undefined)
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
  assert.deepEqual(inherited, before)
  assert.deepEqual(await fs.readdir(env.CODEX_SQLITE_HOME), [])
})

test('the regular user login takes precedence over the older isolated profile', async t => {
  const f = await fixture(t)
  const home = path.join(f.user, '.codex')
  const legacy = path.join(f.cache, 'codex-runs', 'profile')
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(legacy, { recursive: true })
  await fs.writeFile(path.join(home, 'auth.json'), '{"test":"regular"}')
  await fs.writeFile(path.join(legacy, 'auth.json'), '{"test":"legacy"}')
  const env = await codexEnvironment(f.cache, {}, f.user)
  assert.equal(env.CODEX_HOME, home)
  assert.equal(await fs.readFile(path.join(home, 'auth.json'), 'utf8'), '{"test":"regular"}')
  assert.equal(await fs.readFile(path.join(legacy, 'auth.json'), 'utf8'), '{"test":"legacy"}')
})

test('previous isolated logins remain usable and an empty installation uses the normal Codex home', async t => {
  const f = await fixture(t)
  const initial = await codexEnvironment(f.cache, {}, f.user)
  assert.equal(initial.CODEX_HOME, path.join(f.user, '.codex'))
  const legacy = path.join(f.cache, 'codex-runs', 'profile')
  await fs.writeFile(path.join(legacy, 'auth.json'), '{"test":"legacy"}')
  assert.equal((await codexEnvironment(f.cache, {}, f.user)).CODEX_HOME, legacy)
  const explicit = path.join(f.root, 'explicit')
  assert.equal((await codexEnvironment(f.cache, { CODEX_HOME: explicit }, f.user)).CODEX_HOME, explicit)
})

test('the Codex invocation retains user provider configuration and explicit RPA tool settings', () => {
  const args = codexArguments({ options: { effort: 'medium', timeoutSeconds: 30 },
    connection: { url: 'http://localhost:1/mcp', tools: ['get_flow_context'] }, schemaFile: 'schema.json', reportFile: 'report.json' })
  assert.equal(args.includes('--ignore-user-config'), false)
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only')
  assert.ok(args.includes('features.apps=false'))
  assert.ok(args.includes('mcp_servers.rpa_agent.enabled_tools=["get_flow_context"]'))
})
