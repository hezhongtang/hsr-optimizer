// Scoring serializers: reduce the upstream `SimulationScore` (dps_score) into
// a JSON-safe payload.
//
// The upstream object embeds `RunStatSimulationsResult`s whose
// `ComputedStatsContainer` / `xa: Float64Array` / `ca: Float32Array` and
// conditional-registry closures cannot survive JSON.stringify. This reducer
// keeps only scalar comparisons (simScore etc.) plus the pre-reduced upgrade
// tables (part / stat / percent / delta) and the teammate ornament upgrade
// summary (upstream `Set` instances are flattened to arrays).

import { getSimScoreGrade } from 'lib/scoring/dpsScore'
import type { SimulationScore } from 'lib/scoring/simScoringUtils'
import type { SimulationStatUpgrade } from 'lib/simulations/scoringUpgrades'
import type {
  Simulation,
  SimulationRequest,
} from 'lib/simulations/statSimulationTypes'
import type { TeammateSetUpgrade } from 'lib/simulations/teammateUpgradeGrouping'

export type SerializedUpgrade = {
  part?: string,
  stat?: string,
  /** New overall score percent (1.0 = benchmark level) after the upgrade */
  percent: number,
  /** simScore of the upgraded build */
  simScore: number,
  /** simScore delta vs the original build */
  delta: number,
  /** The build's sets / main stats the upgrade was simulated with */
  request: SerializedSimulationRequest,
}

export type SerializedTeammateUpgrade = {
  teammates: string[],
  set: string[],
  oldSet: string | null,
  simScore: number,
}

export type SerializedSimulationRequest = {
  relicSet1: string,
  relicSet2: string,
  ornamentSet: string,
  body: string,
  feet: string,
  planarSphere: string,
  linkRope: string,
  /** substat roll counts, e.g. { "CRIT DMG": 14, ... } */
  stats: Record<string, number>,
}

export type SerializedSimulationScore = {
  /** 1.0 = benchmark level, 2.0+ possible, negative possible for weak builds */
  percent: number,
  /** Letter grade on the web ladder (F…SS, WTF+, AEON for verified) */
  grade: string,
  scores: {
    original: number,
    baseline: number,
    benchmark: number,
    maximum: number,
  },
  originalSpd: number,
  benchmarkSpd: number | null,
  upgrades: {
    substats: SerializedUpgrade[],
    sets: SerializedUpgrade[],
    mains: SerializedUpgrade[],
    teammateOrnaments: SerializedTeammateUpgrade[],
  },
  benchmarkRequest: SerializedSimulationRequest | null,
  originalRequest: SerializedSimulationRequest | null,
  simulationFlags: {
    overcapCritRate: boolean,
    forceErrRope: boolean,
    benchmarkBasicSpdTarget: number,
  },
}

function serializeRequest(request: SimulationRequest): SerializedSimulationRequest {
  return {
    relicSet1: request.simRelicSet1,
    relicSet2: request.simRelicSet2,
    ornamentSet: request.simOrnamentSet,
    body: request.simBody,
    feet: request.simFeet,
    planarSphere: request.simPlanarSphere,
    linkRope: request.simLinkRope,
    stats: { ...request.stats },
  }
}

function simScoreOf(simulation: Simulation): number {
  return simulation.result?.simScore ?? 0
}

export function serializeUpgrade(
  upgrade: SimulationStatUpgrade,
  originalScore: number,
): SerializedUpgrade {
  const simScore = upgrade.simulationResult.simScore ?? simScoreOf(upgrade.simulation)
  return {
    ...(upgrade.part != null ? { part: upgrade.part } : {}),
    ...(upgrade.stat != null ? { stat: upgrade.stat } : {}),
    percent: upgrade.percent ?? 0,
    simScore,
    delta: simScore - originalScore,
    request: serializeRequest(upgrade.simulation.request),
  }
}

export function serializeTeammateUpgrade(upgrade: TeammateSetUpgrade): SerializedTeammateUpgrade {
  return {
    teammates: [...upgrade.ids],
    set: [...upgrade.set],
    oldSet: upgrade.oldSet ?? null,
    simScore: upgrade.simScore,
  }
}

/**
 * Reduce a fully executed `SimulationScore` (after executeOrchestrator +
 * executeUpgradeOrchestrator) to plain JSON data. `verified` / `numRelics` /
 * `hasLightCone` feed the letter grade exactly like the web showcase
 * (ShowcaseSimScore.tsx): AEON is only reachable when all 6 relics are
 * scanner-verified, and '?' is shown otherwise per getSimScoreGrade.
 */
export function serializeSimulationScore(
  score: SimulationScore,
  options: { verified: boolean, numRelics: number, hasLightCone: boolean },
): SerializedSimulationScore {
  return {
    percent: score.percent,
    grade: getSimScoreGrade(score.percent, options.verified, options.numRelics, options.hasLightCone),
    scores: {
      original: score.originalSimResult.simScore,
      baseline: score.baselineSimScore,
      benchmark: score.benchmarkSimScore,
      maximum: score.maximumSimScore,
    },
    originalSpd: score.originalSpd,
    benchmarkSpd: score.spdBenchmark ?? null,
    upgrades: {
      substats: score.substatUpgrades.map((u) => serializeUpgrade(u, score.originalSimScore)),
      sets: score.setUpgrades.map((u) => serializeUpgrade(u, score.originalSimScore)),
      mains: score.mainUpgrades.map((u) => serializeUpgrade(u, score.originalSimScore)),
      teammateOrnaments: score.teammateOrnamentUpgradeResults.map(serializeTeammateUpgrade),
    },
    benchmarkRequest: score.benchmarkSim?.request ? serializeRequest(score.benchmarkSim.request) : null,
    originalRequest: score.originalSim?.request ? serializeRequest(score.originalSim.request) : null,
    simulationFlags: {
      overcapCritRate: score.simulationFlags.overcapCritRate,
      forceErrRope: score.simulationFlags.forceErrRope,
      benchmarkBasicSpdTarget: score.simulationFlags.benchmarkBasicSpdTarget,
    },
  }
}
