'use strict'

function isProxyPath(value) {
  try {
    const pathname = new URL(String(value || '').trim()).pathname
    return pathname.split('/').some(segment => segment.toLowerCase() === 'virwin')
  } catch (_) {
    return /(?:^|\/)virwin(?:\/|$)/i.test(String(value || ''))
  }
}

module.exports = { isProxyPath }
