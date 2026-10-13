// plan-refresh smoke: the command line that keeps a team plan's numbers current.
//
// Runs scripts/plan-refresh.mjs as a child process against copies of the sample
// save (CPU engine, locked strategy: no browser needed) and checks that
//   - the first run audits every team, stores one record per team and writes the report
//   - a second run on the same save audits nothing and rewrites nothing
//   - after a teammate's build changes in the save, --dry-run names exactly the
//     team that has that teammate and writes nothing; the real run re-audits
//     that team only and records what its numbers were before
//   - a changed plan entry makes its team stale whatever the save looks like
//   - --ignore-engine keeps a team whose only change is the engine build
//   - --all re-audits a team that is up to date
//   - a run that audits nothing still rewrites a report that no longer matches the plan
//   - the report states what a stored audit says when it has no result rows, when the
//     main ranking came from the free search, and when numbers are missing
//   - a team whose audit fails is reported, exits 2 and keeps its previous record;
//     the other records are left alone
//   - the save files are never written
// All fixtures and outputs stay in a temporary directory.
//
// Usage: node scripts/smoke-plan-refresh.mjs [serverEntry]
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  dirname,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

const mcpDir = dirname(dirname(fileURLToPath(import.meta.url)))
const serverEntry = process.argv[2] ?? 'dist/index.js'
const script = resolve(mcpDir, 'scripts/plan-refresh.mjs')
const coreId = '1212b1'
// Bronya: a teammate whose buffs move the core's damage.
const mateId = '1101'
const tempDir = mkdtempSync(`${tmpdir()}/hsr-mcp-smoke-plan-refresh-`)
const sample = JSON.parse(readFileSync(resolve(mcpDir, '../src/data/sample-save.json'), 'utf8'))

const write = (name, value) => {
  const path = `${tempDir}/${name}`
  writeFileSync(path, JSON.stringify(value))
  return path
}
const savePath = write('save.json', sample)
const saveBytes = readFileSync(savePath)

const mateChanged = structuredClone(sample)
const mate = mateChanged.characters.find((character) => character.id === mateId)
mate.form.lightConeSuperimposition = mate.form.lightConeSuperimposition === 5 ? 4 : 5
const mateChangedPath = write('save-mate-changed.json', mateChanged)
const mateChangedBytes = readFileSync(mateChangedPath)

const plan = {
  title: 'smoke plan',
  save: 'save.json',
  defaults: { engine: 'cpu', strategy: 'locked', targetPermutations: 5e5 },
  teams: [
    { key: 'solo', title: 'Solo', characterId: coreId },
    { key: 'duo', characterId: coreId, teammates: [{ characterId: mateId }] },
  ],
}
const planPath = write('plan.json', plan)
const stateDir = `${tempDir}/plan.audits`
const reportPath = `${stateDir}/report.md`

