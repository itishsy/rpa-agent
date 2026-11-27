'use strict'

function requestedRecording(request) {
  const text = String(request || '')
  if (/(?:不要|不用|无需|禁止|取消|关闭|停止|不需要|不)\s*(?:开启|启动|进行)?\s*(?:录屏|录像)/u.test(text)) return { enabled: false }
  if (/(?:启动|开启|开始|打开|启用|进行|使用|需要|要求|请)\s*(?:桌面)?(?:录屏|录像)|(?:录屏|录像)\s*(?:运行|执行|调试)|(?:运行|执行|调试)(?:时|并|同时)\s*(?:录屏|录像)|(?:录制|录下)\s*(?:本次|整个|当前)?\s*(?:运行|执行|调试|流程|过程|桌面)/u.test(text)) {
    return { enabled: true, fps: 2, maxDurationSeconds: 180 }
  }
}

function recordingSummary(recording) {
  if (!recording) return undefined
  const { base64, frames, ...metadata } = recording
  return { ...metadata, frameCount: frames?.length || 0 }
}

function recordingFrame(recording, frameIndex) {
  if (recording?.contentType !== 'video/x-msvideo' || typeof recording.base64 !== 'string') throw new Error('本次执行没有可读取的录像')
  const frame = recording.frames?.[frameIndex]
  if (!frame || !Number.isSafeInteger(frame.offset) || !Number.isSafeInteger(frame.length) || frame.offset < 0 || frame.length <= 0) {
    throw new Error('录像画面编号无效')
  }
  const bytes = Buffer.from(recording.base64, 'base64')
  if (frame.offset + frame.length > bytes.length) throw new Error('录像画面数据不完整')
  const jpeg = bytes.subarray(frame.offset, frame.offset + frame.length)
  if (jpeg[0] !== 255 || jpeg[1] !== 216) throw new Error('录像画面格式无效')
  return { ...frame, frameIndex, contentType: 'image/jpeg', base64: jpeg.toString('base64') }
}

module.exports = { requestedRecording, recordingSummary, recordingFrame }
