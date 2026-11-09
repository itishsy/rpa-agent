'use strict'
let appearanceSequence=0
function applyAppearance(value) {
  const root=document.documentElement
  root.dataset.theme=value.resolvedTheme;root.dataset.accent=value.accent;root.dataset.density=value.density
  window.appearanceState=value
  document.dispatchEvent(new CustomEvent('appearance-applied',{detail:value}))
}
desktop.on('appearance:changed',value=>{appearanceSequence++;applyAppearance(value)})
const appearanceRequest=appearanceSequence
desktop.invoke('appearance:get').then(value=>{if(appearanceRequest===appearanceSequence)applyAppearance(value)}).catch(error=>{console.error('外观设置加载失败：'+error.message)})