function run(...flags) {
  const result = spawnSync(process.execPath, [script, '--server', serverEntry, ...flags], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  let summary = null
  try {
    summary = JSON.parse(result.stdout)
  } catch {
    // A failed run prints no summary.
  }
  return { code: result.status, summary, stderr: result.stderr }
}
const teamOf = (summary, key) => summary.teams.find((team) => team.key === key)
const record = (key) => JSON.parse(readFileSync(`${stateDir}/${key}.json`, 'utf8'))
const stateBytes = () => Object.fromEntries(readdirSync(stateDir).sort().map((name) => [name, readFileSync(`${stateDir}/${name}`, 'utf8')]))

try {
  // ── first run ─────────────────────────────────────────────────────────────
  const first = run('--plan', planPath)
  assert.equal(first.code, 0, first.stderr)
  assert.deepEqual(first.summary.teams.map((team) => [team.key, team.outcome, team.reasons]), [['solo', 'audited', ['new']], ['duo', 'audited', ['new']]])
  assert.equal(first.summary.stateDir, stateDir)
  assert.equal(first.summary.report, reportPath)
  assert.equal(first.summary.reportRewritten, true)
  const solo = record('solo')
  const duo = record('duo')
  assert.equal(solo.audit.tool, 'team_audit')
  assert.equal(solo.audit.status, 'completed')
  assert.equal(solo.previous, null)
  assert.deepEqual(solo.request, { ...plan.defaults, characterId: coreId })
  assert.deepEqual(duo.request, { ...plan.defaults, characterId: coreId, teammates: [{ characterId: mateId }] })
  assert.deepEqual(duo.audit.roster.map((member) => member.characterId), [coreId, mateId])
  assert.equal(teamOf(first.summary, 'solo').comboBest, solo.audit.comboBest)
  assert.equal(teamOf(first.summary, 'duo').comboNow, duo.audit.comboNow)
  assert.notEqual(solo.audit.comboBest, duo.audit.comboBest)
  const report = readFileSync(reportPath, 'utf8')
  assert.match(report, /^# smoke plan · 数字刷新/)
  for (const audit of [solo.audit, duo.audit]) {
    assert.ok(report.includes(Math.round(audit.comboBest).toLocaleString('en-US')), 'the report carries each team\'s best COMBO')
  }
  assert.match(report, /## Solo\n/)
  assert.match(report, /## duo\n/)
  console.log('[PASS] the first run audits every team, stores a record per team and writes the report')

  // ── nothing changed ───────────────────────────────────────────────────────
  const before = stateBytes()
  const second = run('--plan', planPath)
  assert.equal(second.code, 0, second.stderr)
  assert.deepEqual(second.summary.teams.map((team) => [team.outcome, team.reasons]), [['kept', []], ['kept', []]])
  assert.equal(second.summary.reportRewritten, false)
  assert.deepEqual(stateBytes(), before)
  console.log('[PASS] a second run on an unchanged save audits nothing and rewrites nothing')

  // ── a teammate's build changed ────────────────────────────────────────────
  const dry = run('--plan', planPath, '--save', mateChangedPath, '--dry-run')
  assert.equal(dry.code, 0, dry.stderr)
  assert.equal(dry.summary.dryRun, true)
  assert.deepEqual(teamOf(dry.summary, 'solo').outcome, 'kept')
  assert.deepEqual([teamOf(dry.summary, 'duo').outcome, teamOf(dry.summary, 'duo').reasons], ['pending', ['rosterChanged']])
  assert.deepEqual(stateBytes(), before)
  console.log('[PASS] --dry-run names the team whose teammate changed and writes nothing')

  const refreshed = run('--plan', planPath, '--save', mateChangedPath)
  assert.equal(refreshed.code, 0, refreshed.stderr)
  assert.deepEqual(teamOf(refreshed.summary, 'solo').outcome, 'kept')
  assert.deepEqual([teamOf(refreshed.summary, 'duo').outcome, teamOf(refreshed.summary, 'duo').reasons], ['audited', ['rosterChanged']])
  assert.equal(stateBytes()['solo.json'], before['solo.json'])
  const duoAfter = record('duo')
  assert.deepEqual(duoAfter.previous, {
    auditedAt: duo.auditedAt,
    comboNow: duo.audit.comboNow,
    comboBest: duo.audit.comboBest,
    comboConflictFree: duo.audit.bestConflictFreeRow?.combo ?? null,
    scorePercent: duo.audit.score?.percent ?? null,
    scoreGrade: duo.audit.score?.grade ?? null,
  })
  assert.equal(duoAfter.audit.roster[1].lightConeSuperimposition, mate.form.lightConeSuperimposition)
  assert.match(readFileSync(reportPath, 'utf8'), /已刷新:成员的星魂\/光锥\/叠影变了/)
  // The other team is not stale against the changed save either: only its request decides.
  assert.deepEqual(run('--plan', planPath, '--save', mateChangedPath).summary.teams.map((team) => team.outcome), ['kept', 'kept'])
  console.log('[PASS] the real run re-audits that team only and records what its numbers were before')

  // ── the plan changed ──────────────────────────────────────────────────────
  const editedPlanPath = write('plan-edited.json', {
    ...plan,
    teams: [{ ...plan.teams[0], audit: { resultsLimit: 10 } }, plan.teams[1]],
  })
  const edited = run('--plan', editedPlanPath, '--state-dir', stateDir, '--save', mateChangedPath, '--dry-run')
  assert.equal(edited.code, 0, edited.stderr)
  assert.deepEqual(edited.summary.teams.map((team) => [team.outcome, team.reasons]), [['pending', ['planChanged']], ['kept', []]])
  console.log('[PASS] a changed plan entry makes its team stale')

  // ── engine build ──────────────────────────────────────────────────────────
  const otherEngineDir = `${tempDir}/other-engine.audits`
  const otherEngine = run('--plan', planPath, '--state-dir', otherEngineDir, '--only', 'solo')
  assert.equal(otherEngine.code, 0, otherEngine.stderr)
  assert.deepEqual(otherEngine.summary.teams.map((team) => [team.considered, team.outcome]), [[true, 'audited'], [false, 'kept']])
  assert.equal(existsSync(`${otherEngineDir}/duo.json`), false)
  const stored = JSON.parse(readFileSync(`${otherEngineDir}/solo.json`, 'utf8'))
  stored.audit.engine = { gitCommit: stored.audit.engine.gitCommit == null ? null : '0'.repeat(40), serverBuiltAt: '1970-01-01T00:00:00.000Z' }
  writeFileSync(`${otherEngineDir}/solo.json`, JSON.stringify(stored))
  const strict = run('--plan', planPath, '--state-dir', otherEngineDir, '--only', 'solo', '--dry-run')
  assert.deepEqual([teamOf(strict.summary, 'solo').outcome, teamOf(strict.summary, 'solo').reasons], ['pending', ['engineChanged']])
  const lenient = run('--plan', planPath, '--state-dir', otherEngineDir, '--only', 'solo', '--dry-run', '--ignore-engine')
  assert.deepEqual(
    [teamOf(lenient.summary, 'solo').outcome, teamOf(lenient.summary, 'solo').reasons, teamOf(lenient.summary, 'solo').ignoredReasons],
    ['kept', [], ['engineChanged']],
  )
  console.log('[PASS] --only limits the run to the named teams; an engine change is stale unless --ignore-engine')

  const forced = run('--plan', planPath, '--state-dir', otherEngineDir, '--only', 'solo', '--all', '--ignore-engine')
  assert.equal(forced.code, 0, forced.stderr)
  assert.deepEqual([teamOf(forced.summary, 'solo').outcome, teamOf(forced.summary, 'solo').reasons], ['audited', ['forced']])
  assert.equal(JSON.parse(readFileSync(`${otherEngineDir}/solo.json`, 'utf8')).previous.auditedAt, stored.auditedAt)
  console.log('[PASS] --all re-audits a team that is up to date and keeps its previous numbers for the deltas')

  // ── the report follows the plan and the records ───────────────────────────
  const retitledPlanPath = write('plan-retitled.json', { ...plan, title: 'renamed plan', teams: [plan.teams[1], { ...plan.teams[0], title: 'Solo again' }] })
  const recordsOnly = ({ 'report.md': _report, ...records }) => records
  const beforeRetitle = stateBytes()
  const retitled = run('--plan', retitledPlanPath, '--state-dir', stateDir, '--save', mateChangedPath)
  assert.equal(retitled.code, 0, retitled.stderr)
  assert.deepEqual(retitled.summary.teams.map((team) => [team.key, team.outcome]), [['duo', 'kept'], ['solo', 'kept']])
  assert.equal(retitled.summary.reportRewritten, true)
  assert.deepEqual(recordsOnly(stateBytes()), recordsOnly(beforeRetitle))
  const retitledReport = readFileSync(reportPath, 'utf8')
  assert.match(retitledReport, /^# renamed plan · 数字刷新/)
  assert.ok(retitledReport.indexOf('## duo\n') < retitledReport.indexOf('## Solo again\n'))
  assert.equal(run('--plan', retitledPlanPath, '--state-dir', stateDir, '--save', mateChangedPath).summary.reportRewritten, false)
  assert.equal(run('--plan', planPath, '--save', mateChangedPath).summary.reportRewritten, true)
  console.log('[PASS] a run that audits nothing rewrites the report when the plan\'s titles or order changed, and only then')

  // A team whose plan entry changed but is outside --only keeps its old audit, and the report says so.
  const outOfScope = run('--plan', editedPlanPath, '--state-dir', stateDir, '--save', mateChangedPath, '--only', 'duo')
  assert.equal(outOfScope.code, 0, outOfScope.stderr)
  assert.deepEqual(outOfScope.summary.teams.map((team) => team.outcome), ['kept', 'kept'])
  assert.equal(outOfScope.summary.reportRewritten, true)
  assert.match(readFileSync(reportPath, 'utf8'), /计划里这一队已改,不在本次范围/)
  assert.equal(run('--plan', planPath, '--save', mateChangedPath).summary.reportRewritten, true)
  assert.doesNotMatch(readFileSync(reportPath, 'utf8'), /不在本次范围/)
  console.log('[PASS] a plan change outside --only is reported as such, and the note goes once the plan matches again')

  // ── what the report says about an audit ───────────────────────────────────
  // The stored audit is edited into shapes a tiered audit can return; its
  // fingerprint, roster and engine stay, so the run keeps it and only renders.
  const renderDir = `${tempDir}/render.audits`
  assert.equal(run('--plan', planPath, '--state-dir', renderDir, '--only', 'solo').code, 0)
  const renderRecordPath = `${renderDir}/solo.json`
  const rendered = (edit) => {
    const state = JSON.parse(readFileSync(renderRecordPath, 'utf8'))
    edit(state.audit)
    writeFileSync(renderRecordPath, JSON.stringify(state))
    rmSync(`${renderDir}/report.md`)
    const result = run('--plan', planPath, '--state-dir', renderDir, '--only', 'solo')
    assert.equal(result.code, 0, result.stderr)
    assert.equal(teamOf(result.summary, 'solo').outcome, 'kept')
    const text = readFileSync(`${renderDir}/report.md`, 'utf8')
    assert.doesNotMatch(text, /undefined|NaN|null/)
    return text
  }
  const ranPass = { pass: 'leveled', minWeightedRolls: null, permutations: 1000, durationMs: 5, wallMs: 9, rowCount: 1 }
  const swap = { slot: 'Head', addRelicId: 'relic-a', addEnhance: 15, removeRelicId: 'relic-b', heldBy: null, needsLeveling: false }
  const noRows = rendered((audit) => {
    Object.assign(audit, { comboBest: null, zeroCostSwaps: [], swapSummary: null, bestConflictFreeRow: null })
  })
  assert.match(noRows, /搜索没有结果行/)
  assert.doesNotMatch(noRows, /已是库存最优/)
  const freeMain = rendered((audit) => {
    Object.assign(audit, {
      comboBest: audit.comboNow,
      zeroCostSwaps: [],
      swapSummary: { zeroCostSwaps: 0, contestedSwaps: 0, needsLevelingSwaps: 0 },
      // priority was estimated, found too large and never searched; free ran with a raised roll floor.
      passes: [
        { ...ranPass, variant: 'free', minWeightedRolls: 3, exhaustive: false },
        { pass: 'leveled', variant: 'priority', minWeightedRolls: null, exhaustive: true, permutations: 9e12, skipped: '超出第一遍预算' },
      ],
      bestConflictFreeRow: { combo: audit.comboNow, isCurrentBuild: false, deltaVsNow: null, swaps: [swap] },
      worthLeveling: {
        variants: {
          free: {
            guaranteed: [{
              slot: 'Head',
              relicId: 'relic-c',
              set: 'Some Set',
              mainStat: 'HP',
              replaces: { relicId: 'relic-b', rating: null },
              deltaVsLeveledBestPercent: 1.234,
              potentialAveragePercent: null,
              potentialBestPercent: null,
              heldBy: null,
            }],
            potential: [],
          },
          priority: { skipped: '该口径第一遍没有结果,无从比较' },
        },
      },
    })
  })
  assert.match(freeMain, /已是库存最优/)
  // The skipped priority pass says exhaustive; the label has to come from the free pass that ran.
  assert.match(freeMain, /未穷尽/)
  assert.doesNotMatch(freeMain, /已穷尽/)
  assert.match(freeMain, /较当前 —\)/)
  assert.match(freeMain, /\| Head \| relic-c\(Some Set · HP\) \| relic-b \| \+1\.23% \| — \/ — \| 无人 \|/)
  const exhausted = rendered((audit) => {
    audit.passes = [{ ...ranPass, variant: 'free', exhaustive: true }]
  })
  assert.match(exhausted, /已穷尽已强化遗器/)
  console.log('[PASS] the report states no result rows, the search the main ranking came from, and missing numbers as —')

  // ── failures ──────────────────────────────────────────────────────────────
  const brokenPlanPath = write('plan-broken.json', {
    ...plan,
    teams: [{ ...plan.teams[0], characterId: 'no-such-character' }, plan.teams[1], { key: 'ghost', characterId: 'no-such-character' }],
  })
  const kept = stateBytes()
  const broken = run('--plan', brokenPlanPath, '--state-dir', stateDir, '--save', mateChangedPath)
  assert.equal(broken.code, 2, broken.stderr)
  assert.deepEqual(broken.summary.teams.map((team) => [team.outcome, team.reasons]), [['failed', ['planChanged']], ['kept', []], ['failed', ['new']]])
  assert.match(teamOf(broken.summary, 'ghost').failure, /no-such-character/)
  assert.equal(existsSync(`${stateDir}/ghost.json`), false)
  // The team that had an audit keeps it, numbers and all.
  assert.deepEqual(recordsOnly(stateBytes()), recordsOnly(kept))
  assert.equal(teamOf(broken.summary, 'solo').comboBest, solo.audit.comboBest)
  const brokenReport = stateBytes()['report.md']
  assert.match(brokenReport, /刷新失败\(.*\),沿用上次审计/)
  assert.match(brokenReport, /刷新失败\(.*\),尚无审计/)

  // Once the plan is whole again nothing fails, and the report stops saying so.
  const recovered = run('--plan', planPath, '--save', mateChangedPath)
  assert.equal(recovered.code, 0, recovered.stderr)
  assert.deepEqual(recovered.summary.teams.map((team) => team.outcome), ['kept', 'kept'])
  assert.equal(recovered.summary.reportRewritten, true)
  assert.doesNotMatch(readFileSync(reportPath, 'utf8'), /刷新失败/)

  const refused = (pattern, ...flags) => {
    const result = run(...flags)
    assert.equal(result.code, 1)
    assert.match(result.stderr, pattern)
  }
  refused(/nobody/, '--plan', planPath, '--only', 'nobody')
  refused(/SOLO|solo/, '--plan', write('plan-dup.json', { teams: [plan.teams[0], { ...plan.teams[1], key: 'SOLO' }] }))
  refused(/--plan/)
  console.log('[PASS] a failing team is reported with exit code 2 and keeps its previous record; a bad plan or flag exits 1 and says why')

  assert.deepEqual(readFileSync(savePath), saveBytes)
  assert.deepEqual(readFileSync(mateChangedPath), mateChangedBytes)
  console.log('[PASS] the save files are byte-identical after every run')
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
console.log('smoke-plan-refresh: ALL CHECKS PASSED')
