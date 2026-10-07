// MCP server assembly: registers every tool domain on one McpServer.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { runtimeContext } from './context'
import { registerArchiveTools } from './domains/archive'
import { registerBridgeTools } from './domains/bridge'
import { registerCalculatorsTools } from './domains/calculators'
import { registerConditionalsTools } from './domains/conditionals'
import { registerEquipmentTools } from './domains/equipment'
import { registerFormTools } from './domains/form'
import { registerImportTools } from './domains/imports'
import { registerJobsTools } from './domains/jobs'
import { registerOptimizerTools } from './domains/optimizer'
import { registerQueryTools } from './domains/query'
import { registerRelicTools } from './domains/relics'
import { registerScoringTools } from './domains/scoring'
import { registerShowcaseTools } from './domains/showcase'
import { registerSimulationTools } from './domains/simulation'
import { registerStateTools } from './domains/state'
import { registerTeamsTools } from './domains/teams'
import { registerGameResources } from './resources'

export const SERVER_INFO = {
  name: 'hsr-optimizer',
  version: '0.1.0',
} as const

export function createMcpServer(): McpServer {
  // One-time game metadata init before any tool can touch the stores
  runtimeContext.ensureMetadataReady()

  const server = new McpServer(SERVER_INFO)
  registerArchiveTools(server)
  registerBridgeTools(server)
  registerCalculatorsTools(server)
  registerConditionalsTools(server)
  registerEquipmentTools(server)
  registerFormTools(server)
  registerImportTools(server)
  registerJobsTools(server)
  registerOptimizerTools(server)
  registerQueryTools(server)
  registerRelicTools(server)
  registerScoringTools(server)
  registerShowcaseTools(server)
  registerSimulationTools(server)
  registerStateTools(server)
  registerTeamsTools(server)
  registerGameResources(server)
  return server
}
