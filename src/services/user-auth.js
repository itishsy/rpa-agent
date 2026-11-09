'use strict'
const {createHash}=require('node:crypto')
const {normalizeUrl,requestForm,encryptLoginPassword}=require('./platform-service')
// Matches rpa-ide/public/index.html; this is the workbench service, not an
// executor platform selection. Credentials and tokens are never written here.
const DEFAULT_USER_API='https://rpa-front-staging.internal.nfstone.com/api'
function createUserAuth({request=requestForm,now=Date.now}={}) {
  let identity=null,pending=false,generation=0
  function status(){
    if(!identity)return null
    return {id:identity.id,username:identity.username,baseUrl:identity.url,customerName:identity.custName,
      expiresAt:identity.expiresAt,menus:identity.permissions.menus,tabs:identity.permissions.tabs,buttons:identity.permissions.buttons}
  }
  function requireIdentity(){
    if(!identity||identity.expiresAt&&identity.expiresAt<=now()){
      const error=new Error(identity?'登录已过期，请重新登录':'请先登录工作台');error.code=401;throw error
    }
    return identity
  }
  async function login(input={}){
    if(pending)throw new Error('正在登录，请稍候')
    const username=String(input.username||'').trim(),password=String(input.password||'')
    if(!username||!password)throw new Error('请输入用户名和密码')
    const url=normalizeUrl(input.baseUrl||DEFAULT_USER_API),version=++generation
    identity=null;pending=true
    try{
      const response=await request(url+'/oauth/token',{client_id:'rpa',client_secret:'123',grant_type:'password',username,password:encryptLoginPassword(password)},{query:true})
      const data=response?.data&&typeof response.data==='object'?response.data:response
      if(!data?.access_token||data.error||response?.code&&Number(response.code)!==200)throw new Error(data?.error_description||data?.message||data?.msg||'用户名或者密码错误')
      const menus=await request(url+'/sys/user/menu/listMenuByUser/1',{}, {headers:{Authorization:'Bearer '+data.access_token}})
      if(menus?.code&&Number(menus.code)!==200)throw new Error(menus.message||menus.msg||'读取用户权限失败，请重新登录')
      const permissions=menus?.data||menus||{}
      if(version!==generation)throw new Error('本次登录已取消')
      identity={id:'user-'+createHash('sha256').update(JSON.stringify([url,username])).digest('hex').slice(0,32),username,url,token:data.access_token,
        custId:data.custId,custName:String(data.custName||''),expiresAt:Number(data.expires_in)>0?now()+Number(data.expires_in)*1000:0,
        permissions:Object.fromEntries(['menus','tabs','buttons'].map(key=>[key,Array.isArray(permissions[key])?permissions[key]:[]]))}
      return status()
    }catch(error){
      if(error.status===401||error.status===400)throw new Error('用户名或者密码错误，或登录授权已失效')
      if(error.status===403)throw new Error('当前用户无权访问工作台')
      throw error
    }finally{pending=false}
  }
  return {login,status,requireIdentity,isCurrent:value=>identity===value,logout(){generation++;identity=null},get pending(){return pending}}
}
module.exports={createUserAuth,DEFAULT_USER_API}
