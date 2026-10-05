import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The web app reads the committed artifact, never the engine.
 *
 * A Vercel function has no Python to run, and pretending otherwise would mean the deployed
 * page was showing something other than what the engine produced. So `glosslab analyze
 * --write` writes the artifact into the app's own `data/` directory, the engine hash travels
 * inside it, and `check:analysis-artifact` fails if the two ever drift.
 *
 * This file is deliberately self-contained: no workspace imports, because the web app is
 * deployed on its own.
 */

export interface SegmentedMorpheme {
  readonly lexemeId: string
  readonly morph: string
  readonly type: string
  readonly gloss: string
  readonly features: Record<string, string | number | boolean>
  readonly start: number
  readonly end: number
  readonly weight: number
  readonly known: boolean
}

export interface Alternate {
  readonly morphemes: readonly string[]
  readonly score: number
  readonly affixCount: number
  readonly gapCount: number
}

export interface CorpusToken {
  readonly id: string
  readonly form: string
  readonly gloss: string
  readonly provenance: string
  readonly ok: boolean
  readonly reason: string | null
  readonly featureIssue: string | null
  readonly score: number
  readonly ambiguous: boolean
  readonly gapCount: number
  readonly morphemes: readonly SegmentedMorpheme[]
  readonly alternates: readonly Alternate[]
}

export interface ReviewNode {
  readonly id: string
  readonly token: string
  readonly kind: string
  readonly detail: string
  readonly priority: number
  readonly effortMinutes: number
  readonly deadline: string | null
  readonly requiredSkill: string | null
}

export interface Assignment {
  readonly nodeId: string
  readonly reviewerId: string
  readonly day: string
  readonly startMinute: number
  readonly endMinute: number
  readonly minutes: number
}

export interface Violation {
  readonly code: string
  readonly detail: string
  readonly nodeId: string
  readonly reviewerId: string
  readonly day: string
}

export interface Certificate {
  readonly totalEffortMinutes: number
  readonly scheduledMinutes: number
  readonly unscheduledCount: number
  readonly windowMinutes: number
  readonly utilisation: number
  readonly peakDay: string | null
  readonly peakDayLoadMinutes: number
  readonly peakDayCapacity: number
  readonly residualByDay: Record<string, number>
  readonly verified: boolean
  readonly violations: readonly Violation[]
}

export interface Schedule {
  readonly ok: boolean
  readonly mode: string
  readonly reason: string | null
  readonly assignments: readonly Assignment[]
  readonly unscheduled: readonly string[]
  readonly certificate: Certificate
}

export interface Analysis {
  readonly ok: boolean
  readonly language: string
  readonly corpusHash: string
  readonly tokens: readonly CorpusToken[]
  readonly reviewNodes: readonly ReviewNode[]
  readonly plan: Schedule
  readonly stats: Record<string, number>
}

export class AnalysisUnavailable extends Error {
  readonly searched: readonly string[]

  constructor(message: string, searched: readonly string[]) {
    super(message)
    this.name = 'AnalysisUnavailable'
    this.searched = searched
  }
}

/**
 * Where the artifact may live: the app's own data directory first, then the repository
 * layout for local development from the monorepo root.
 */
export function candidatePaths(cwd = process.cwd()): readonly string[] {
  return [
    join(cwd, 'data', 'analysis.json'),
    join(cwd, 'corpus', 'demo', 'analysis.json'),
    join(cwd, '..', '..', 'corpus', 'demo', 'analysis.json'),
    join(cwd, '..', 'analysis.json'),
  ]
}

export function findAnalysisPath(cwd = process.cwd()): string | null {
  for (const candidate of candidatePaths(cwd)) {
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      /* try the next one */
    }
  }
  return null
}

