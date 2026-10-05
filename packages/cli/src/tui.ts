import type { CorpusAnalysis, CorpusToken } from '@glosslab/core'
import { paint, renderPlan, renderToken, type PaintOptions } from './render.js'

/**
 * The terminal interface: a split pane over the morpheme trees.
 *
 * Split into a pure state machine and a thin I/O loop on purpose. Everything a user can do
 * here is a transition over `TuiState`, so the whole interface is tested by asserting
 * strings — no TTY, no flaky timing, and a keyboard model another agent can drive.
 */

export const WIDTH = 78
const ESC = '\u001b'

export interface TuiState {
  readonly rows: readonly CorpusToken[]
  readonly cursor: number
  readonly filter: string
  readonly filtering: boolean
  readonly focus: 'list' | 'detail'
  readonly height: number
  readonly message: string
}

export type TuiKey =
  | 'up'
  | 'down'
  | 'page-up'
  | 'page-down'
  | 'home'
  | 'end'
  | 'filter-open'
  | 'filter-close'
  | 'filter-clear'
  | 'tab'
  | 'quit'
  | 'char'

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low
  return Math.min(Math.max(value, low), high)
}

/** Case-insensitive substring over the surface form, gloss and provenance. */
export function filterTokens(tokens: readonly CorpusToken[], filter: string): readonly CorpusToken[] {
  const needle = filter.trim().toLowerCase()
  if (needle === '') return tokens
  return tokens.filter((token) =>
    `${token.form} ${token.gloss} ${token.provenance}`.toLowerCase().includes(needle),
  )
}

export function initialState(analysis: CorpusAnalysis, height = 20): TuiState {
  const rows = filterTokens(analysis.tokens, '')
  return {
    rows,
    cursor: 0,
    filter: '',
    filtering: false,
    focus: 'list',
    height,
    message: `${rows.length} tokens — j/k move, / filter, tab focus, q quit`,
  }
}

function withRows(state: TuiState, rows: readonly CorpusToken[]): TuiState {
  return { ...state, rows, cursor: clamp(state.cursor, 0, Math.max(rows.length - 1, 0)) }
}

/** The only place state changes. Every key is total: an unknown key returns the state. */
export function reduce(state: TuiState, key: TuiKey, tokens?: readonly CorpusToken[]): TuiState {
  const source = tokens ?? state.rows

  if (state.filtering) {
    switch (key) {
      case 'filter-close':
        return { ...state, filtering: false }
      case 'filter-clear':
        return withRows({ ...state, filter: '', message: 'filter cleared' }, source)
      case 'char':
        return withRows(
          { ...state, filter: state.filter, message: `filter: ${state.filter || '(empty)'}` },
          filterTokens(source, state.filter),
        )
      default:
        return state
    }
  }

  switch (key) {
    case 'quit':
      return { ...state, message: 'bye' }
    case 'up':
      return { ...state, cursor: clamp(state.cursor - 1, 0, state.rows.length - 1) }
    case 'down':
      return { ...state, cursor: clamp(state.cursor + 1, 0, state.rows.length - 1) }
    case 'page-up':
      return { ...state, cursor: clamp(state.cursor - state.height, 0, state.rows.length - 1) }
    case 'page-down':
      return { ...state, cursor: clamp(state.cursor + state.height, 0, state.rows.length - 1) }
    case 'home':
      return { ...state, cursor: 0 }
    case 'end':
      return { ...state, cursor: Math.max(state.rows.length - 1, 0) }
    case 'tab':
      return {
        ...state,
        focus: state.focus === 'list' ? 'detail' : 'list',
        message: state.focus === 'list' ? 'detail focused' : 'list focused',
      }
    case 'filter-open':
      return { ...state, filtering: true, message: 'type to filter, enter to accept' }
    case 'filter-clear':
      return withRows({ ...state, filter: '', message: 'filter cleared' }, source)
    default:
      // Outside filter mode a character means nothing, so the state is unchanged.
      return state
  }
}

