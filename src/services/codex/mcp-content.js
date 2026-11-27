'use strict'
const { recordingFrame } = require('../recording-evidence')

function imageContent(image) {
  if (!image || !['image/png', 'image/jpeg'].includes(image.mimeType) || !/^[A-Za-z0-9+/=]+$/.test(image.data || '')) return []
  return [{ type: 'image', mimeType: image.mimeType, data: image.data }]
}

function toolContent(name, args, output, { session, runner }) {
  const content = [{ type: 'text', text: JSON.stringify(output) }]
  if (name === 'read_artifact' && session.artifacts[args.artifactId]) {
    const file = runner.readArtifact(session, args.artifactId)
    if (file.kind === 'image_attachment') content.push(...imageContent({ mimeType: file.mimeType, data: file.content }))
  }
  if (name === 'inspect_step_evidence' && args.screenshot) {
    const run = session.runs[args.executionIndex || 0]
    const image = run && runner.readArtifact(session, run.artifactId).snapshots?.[args.snapshotIndex]?.screenshots?.items?.find(item => item.contentType === 'image/png')
    if (image) content.push(...imageContent({ mimeType: image.contentType, data: image.base64 }))
  }
  if (name === 'inspect_execution_recording' && args.frameIndex !== undefined) {
    const run = session.runs[args.executionIndex || 0]
    if (run) {
      const frame = recordingFrame(runner.readArtifact(session, run.artifactId).recording, args.frameIndex)
      content.push(...imageContent({ mimeType: frame.contentType, data: frame.base64 }))
    }
  }
  return { content }
}

module.exports = { toolContent }
