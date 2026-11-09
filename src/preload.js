'use strict'
const { contextBridge, ipcRenderer } = require('electron')
const filter = require('./services/undeclared-filter')
const channels = new Set(['app:bootstrap', 'app:panel', 'clipboard:write', 'clipboard:read', 'platforms:load', 'platforms:save', 'platform:select', 'platform:request',
  'app:confirm-navigation', 'business:action', 'business:export-applications', 'monitor:analyze', 'monitor:analysis-stop', 'monitor:open-flow', 'appearance:get', 'appearance:save', 'design:open', 'design:ready', 'design:connect', 'auth:status', 'auth:login', 'auth:logout', 'auth:forget-password',
  'settings:get', 'settings:save', 'executor:status', 'executor:control', 'executor:logs', 'workspace:open', 'workspace:attach', 'workspace:tasks', 'workspace:close', 'workspace:generate-flow', 'workspace:update', 'workspace:candidate',
  'workspace:save', 'workspace:run', 'workspace:recording-preview', 'workspace:paste-preview', 'workspace:argument-image', 'workspace:assertions', 'workspace:business-context', 'business-knowledge:import-rules', 'business-knowledge:archive', 'agent:start', 'agent:stop', 'agent:steer', 'agent:reconcile', 'agent:approve', 'agent:snapshot', 'agent:events', 'agent:artifact', 'mcp:control',
  'experience:import', 'experience:export', 'experience:collect', 'experience:stop', 'undeclared:get-settings', 'undeclared:save-settings', 'undeclared:refresh', 'undeclared:export', 'app:task-sources','monitor:takeover-options','monitor:takeover','takeover:diagnose','app:menu'])
contextBridge.exposeInMainWorld('desktop', {
  invoke(channel, ...args) { if (!channels.has(channel)) return Promise.reject(new Error('IPC channel denied')); return ipcRenderer.invoke(channel, ...args) },
  on(channel, callback) {
    if (!['monitor:analysis-progress', 'agent:event', 'app:settings', 'app:task-sources', 'app:view', 'app:navigate-flow', 'experience:progress', 'appearance:changed', 'auth:changed'].includes(channel)) throw new Error('Event channel denied')
    const listener = (_event, value) => callback(value)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  filter: { normalizeFilter: filter.normalizeFilter, filterRows: filter.filterRows, filterLabels: filter.filterLabels }
})
