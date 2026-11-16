'use strict'
;(function(root) {
  function looksLikeHtml(text) {
    return /<!doctype\s+html\b|<html\b|<body\b/i.test(text) || (text.match(/<\/?(?:div|form|input|button|select|option|textarea|table|tr|td|span|a|p|section|label|ul|li|h[1-6])\b[^>]*>/gi) || []).length >= 3
  }
  function extractHtml(value) {
    const parts = []
    let text = String(value || '').replace(/```(?:html?)\s*\r?\n([\s\S]*?)```/gi, (block, html) => {
      if (!looksLikeHtml(html)) return block
      parts.push(html); return '\n'
    })
    if (!parts.length && looksLikeHtml(text)) {
      const documentStart = text.search(/<!doctype\s+html\b|<html\b|<body\b/i)
      const tagStart = text.search(/<(?:div|form|input|button|select|table|section|span|label|ul|p)\b/i)
      const begin = documentStart >= 0 ? documentStart : tagStart
      if (begin >= 0) {
        const ends = [...text.matchAll(/<\/(?:html|body)\s*>/gi)]
        const end = ends.length ? ends.at(-1).index + ends.at(-1)[0].length : text.lastIndexOf('>') + 1
        if (end > begin) { parts.push(text.slice(begin, end)); text = text.slice(0, begin) + '\n' + text.slice(end) }
      }
    }
    return { text: text.trim(), parts }
  }
  const api = { looksLikeHtml, extractHtml }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.htmlInput = api
})(typeof window === 'object' ? window : globalThis)
