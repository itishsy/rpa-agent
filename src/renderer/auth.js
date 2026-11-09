'use strict'
let authViewSequence=0,lastUserId=null
let rememberedPrefill=null,loginInputVersion=0
for(const id of ['userLoginName','userLoginServer'])$(id).addEventListener('input',()=>{
  loginInputVersion++
  if(rememberedPrefill&&($(id).value!==rememberedPrefill[id])){$('userLoginPassword').value='';rememberedPrefill=null}
})
$('userLoginPassword').addEventListener('input',()=>{rememberedPrefill=null;loginInputVersion++})
$('userLoginRemember').onchange=async()=>{
  if($('userLoginRemember').checked)return
  loginInputVersion++
  if(rememberedPrefill)$('userLoginPassword').value=''
  rememberedPrefill=null
  try{await invoke('auth:forget-password')}catch(error){$('userLoginMessage').textContent=loginError(error)}
}
$('applicationHeaderActions').append($('newApplication'),$('exportApplications'))
$('userMenuTrigger').onclick=()=>{
  if(!window.currentUser)return
  const menu=$('userMenu')
  if(menu.matches(':popover-open')){menu.hidePopover();return}
  menu.showPopover()
  const rect=$('userMenuTrigger').getBoundingClientRect(),size=menu.getBoundingClientRect()
  menu.style.left=Math.max(12,Math.min(rect.right+10,innerWidth-size.width-12))+'px';menu.style.top=Math.max(12,rect.bottom-size.height)+'px'
}
$('userMenu').addEventListener('toggle',()=>$('userMenuTrigger').setAttribute('aria-expanded',String($('userMenu').matches(':popover-open'))))
window.addEventListener('resize',()=>{if($('userMenu').matches(':popover-open'))$('userMenu').hidePopover()})
function loginError(error){return String(error?.message||error).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'')}
async function applyUser(user,loginState){
  if(user&&lastUserId===user.id&&window.currentUser?.id===user.id)return
  const sequence=++authViewSequence
  window.currentUser=user||null
  document.documentElement.dataset.authenticated=String(!!user)
  $('signedInUser').textContent=user?'当前用户：'+user.username:''
  $('signedInCompany').textContent=user?.customerName||'';$('signedInCompany').hidden=!user?.customerName
  $('userMenuTrigger').textContent=user?Array.from(user.username)[0].toUpperCase():'R';$('userMenuTrigger').disabled=!user
  if(!user&&$('userMenu').matches(':popover-open'))$('userMenu').hidePopover()
  lastUserId=user?.id||null
  document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close())
  $('businessFields').replaceChildren();$('dialogList').replaceChildren();$('dialogJson').value='';$('candidateDsl').textContent=''
  window.taskMonitor?.dispose?.();window.taskMonitor=null
  for(const host of ['monitorHost','taskSourceSettingsHost'])$(host).shadowRoot?.replaceChildren()
  connections=[];renderConnections()
  for(const field of ['modelApiKey','localDebugToken','modelBaseUrl','modelName'])$(field).value=''
  clearWorkspace();copied=null;managed.app=null;managed.rows=[];managed.completeFlows=[];managed.flows=[];managed.platformId='';managed.page=1;managed.appRequest++;managed.flowRequest++
  schemaCache.clear();renderApplicationTable([]);$('flowManagementTable').replaceChildren();$('request').value=''
  $('executorCards').replaceChildren()
  if(typeof renderOverview==='function')renderOverview()
  for(const id of ['timeline','plan','task','application','flow'])$(id).replaceChildren()
  window.platformConnected=false;document.documentElement.dataset.platformConnected='false'
  if(!user){
    $('userLoginPassword').value='';rememberedPrefill=null
    if($('userLoginSubmit').disabled)return
    const inputVersion=loginInputVersion,preferences=loginState||await invoke('auth:status')
    if(sequence!==authViewSequence||window.currentUser||$('userLoginSubmit').disabled||inputVersion!==loginInputVersion)return
    $('userLoginServer').value=preferences.baseUrl;$('userLoginName').value=preferences.username
    $('userLoginRemember').checked=!!preferences.rememberPassword
    $('userLoginPassword').value=preferences.rememberPassword?preferences.password||'':''
    if($('userLoginPassword').value)rememberedPrefill={userLoginName:preferences.username,userLoginServer:preferences.baseUrl}
    return
  }
  $('userLoginName').value=user.username;$('userLoginServer').value=user.baseUrl
  const bootstrapData=await bootstrap()
  if(sequence!==authViewSequence)return
  if(document.documentElement.dataset.windowMode==='design')await initializeDesignWindow(bootstrapData)
  else setView('home')
  notice('已登录：'+user.username+'。应用列表按当前用户权限读取。')
}
desktop.on('auth:changed',user=>{applyUser(user).catch(error=>{$('userLoginMessage').textContent=loginError(error)})})
$('userLoginForm').onsubmit=async event=>{
  event.preventDefault();if($('userLoginSubmit').disabled)return
  $('userLoginSubmit').disabled=true;$('userLoginMessage').textContent='正在登录并读取用户权限…'
  const input={username:$('userLoginName').value,password:$('userLoginPassword').value,baseUrl:$('userLoginServer').value,rememberPassword:$('userLoginRemember').checked}
  try{
    const user=await invoke('auth:login',input);await applyUser(user);$('userLoginMessage').textContent=''
  }catch(error){$('userLoginMessage').textContent=loginError(error)}
  finally{$('userLoginPassword').value='';$('userLoginSubmit').disabled=false}
}
$('userLogout').onclick=async()=>{
  if(!await confirmNavigation())return
  $('userLogout').disabled=true
  try{await invoke('auth:logout');await applyUser(null);$('userLoginMessage').textContent='已退出，请重新登录。'}
  catch(error){notice(loginError(error),true)}finally{$('userLogout').disabled=false}
}
const initialAuthSequence=authViewSequence
invoke('auth:status').then(async state=>{
  if(initialAuthSequence!==authViewSequence)return
  $('userLoginServer').value=state.baseUrl;$('userLoginName').value=state.username
  await applyUser(state.user,state)
}).catch(error=>{$('userLoginMessage').textContent=loginError(error)})
