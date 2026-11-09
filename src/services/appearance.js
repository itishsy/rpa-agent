'use strict'
const defaults = Object.freeze({ mode:'dark', accent:'blue', density:'comfortable' })
function validateAppearance(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('外观设置格式无效')
  const result={...defaults,...input}
  for(const [key,allowed] of Object.entries({mode:['dark','light','system'],accent:['blue','violet','green'],density:['comfortable','compact']})) {
    if(!allowed.includes(result[key]))throw new Error('不支持的外观选项：'+key)
  }
  return Object.fromEntries(Object.keys(defaults).map(key=>[key,result[key]]))
}
function appearanceSnapshot(input, systemDark) {
  const value=validateAppearance(input)
  return {...value,resolvedTheme:value.mode==='system'?(systemDark?'dark':'light'):value.mode}
}
module.exports={defaults,validateAppearance,appearanceSnapshot}
