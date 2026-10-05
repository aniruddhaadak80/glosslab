import type { Assignment, CorpusAnalysis, CorpusToken, ScheduleOutput } from '@glosslab/core'
import { formatMinute } from '@glosslab/core'

/**
 * Rendering. Pure functions from data to text â€” no process, no clock, no I/O â€” so every
 * screen in this product is unit tested by comparing a string.
 *
 * The signature element is the interlinear gloss block: each morpheme is drawn above the span
 * of characters it covers, joined by tie bars, with the analysis boundary marked in amber.
 * It is the one screen a screenshot would identify.
 */

const ANSI = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  amber: '[38;5;179m',
  slate: '[38;5;245m',
  green: '[38;5;108m',
  red: '[38;5;167m',
  cyan: '[38;5;110m',
} as const

export interface PaintOptions {
  /** Off for golden comparisons and pipes. On only when stdout is a terminal. */
  readonly colour: boolean
}

export function paint(text: string, codes: readonly string[], options: PaintOptions): string {
  if (!options.colour || codes.length === 0) return text
  return `${codes.join('')}${text}${ANSI.reset}`
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

/** The dispute kinds, in the order a reviewer should care about. */
export const KIND_MARK: Readonly<Record<string, string>> = {
  unsegmentable: 'UNSEG',
  feature_conflict: 'FEAT',
  ambiguous: 'AMB',
  gap: 'GAP',
  manual: 'MAN',
}

export function kindMark(token: CorpusToken): string {
  if (!token.ok) return KIND_MARK.unsegmentable ?? 'UNSEG'
  if (token.featureIssue !== null) return KIND_MARK.feature_conflict ?? 'FEAT'
  if (token.ambiguous) return KIND_MARK.ambiguous ?? 'AMB'
  if (token.gapCount > 0) return KIND_MARK.gap ?? 'GAP'
  return ''
}

/**
 * The interlinear gloss block for one token.
 *
 * Three lines: the gloss, the morpheme segments aligned to their character spans, and the
 * word with its boundaries. Ambiguous readings get their alternates underneath, because a
 * segmentation without its rivals is a segmentation you cannot act on.
 */
export function renderToken(token: CorpusToken, options: PaintOptions): string {
  const head = `${paint(token.form, [ANSI.bold], options)}  ${paint(token.gloss, [ANSI.slate], options)}`
  const provenance = paint(`  (${token.provenance})`, [ANSI.dim], options)
  const mark = kindMark(token)
  const badge = mark === '' ? '' : paint(`  [${mark}]`, [ANSI.amber], options)

  if (!token.ok) {
    const reason = paint(`no reading — ${token.reason ?? 'unknown'}`, [ANSI.red], options)
    return `${head}${provenance}${badge}\n  ${reason}`
  }

  // Each morpheme gets a cell as wide as its widest of form and gloss, so the two rows stay
  // in column even when a gloss is longer than the segment it describes.
  const cells = token.morphemes.map((morpheme) => ({
    morph: morpheme.morph,
    gloss: morpheme.gloss,
    unknown: !morpheme.known,
    width: Math.max(morpheme.morph.length, morpheme.gloss.length, 1),
  }))
  const glossLine = cells
    .map((cell) => pad(cell.gloss, cell.width))
    .join(' ')
    .trimEnd()
  const tickLine = cells.map((cell) => `│${'─'.repeat(cell.width - 1)}`).join('')
  const surfaceLine = cells
    .map((cell) => paint(pad(cell.morph, cell.width), cell.unknown ? [ANSI.red] : [ANSI.slate], options))
    .join(' ')

  const lines = [
    `${head}${provenance}${badge}`,
    `  ${paint(glossLine, [ANSI.cyan], options)}`,
    `  ${paint(tickLine, [ANSI.dim], options)}`,
    `  ${surfaceLine}`,
    `  ${paint(`score ${token.score}`, [ANSI.dim], options)}`,
  ]
  if (token.featureIssue !== null) {
    lines.push(`  ${paint(`feature clash: ${token.featureIssue}`, [ANSI.red], options)}`)
  }
  for (const alternate of token.alternates) {
    lines.push(
      `  ${paint(`alt  ${alternate.morphemes.join('-')}  (${alternate.score})`, [ANSI.amber], options)}`,
    )
  }
  return lines.join('\n')
}

/** One row of the review plan, as the TUI and the CLI both show it. */
export function renderAssignment(assignment: Assignment): string {
  return `${assignment.day}  ${formatMinute(assignment.startMinute)}-${formatMinute(
    assignment.endMinute,
  )}  ${pad(assignment.reviewerId, 10)} ${pad(assignment.nodeId, 22)} ${String(assignment.minutes).padStart(
    3,
  )}m`
}

export interface PlanSummary {
  readonly assignments: readonly string[]
  readonly certificate: readonly string[]
}

/** The plan plus the proof, which is the part that matters. */
export function renderPlan(plan: ScheduleOutput, options: PaintOptions): string {
  const certificate = plan.certificate
  const verdict = certificate.verified
    ? paint('verified â€” no window is oversubscribed', [ANSI.green], options)
    : paint(`NOT verified â€” ${certificate.violations.length} violation(s)`, [ANSI.red], options)

  const lines: string[] = []
  lines.push(
    plan.ok
      ? paint(
          `plan: ${plan.assignments.length} scheduled, ${plan.unscheduled.length} deferred`,
          [ANSI.bold],
          options,
        )
      : paint(`infeasible: ${plan.reason ?? 'unknown'}`, [ANSI.red], options),
  )
  lines.push(`certificate: ${verdict}`)
  lines.push(
    `  effort ${certificate.scheduledMinutes}m of ${certificate.totalEffortMinutes}m across ${certificate.windowMinutes}m of capacity (${Math.round(
      certificate.utilisation * 100,
    )}% used)`,
  )
  if (certificate.peakDay !== null) {
    lines.push(
      `  peak ${certificate.peakDay}: ${certificate.peakDayLoadMinutes}m of ${certificate.peakDayCapacity}m`,
    )
  }
  const residual = Object.entries(certificate.residualByDay)
  if (residual.length > 0) {
    lines.push(`  residual ${residual.map(([day, left]) => `${day.slice(5)}=${left}m`).join(' ')}`)
  }
  if (plan.assignments.length > 0) {
    lines.push('')
    lines.push('day         slot          reviewer   node                    time')
    lines.push(...plan.assignments.map(renderAssignment))
  }
  for (const violation of certificate.violations) {
    lines.push(`  ${paint(violation.code, [ANSI.red], options)} ${violation.detail}`)
  }
  if (!plan.ok && plan.witness['nodeId'] !== undefined) {
    lines.push(`  witness: ${JSON.stringify(plan.witness)}`)
  }
  return lines.join('\n')
}

/** The one-screen summary `glosslab analyze` prints. */
export function renderSummary(analysis: CorpusAnalysis, options: PaintOptions): string {
  const stats = analysis.stats
  // A row that needs attention is coloured; a row that is merely a fact is not.
  const rows: [string, string, string | null][] = [
    ['tokens', String(stats['tokens'] ?? 0), null],
    ['segmented', String(stats['segmented'] ?? 0), null],
    ['unsegmentable', String(stats['unsegmentable'] ?? 0), 'danger'],
    ['ambiguous', String(stats['ambiguous'] ?? 0), 'accent'],
    ['morphemes', String(stats['morphemes'] ?? 0), null],
    ['review nodes', String(stats['reviewNodes'] ?? 0), 'accent'],
    ['scheduled', String(stats['scheduled'] ?? 0), 'green'],
    ['unscheduled', String(stats['unscheduled'] ?? 0), null],
  ]
  const tone: Record<string, string> = {
    danger: ANSI.red,
    accent: ANSI.amber,
    green: ANSI.green,
  }
  const lines = rows.map(([label, value, attention]) => {
    const head = paint(`  ${pad(label, 14)}`, [ANSI.dim], options)
    return `${head} ${attention === null ? value : paint(value, [tone[attention] ?? ''], options)}`
  })
  lines.push(`  ${paint(pad('corpus hash', 14), [ANSI.dim], options)} ${analysis.corpusHash}`)
  return lines.join('\n')
}

export { ANSI }