/** Parse and shape-check. A malformed artifact is an error, never an empty page. */
export function parseAnalysis(raw: string, origin: string): Analysis {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new AnalysisUnavailable(`${origin} is not valid JSON: ${String(cause)}`, [origin])
  }
  const analysis = parsed as Partial<Analysis>
  if (
    typeof analysis.corpusHash !== 'string' ||
    !Array.isArray(analysis.tokens) ||
    !Array.isArray(analysis.reviewNodes) ||
    analysis.plan === undefined ||
    analysis.plan.certificate === undefined
  ) {
    throw new AnalysisUnavailable(
      `${origin} is not a corpus artifact — regenerate it with "glosslab analyze --write"`,
      [origin],
    )
  }
  return analysis as Analysis
}

/**
 * Read the artifact. Cached per process, because a server component may render the same
 * corpus for several components in one request.
 */
let cache: { path: string; analysis: Analysis } | null = null

export function loadAnalysis(cwd = process.cwd()): Analysis {
  const path = findAnalysisPath(cwd)
  if (path === null) {
    throw new AnalysisUnavailable(
      'no corpus artifact found — run "glosslab analyze --write"',
      candidatePaths(cwd),
    )
  }
  if (cache !== null && cache.path === path) return cache.analysis
  const analysis = parseAnalysis(readFileSync(path, 'utf8'), path)
  cache = { path, analysis }
  return analysis
}

export function clearAnalysisCache(): void {
  cache = null
}

// ------------------------------------------------------------------ queries

export type Dispute = 'unsegmentable' | 'feature_conflict' | 'ambiguous' | 'gap'

/** The single predicate every surface uses to decide "does this need a human". */
export function disputeOf(token: CorpusToken): Dispute | null {
  if (!token.ok) return 'unsegmentable'
  if (token.featureIssue !== null) return 'feature_conflict'
  if (token.ambiguous) return 'ambiguous'
  if (token.gapCount > 0) return 'gap'
  return null
}

export function disputed(token: CorpusToken): boolean {
  return disputeOf(token) !== null
}

export function findToken(analysis: Analysis, id: string): CorpusToken | null {
  return analysis.tokens.find((token) => token.id === id) ?? null
}

/** Case-insensitive match over form, gloss and provenance. */
export function filterTokens(tokens: readonly CorpusToken[], query: string): readonly CorpusToken[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return tokens
  return tokens.filter((token) =>
    `${token.form} ${token.gloss} ${token.provenance}`.toLowerCase().includes(needle),
  )
}

export interface DayLoad {
  readonly day: string
  readonly loadMinutes: number
  readonly capacityMinutes: number
  readonly utilisation: number
}

/**
 * Per-day load against capacity. The capacity comes from the certificate's residual plus the
 * measured load, because the certificate reports what is left rather than the ceiling.
 */
export function dayLoads(schedule: Schedule): readonly DayLoad[] {
  const load = new Map<string, number>()
  for (const assignment of schedule.assignments) {
    load.set(assignment.day, (load.get(assignment.day) ?? 0) + assignment.minutes)
  }
  const residual = schedule.certificate.residualByDay
  return [...new Set([...Object.keys(residual), ...load.keys()])].sort().map((day) => {
    const loadMinutes = load.get(day) ?? 0
    const capacityMinutes = loadMinutes + (residual[day] ?? 0)
    return {
      day,
      loadMinutes,
      capacityMinutes,
      utilisation: capacityMinutes === 0 ? 0 : loadMinutes / capacityMinutes,
    }
  })
}

export function formatMinute(minute: number): string {
  const hours = Math.floor(minute / 60)
  const minutes = minute % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}

/** Morpheme cells, padded so glosses and forms share columns — the interlinear layout. */
export interface GlossCell {
  readonly text: string
  readonly unknown: boolean
}

export function glossCells(morphemes: readonly SegmentedMorpheme[]): readonly GlossCell[] {
  return morphemes.map((morpheme) => ({
    text: morpheme.morph,
    unknown: !morpheme.known,
  }))
}

export function glossWidths(morphemes: readonly SegmentedMorpheme[]): readonly number[] {
  return morphemes.map((morpheme) => Math.max(morpheme.morph.length, morpheme.gloss.length, 1))
}

export function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}
