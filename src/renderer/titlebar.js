'use strict'
const titlebarMenus=[...document.querySelectorAll('[data-window-menu]')]
for(const [index,button] of titlebarMenus.entries()){
  button.onclick=async()=>{
    const rect=button.getBoundingClientRect();button.setAttribute('aria-expanded','true')
    try{await desktop.invoke('app:menu',{menu:button.dataset.windowMenu,x:rect.left,y:rect.bottom+2})}
    catch(error){notice(error.message,true)}
    finally{button.setAttribute('aria-expanded','false');if(document.hasFocus())button.focus()}
  }
  button.onkeydown=event=>{
    if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
      event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?titlebarMenus.length-1:(index+(event.key==='ArrowRight'?1:-1)+titlebarMenus.length)%titlebarMenus.length;titlebarMenus[next].focus()
    }else if(event.key==='ArrowDown'){event.preventDefault();button.click()}
  }
}
document.addEventListener('keydown',event=>{
  if(event.altKey&&!event.ctrlKey&&!event.shiftKey){const index=['f','e','v','h'].indexOf(event.key.toLowerCase());if(index>=0){event.preventDefault();titlebarMenus[index]?.click()}}
})