/** One row of the master pane, with a pointer on the cursor line. */
export function renderRow(token: CorpusToken, selected: boolean, options: PaintOptions): string {
  const pointer = selected ? '>' : ' '
  const flag = !token.ok
    ? 'UNSEG'
    : token.featureIssue !== null
      ? 'FEAT'
      : token.ambiguous
        ? 'AMB '
        : token.gapCount > 0
          ? 'GAP '
          : '    '
  const body = `${pointer} ${flag} ${token.form.padEnd(10)} ${token.gloss.slice(0, 28).padEnd(28)} ${
    token.ok ? token.score.toFixed(2).padStart(6) : '     -'
  }`
  return selected ? paint(body, [`${ESC}[1m`], options) : body
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(width - 1, 0))}…` : text
}

/**
 * The full frame: a header, the master list on the left, the detail pane on the right.
 * Returned as one string so a test can assert the whole screen at once.
 */
export function renderFrame(state: TuiState, analysis: CorpusAnalysis, options: PaintOptions): string {
  const inner = Math.max(state.height - 6, 3)
  // 2 of indent + 1 space + 1 gutter + 1 space around the gutter must fit inside WIDTH.
  const listWidth = 50
  const detailWidth = WIDTH - listWidth - 5
  const gutter = paint('│', [`${ESC}[2m`], options)
  const rule = paint('─'.repeat(WIDTH), [`${ESC}[2m`], options)

  const header = `${paint(`glosslab ${analysis.language}`, [`${ESC}[1m`], options)}   ${paint(
    `hash ${analysis.corpusHash}`,
    [`${ESC}[2m`],
    options,
  )}`

  const listLines = state.rows
    .slice(state.cursor, state.cursor + inner)
    .map((token, index) => renderRow(token, state.cursor + index === state.cursor, options))
  while (listLines.length < inner) listLines.push('')

  const selected = state.rows[state.cursor]
  const detailBody = selected === undefined ? '(no token selected)' : renderToken(selected, options)
  const detailLines = detailBody.split('\n').map((line) => clip(line, detailWidth))
  while (detailLines.length < inner) detailLines.push('')

  const rows = listLines.map(
    (line, index) => `  ${line.slice(0, listWidth).padEnd(listWidth)} ${gutter} ${detailLines[index] ?? ''}`,
  )

  return [
    header,
    rule,
    ...rows,
    rule,
    `  ${paint(state.focus, [`${ESC}[2m`], options)}  ${state.message}`,
  ].join('\n')
}

/** The plan screen, from the same data the CLI prints. */
export function renderPlanFrame(analysis: CorpusAnalysis, options: PaintOptions): string {
  return renderPlan(analysis.plan, options)
}

export interface TuiIo {
  readonly write: (text: string) => void
  readonly readKey: () => Promise<TuiKey | null>
}

/**
 * Map one raw terminal read to a key.
 *
 * Pure, because escape sequences are logic and logic deserves a test: `\u001b[A` is not
 * three characters, it is one keypress, and getting that wrong is the classic TUI bug.
 */
export function mapKey(input: string): TuiKey {
  switch (input) {
    case '[A':
    case 'k':
      return 'up'
    case '[B':
    case 'j':
      return 'down'
    case '[5~':
      return 'page-up'
    case '[6~':
    case ' ':
      return 'page-down'
    case '[H':
      return 'home'
    case '[F':
    case 'G':
      return 'end'
    case '\t':
      return 'tab'
    case 'q':
    case '':
      return 'quit'
    case '':
      return 'filter-clear'
    case '':
      return 'filter-close'
    case '\r':
    case '\n':
      return 'filter-close'
    case '/':
      return 'filter-open'
    default:
      return 'char'
  }
}

/** Drive the state machine from a terminal. Resolves when the reader reports no more keys. */
export async function runTui(
  analysis: CorpusAnalysis,
  io: TuiIo,
  options: PaintOptions,
  height = 20,
): Promise<void> {
  let state = initialState(analysis, height)
  const redraw = () => io.write(`${ESC}[2J${renderFrame(state, analysis, options)}\n`)

  redraw()
  for (;;) {
    const key = await io.readKey()
    if (key === null || key === 'quit') break
    state = reduce(state, key, analysis.tokens)
    redraw()
  }
  io.write(`${ESC}[2J${paint('glosslab — session ended', [`${ESC}[2m`], options)}\n`)
}
