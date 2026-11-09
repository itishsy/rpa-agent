'use strict'
const http = require('node:http'), https = require('node:https')
// Read only file IDs discovered in the current task's execution detail.
async function readAnalysisImage(server, fileId, signal) {
  const { analysisAccessToken } = require('./undeclared-monitor')
  const token = await analysisAccessToken(server)
  const base = String(server.baseServer).replace(/\/+$/, '')
  const url = new URL((/\/api$/i.test(base) ? base : base + '/api') + '/policy/sys/file/download/' + encodeURIComponent(fileId))
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(url, { signal, timeout: 25000, headers: { Authorization: 'Bearer ' + token } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('截图接口不可用（HTTP ' + response.statusCode + '）')); return }
      const chunks = []; let bytes = 0
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 5 * 1024 * 1024) req.destroy(new Error('截图超过5MiB')); else chunks.push(chunk) })
      response.on('error', reject)
      response.on('end', () => {
        try {
        let data = Buffer.concat(chunks)
        let mime = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : data[0] === 255 && data[1] === 216 ? 'image/jpeg' : null
        if (!mime) return reject(new Error('附件不是可识别的PNG/JPEG截图'))
        const { nativeImage } = require('electron')
        if(nativeImage){
          let picture=nativeImage.createFromBuffer(data)
          if(picture.isEmpty())return reject(new Error('截图解码失败'))
          const size=picture.getSize(),ratio=Math.min(1,1536/Math.max(size.width,size.height))
          if(ratio<1)picture=picture.resize({width:Math.max(1,Math.round(size.width*ratio)),height:Math.max(1,Math.round(size.height*ratio))})
          data=picture.toJPEG(80);mime='image/jpeg'
        }
        if(data.length>800000)return reject(new Error('截图过大，未提交模型；请使用失败步骤的局部截图'))
        resolve('data:' + mime + ';base64,' + data.toString('base64'))
        } catch(error) { reject(new Error('截图处理失败：'+error.message)) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('截图读取超时'))); req.on('error', reject)
  })
}
module.exports = { readAnalysisImage }
