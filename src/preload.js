'use strict'
const { contextBridge, ipcRenderer } = require('electron')
const filter = require('./services/undeclared-filter')
const { takeoverBlockReason } = require('./services/undeclared-monitor')
const channels = new Set(['app:bootstrap', 'app:panel', 'clipboard:write', 'clipboard:read', 'platforms:load', 'platforms:save', 'platform:select', 'platform:request',
  'workspace:delete-execution-evidence',
  'app:confirm-navigation', 'business:action', 'business:export-applications', 'monitor:analyze', 'monitor:analysis-stop', 'monitor:open-flow', 'appearance:get', 'appearance:save', 'design:open', 'design:ready', 'design:connect', 'auth:status', 'auth:login', 'auth:logout', 'auth:forget-password',
  'settings:get', 'settings:save', 'executor:status', 'executor:service-name', 'executor:control', 'executor:logs', 'workspace:open', 'workspace:attach', 'workspace:tasks', 'workspace:close', 'workspace:generate-flow', 'workspace:update', 'workspace:candidate', 'workspace:execution-evidence',
  'workspace:save', 'workspace:run', 'workspace:dsl', 'workspace:recording-preview', 'workspace:paste-preview', 'workspace:argument-image', 'workspace:attach-html', 'workspace:attach-file', 'agent:start', 'agent:stop', 'agent:steer', 'agent:reconcile', 'agent:approve', 'agent:snapshot', 'agent:events', 'agent:artifact', 'mcp:control',
  'undeclared:get-settings', 'undeclared:save-settings', 'undeclared:refresh', 'undeclared:export', 'app:task-sources','monitor:takeover-options','monitor:takeover','monitor:account-takeover','monitor:takeover-stats','takeover:diagnose','app:menu'])
contextBridge.exposeInMainWorld('desktop', {
  invoke(channel, ...args) { if (!channels.has(channel)) return Promise.reject(new Error('IPC channel denied')); return ipcRenderer.invoke(channel, ...args) },
  on(channel, callback) {
    if (!['monitor:analysis-progress', 'monitor:account-status', 'monitor:takeover-stats', 'agent:event', 'app:settings', 'app:task-sources', 'app:view', 'app:open-application', 'app:navigate-flow', 'appearance:changed', 'auth:changed', 'models:changed', 'application:released'].includes(channel)) throw new Error('Event channel denied')
    const listener = (_event, value) => callback(value)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  filter: { normalizeFilter: filter.normalizeFilter, filterRows: filter.filterRows, filterLabels: filter.filterLabels },
  takeoverBlockReason
})
