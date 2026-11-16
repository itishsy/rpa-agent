(function(root,factory){
  const api=factory()
  if(typeof module==='object'&&module.exports)module.exports=api
  else root.analysisSummary=api
})(typeof globalThis==='object'?globalThis:this,function(){
  function clean(text){
    return String(text||'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[*`]/g,'')
      .replace(/^\s*(?:#{1,6}\s*|[-+>]\s*|\d+[.)、]\s*)/gm,'').trim()
  }
  function summarize(reason){
    const lines=clean(reason).split(/\r?\n/).map(line=>line.trim()).filter(Boolean)
    const explicit=lines.findIndex(line=>/^(?:结论|诊断结论|诊断结论摘要|原因概述)[：:]/.test(line))
    const candidates=explicit>=0?lines.slice(explicit):lines
    const selected=[]
    for(const line of candidates){
      if(/^(?:依据|证据|处理建议|具体处理建议|建议|缺失证据|证据缺口|原因分类|停用原因)[：:]/.test(line))break
      const content=line.replace(/^(?:结论|诊断结论摘要|诊断结论|原因概述|未完成原因|一[、.]?\s*已确定的事实|确定事实|已确定的事实)[：:]?\s*/,'').trim()
      if(!content||/^(?:[一二三四五六七八九十][、.]?\s*)?(?:已确定的事实|确定事实|事实|未完成原因)$/.test(content))continue
      selected.push(content)
      if(/[。！？!?]/.test(content)||selected.length>=2)break
    }
    const text=selected.join(' ')||lines.find(line=>!/^原因分类[：:]/.test(line))||'分析结果已生成，请查看明细。'
    const sentences=text.match(/[^。！？!?]+[。！？!?]+|[^。！？!?]+$/g)||[text]
    const summary=sentences.slice(0,2).join('').trim()
    if(summary.length<=140)return summary
    const fragment=summary.slice(0,137)
    const boundary=Math.max(fragment.lastIndexOf('；'),fragment.lastIndexOf('，'))
    return (boundary>=60?fragment.slice(0,boundary):fragment).trimEnd()+'…'
  }
  return {summarize}
})
