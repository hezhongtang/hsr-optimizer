// MCP server assembly: registers the tool domains on one McpServer.
//
// Two environment switches shape what tools/list hands the client:
//   HSR_MCP_TOOLSETS          which toolsets to register (default: all of them)
//   HSR_MCP_NO_OUTPUT_SCHEMA  set to 1 to leave the output schemas out
// Neither changes what a registered tool does or returns.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { runtimeContext } from './context'
import { registerArchiveTools } from './domains/archive'
import { registerArtifactTools } from './domains/artifacts'
import { registerBridgeTools } from './domains/bridge'
import { registerCalculatorsTools } from './domains/calculators'
import { registerConditionalsTools } from './domains/conditionals'
import { registerDebugTools } from './domains/debug'
import { registerEquipmentTools } from './domains/equipment'
import { registerFormTools } from './domains/form'
import { registerImportTools } from './domains/imports'
import { registerJobsTools } from './domains/jobs'
import { registerLeaderboardTools } from './domains/leaderboard'
import { registerOptimizerTools } from './domains/optimizer'
import { registerPortraitTools } from './domains/portrait'
import { registerQueryTools } from './domains/query'
import { registerRelicTools } from './domains/relics'
import { registerRenderTools } from './domains/render'
import { registerRuntimeTools } from './domains/runtime'
import { registerScannerTools } from './domains/scanner'
import { registerScoringTools } from './domains/scoring'
import { registerShowcaseTools } from './domains/showcase'
import { registerSimulationTools } from './domains/simulation'
import { registerStateTools } from './domains/state'
import { registerTeamAuditTools } from './domains/teamAudit'
import { registerTeamsTools } from './domains/teams'
import { setLoopbackServerFactory } from './loopback'
import { registerGameResources } from './resources'

export const SERVER_INFO = {
  name: 'hsr-optimizer',
  version: '0.1.0',
} as const

const TOOLSETS = {
  archive: registerArchiveTools,
  artifacts: registerArtifactTools,
  bridge: registerBridgeTools,
  calculators: registerCalculatorsTools,
  conditionals: registerConditionalsTools,
  debug: registerDebugTools,
  equipment: registerEquipmentTools,
  form: registerFormTools,
  imports: registerImportTools,
  jobs: registerJobsTools,
  leaderboard: registerLeaderboardTools,
  optimizer: registerOptimizerTools,
  portrait: registerPortraitTools,
  query: registerQueryTools,
  relics: registerRelicTools,
  render: registerRenderTools,
  runtime: registerRuntimeTools,
  scanner: registerScannerTools,
  scoring: registerScoringTools,
  showcase: registerShowcaseTools,
  simulation: registerSimulationTools,
  state: registerStateTools,
  teamAudit: registerTeamAuditTools,
  teams: registerTeamsTools,
} satisfies Record<string, (server: McpServer) => void>

type Toolset = keyof typeof TOOLSETS

const ALL_TOOLSETS = Object.keys(TOOLSETS) as Toolset[]

// Registered whatever the selection says: most other toolsets work on a
// loaded save, and long runs hand back job ids.
const ALWAYS_ON: Toolset[] = ['archive', 'jobs']

/**
 * Reads HSR_MCP_TOOLSETS, a comma-separated list of toolset names. Plain names
 * register those toolsets plus the always-on ones; names that all start with
 * "-" register every toolset but those. Unset or empty registers everything.
 */
function selectToolsets(spec: string | undefined): Toolset[] {
  const entries = (spec ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  if (entries.length === 0) return ALL_TOOLSETS
  const rejected = (reason: string) => new Error(`HSR_MCP_TOOLSETS=${spec}: ${reason}。可用的工具集:${ALL_TOOLSETS.join(', ')}`)
  const excluding = entries[0].startsWith('-')
  if (entries.some((entry) => entry.startsWith('-') !== excluding)) {
    throw rejected('不能混用两种写法,要么只列要启用的工具集,要么每一项都以 - 开头列要排除的')
  }
  const names = entries.map((entry) => (excluding ? entry.slice(1).trim() : entry))
  if (names.includes('')) throw rejected('- 后面缺工具集名')
  const unknown = names.filter((name) => !Object.hasOwn(TOOLSETS, name))
  if (unknown.length > 0) throw rejected(`未知的工具集 ${unknown.join(', ')}`)
  if (!excluding) return ALL_TOOLSETS.filter((toolset) => ALWAYS_ON.includes(toolset) || names.includes(toolset))
  const alwaysOn = ALWAYS_ON.filter((toolset) => names.includes(toolset))
  if (alwaysOn.length > 0) throw rejected(`${alwaysOn.join(', ')} 始终注册,不能排除`)
  return ALL_TOOLSETS.filter((toolset) => !names.includes(toolset))
}

function buildServer(toolsets: Toolset[], outputSchemas: boolean): McpServer {
  // One-time game metadata init before any tool can touch the stores
  runtimeContext.ensureMetadataReady()

  const server = new McpServer(SERVER_INFO)
  if (!outputSchemas) {
    // A tool registered without an output schema is listed without one and
    // skips the SDK's check of its payload against it; its handler builds the
    // same structuredContent either way.
    const registerTool = server.registerTool.bind(server) as unknown as (name: string, config: object, callback: unknown) => unknown
    server.registerTool = ((name: string, config: object, callback: unknown) => {
      return registerTool(name, { ...config, outputSchema: undefined }, callback)
    }) as typeof server.registerTool
  }
  for (const toolset of toolsets) TOOLSETS[toolset](server)
  registerGameResources(server)
  return server
}

// Tools that compose other tools call them on a second instance of this
// server. It registers everything, whatever the client-facing instance lists.
setLoopbackServerFactory(() => buildServer(ALL_TOOLSETS, true))

export function createMcpServer(): McpServer {
  const toolsets = selectToolsets(process.env.HSR_MCP_TOOLSETS)
  const outputSchemas = process.env.HSR_MCP_NO_OUTPUT_SCHEMA !== '1'
  if (toolsets.length < ALL_TOOLSETS.length || !outputSchemas) {
    process.stderr.write(
      `[mcp] tools/list: ${toolsets.length} of ${ALL_TOOLSETS.length} toolsets (${toolsets.join(', ')}), output schemas ${outputSchemas ? 'on' : 'off'}\n`,
    )
  }
  return buildServer(toolsets, outputSchemas)
}
