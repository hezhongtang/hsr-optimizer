// Throwaway spike: headless mirror of the Engine A scheduling loop (optimizer.ts:187-436), built only from upstream pure pieces.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

type EngineAOptions = { maxChunks?: number, freshContextPerChunk?: boolean, relicsOverride?: Any[] }

export async function runEngineA(characterId: string, mutate: (request: Any) => void, opts: EngineAOptions = {}) {
  const { computeLoadForm } = await import('lib/stores/optimizerForm/optimizerFormStoreActions')
  const { displayToInternal } = await import('lib/stores/optimizerForm/optimizerFormConversions')
  const { RelicFilters } = await import('lib/relics/relicFilters')
  const solver = await import('lib/optimization/relicSetSolver')
  const { bitpackBooleanArray } = await import('lib/optimization/setSolutionBitset')
  const { generateContext } = await import('lib/optimization/context/calculateContext')
  const { BufferPacker } = await import('lib/optimization/bufferPacker')
  const { FixedSizeMinQueue } = await import('lib/dataStructures/fixedSizeMinQueue')
  const { SortOption } = await import('lib/optimization/sortOptions')
  const { Constants } = await import('lib/constants/constants')
  const { optimizerWorker } = await import('lib/worker/optimizerWorker')
  const { getCharacterById, getCharacters } = await import('lib/stores/character/characterStore')
  const { getRelics } = await import('lib/stores/relic/relicStore')
  const { clone } = await import('lib/utils/objectUtils')

  const character = getCharacterById(characterId as Any)!
  const request: Any = displayToInternal(computeLoadForm(character.form))
  request.rank = getCharacters().findIndex((c: Any) => c.id === characterId)
  mutate(request)

  // Mirror of Optimizer.getFilteredRelics (optimizer.ts:159-185), minus the store-coupled wrapper
  let relics: Any = opts.relicsOverride ?? getRelics()
  relics = RelicFilters.applyEquippedFilter(request, relics)
  relics = RelicFilters.applyEnhanceFilter(request, relics)
  relics = RelicFilters.applyGradeFilter(request, relics)
  relics = RelicFilters.applyRankFilter(request, relics)
  relics = RelicFilters.applyExcludeFilter(request, relics)
  relics = RelicFilters.applyMainFilter(request, relics)
  relics = clone(relics)
  RelicFilters.mergePreviewSubstats(request, relics)
  relics = RelicFilters.applyMainStatsFilter(request, relics)
  relics = RelicFilters.applySetFilter(request, relics)
  RelicFilters.calculateWeightScore(request, relics)
  let relicsByPart: Any = RelicFilters.splitRelicsByPart(relics)
  relicsByPart = RelicFilters.applyCurrentFilter(request, relicsByPart)
  relicsByPart = RelicFilters.applyTopFilter(request, relicsByPart)
  RelicFilters.condenseRelicSubstatsForOptimizer(relicsByPart)

  const relicSetSolutions = solver.generateRelicSetSolutions(request)
  const ornamentSetSolutions = solver.generateOrnamentSetSolutions(request)
  if ((request.relicSets?.length ?? 0) > 0 || (request.ornamentSets?.length ?? 0) > 0) {
    relicsByPart = solver.applySemiJoinReduction(relicsByPart, relicSetSolutions, ornamentSetSolutions)
  }

  const sizes = {
    h: relicsByPart.Head.length,
    g: relicsByPart.Hands.length,
    b: relicsByPart.Body.length,
    f: relicsByPart.Feet.length,
    p: relicsByPart.PlanarSphere.length,
    l: relicsByPart.LinkRope.length,
  }
  const permutations = sizes.h * sizes.g * sizes.b * sizes.f * sizes.p * sizes.l
  if (permutations === 0) return { sizes, permutations, rows: [] as Any[], searched: 0, ms: 0 }

  const context: Any = generateContext(request)
  const clonedContext = clone(context)

  const sortOption = (SortOption as Any)[request.resultSort]
  const showMemo = request.memoDisplay === 'memo'
    && context.defaultActions[context.defaultActions.length - 1].config.entitiesArray.some((e: Any) => e.memosprite)
  const gridSortColumn = request.statDisplay == 'combat'
    ? (showMemo ? sortOption.memoCombatGridColumn : sortOption.combatGridColumn)
    : (showMemo ? sortOption.memoBasicGridColumn : sortOption.basicGridColumn)
  const resultsLimit = request.resultsLimit ?? 1024
  const queue = new FixedSizeMinQueue<Any>(resultsLimit)

  const packedRelicSets = bitpackBooleanArray(relicSetSolutions)
  const packedOrnamentSets = bitpackBooleanArray(ornamentSetSolutions)
  const buffer = BufferPacker.createFloatBuffer(Constants.THREAD_BUFFER_LENGTH)

  const t0 = performance.now()
  let searched = 0
  let chunks = 0
  const increment = 20000
  let runSize = 0
  for (let skip = 0; skip < permutations; skip += runSize) {
    runSize = Math.min(Constants.THREAD_BUFFER_LENGTH, runSize + increment)
    BufferPacker.cleanFloatBuffer(buffer)
    request.resultMinFilter = queue.size() && queue.size() >= resultsLimit ? queue.topPriority() : 0
    optimizerWorker({
      data: {
        context: opts.freshContextPerChunk ? structuredClone(clonedContext) : clonedContext,
        request,
        relics: relicsByPart,
        WIDTH: runSize,
        skip,
        permutations,
        relicSetSolutions: packedRelicSets,
        ornamentSetSolutions: packedOrnamentSets,
        workerType: 0,
        buffer,
      },
    } as Any)
    BufferPacker.extractArrayToResults(new Float32Array(buffer), runSize, queue, skip, gridSortColumn)
    searched += Math.min(runSize, permutations - skip)
    chunks++
    if (opts.maxChunks && chunks >= opts.maxChunks) break
  }
  const ms = performance.now() - t0

  const rows = queue.toArray().sort((a: Any, b: Any) => b[gridSortColumn] - a[gridSortColumn])

  // Mirror of OptimizerTabController.calculateRelicsFromId (mixed-radix decode of the permutation index)
  const decode = (id: number) => {
    const l = id % sizes.l
    const p = ((id - l) / sizes.l) % sizes.p
    const f = ((id - p * sizes.l - l) / (sizes.l * sizes.p)) % sizes.f
    const b = ((id - f * sizes.p * sizes.l - p * sizes.l - l) / (sizes.l * sizes.p * sizes.f)) % sizes.b
    const g = ((id - b * sizes.f * sizes.p * sizes.l - f * sizes.p * sizes.l - p * sizes.l - l) / (sizes.l * sizes.p * sizes.f * sizes.b)) % sizes.g
    const h = ((id - g * sizes.b * sizes.f * sizes.p * sizes.l - b * sizes.f * sizes.p * sizes.l - f * sizes.p * sizes.l - p * sizes.l - l)
      / (sizes.l * sizes.p * sizes.f * sizes.b * sizes.g)) % sizes.h
    return {
      Head: relicsByPart.Head[h].id,
      Hands: relicsByPart.Hands[g].id,
      Body: relicsByPart.Body[b].id,
      Feet: relicsByPart.Feet[f].id,
      PlanarSphere: relicsByPart.PlanarSphere[p].id,
      LinkRope: relicsByPart.LinkRope[l].id,
    }
  }

  return { sizes, permutations, rows, searched, ms, gridSortColumn, decode, request, context, relicsByPart }
}
