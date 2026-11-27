'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { NOT_PERSISTED_MESSAGE, persistLoginPreferences } = require('../src/services/login-preferences')

test('login preferences persist remembered credentials only when saving succeeds', () => {
  const settings = { userLogin: { baseUrl: 'https://old', username: 'old' } }
  const result = persistLoginPreferences({
    settings, user: { baseUrl: 'https://new/api', username: 'alice' },
    rememberPassword: true, password: 'secret', save: () => {}
  })
  assert.deepEqual(result, { saved: true, warning: '' })
  assert.deepEqual(settings.userLogin, {
    baseUrl: 'https://new/api', username: 'alice', rememberPassword: true, password: 'secret'
  })
})

test('a failed preference write keeps the session usable and rolls back unsaved values', () => {
  const original = { baseUrl: 'https://old', username: 'old' }
  const settings = { userLogin: original }
  const failure = Object.assign(new Error('EPERM'), { code: 'EPERM' })
  const result = persistLoginPreferences({
    settings, user: { baseUrl: 'https://new/api', username: 'alice' },
    rememberPassword: false, password: 'secret', save: () => { throw failure }
  })
  assert.equal(result.saved, false)
  assert.equal(result.warning, NOT_PERSISTED_MESSAGE)
  assert.equal(result.error, failure)
  assert.equal(settings.userLogin, original)
})
