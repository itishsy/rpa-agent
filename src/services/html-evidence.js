'use strict'
// Serialized into the local renderer. DOMParser creates an inert document;
// nodes are never inserted into a live page and scripts are never evaluated.
function inspectHtmlDocument(html, options) {
  options = {...options,
    offset:Number.isSafeInteger(options?.offset)&&options.offset>=0?options.offset:0,
    limit:Number.isSafeInteger(options?.limit)&&options.limit>0?Math.min(options.limit,40):25}
  const doc = new DOMParser().parseFromString(html,'text/html')
  const title = doc.title
  doc.querySelectorAll('script,style,noscript').forEach(node=>node.remove())
  const literal = value => !value.includes("'") ? "'"+value+"'" : !value.includes('"') ? '"'+value+'"' : 'concat('+value.split("'").map(part=>"'"+part+"'").join(',"\'",')+')'
  const xpathOf = node => {
    const id=node.getAttribute('id')
    if(id&&!/\[(?:ID|PHONE|REDACTED)\]/.test(id)&&doc.querySelectorAll('#'+CSS.escape(id)).length===1)return '//*[@id='+literal(id)+']'
    const segments=[]
    for(let current=node;current?.nodeType===1;current=current.parentElement){
      const siblings=current.parentElement?[...current.parentElement.children].filter(item=>item.localName===current.localName):[current]
      segments.unshift(current.localName+'['+(siblings.indexOf(current)+1)+']')
    }
    return '/'+segments.join('/')
  }
  const compact=value=>String(value||'').replace(/\s+/g,' ').trim().slice(0,300)
  const nodes=[...doc.querySelectorAll(options.selector||'input,button,select,textarea,a,iframe,[role],[onclick]')]
  const keyword=String(options.keyword||'').toLowerCase()
  const filtered=keyword?nodes.filter(node=>[node.textContent,node.getAttribute('aria-label'),node.id,node.getAttribute('name'),node.getAttribute('placeholder')].some(value=>String(value||'').toLowerCase().includes(keyword))):nodes
  const elements=filtered.slice(options.offset,options.offset+options.limit).map(node=>{
    const xpath=xpathOf(node), labels=node.labels?[...node.labels].map(label=>compact(label.textContent)):[]
    return {tag:node.localName,text:node.localName==='input'?'':compact(node.textContent),labels,id:node.id||undefined,
      name:node.getAttribute('name'),type:node.getAttribute('type'),placeholder:node.getAttribute('placeholder'),ariaLabel:node.getAttribute('aria-label'),
      role:node.getAttribute('role'),href:node.getAttribute('href'),src:node.localName==='iframe'?node.getAttribute('src'):undefined,
      disabled:node.hasAttribute('disabled'),hidden:!!node.closest('[hidden],[aria-hidden="true"]'),visibility:'not_measured',
      xpath,xpathMatches:doc.evaluate(xpath,doc,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null).snapshotLength,
      ...(node.localName==='select'?{options:[...node.options].slice(0,30).map(item=>({label:compact(item.textContent),value:item.value})),optionCount:node.options.length}:{})}
  })
  return {scope:'provided_html',title,summary:compact(doc.body?.textContent),elements,total:filtered.length,
    offset:options.offset,limit:options.limit,maxLimit:40,
    nextOffset:options.offset+elements.length<filtered.length?options.offset+elements.length:null,
    note:'仅基于用户提供的HTML静态证据；未执行脚本、未访问页面、未验证动态状态及实际可见性，未读取输入框值。'}
}
module.exports={inspectHtmlDocument}
