'use strict'
const { randomBytes, timingSafeEqual } = require('node:crypto')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { createMcpExpressApp } = require('@modelcontextprotocol/sdk/server/express.js')

function createMcpBridge({ registry, invoke }) {
  const token = randomBytes(32).toString('hex')
  const app = createMcpExpressApp({ host: '127.0.0.1' })
  let server
  app.use('/mcp', (req, res, next) => {
    const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''))
    const expected = Buffer.from(token)
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.status(401).end('Unauthorized')
    next()
  })
  app.post('/mcp', async (req, res) => {
    const controller = new AbortController()
    const mcp = new McpServer({ name: 'rpa-agent', version: '1.0.0' })
    for (const tool of registry.tools.values()) mcp.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, async args => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await invoke(tool.name, args, controller.signal)) }] } }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] } }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.once('close', () => { controller.abort(); transport.close(); mcp.close() })
    try { await mcp.connect(transport); await transport.handleRequest(req, res, req.body) }
    catch (_) { if (!res.headersSent) res.status(500).end('MCP transport failed') }
  })
  app.get('/mcp', (_req, res) => res.status(405).end())
  app.delete('/mcp', (_req, res) => res.status(405).end())
  return {
    async start() {
      await new Promise((resolve, reject) => { server = app.listen(0, '127.0.0.1', resolve); server.once('error', reject) })
      return { enabled: true, url: `http://127.0.0.1:${server.address().port}/mcp`, bearerToken: token }
    },
    async stop() { if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
  }
}
module.exports = { createMcpBridge }
