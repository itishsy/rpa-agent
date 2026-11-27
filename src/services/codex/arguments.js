'use strict'

function codexArguments({ options, connection, schemaFile, reportFile, images = [] }) {
  const args = ['exec', '--json', '--color', 'never', '--skip-git-repo-check', '--ephemeral',
    '--sandbox', 'read-only', '--output-schema', schemaFile,
    '--output-last-message', reportFile]
  const config = {
    'model_reasoning_effort': options.effort,
    'features.apps': false,
    'features.multi_agent': false,
    'web_search': 'disabled',
    'mcp_servers.rpa_agent.url': connection.url,
    'mcp_servers.rpa_agent.bearer_token_env_var': 'RPA_AGENT_MCP_TOKEN',
    'mcp_servers.rpa_agent.required': true,
    'mcp_servers.rpa_agent.enabled_tools': connection.tools,
    'mcp_servers.rpa_agent.default_tools_approval_mode': 'approve',
    'mcp_servers.rpa_agent.tool_timeout_sec': options.timeoutSeconds
  }
  for (const [key, value] of Object.entries(config)) args.push('-c', key + '=' + JSON.stringify(value))
  if (options.model) args.push('--model', options.model)
  for (const image of images) args.push('--image', image)
  args.push('-')
  return args
}

module.exports = { codexArguments }
