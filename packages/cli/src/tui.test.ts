import { describe, expect, it } from 'vitest'
import type { CorpusAnalysis, CorpusToken, ScheduleOutput } from '@glosslab/core'
import {
  WIDTH,
  filterTokens,
  initialState,
  mapKey,
  reduce,
  renderFrame,
  renderRow,
  runTui,
  type TuiState,
} from './tui.js'

const plain = { colour: false }

function token(id: string, form: string, overrides: Partial<CorpusToken> = {}): CorpusToken {
  return {
    id,
    form,
    gloss: `gloss-${form}`,
    provenance: 'elicitation-01',
    ok: true,
    reason: null,
    featureIssue: null,
    score: 3,
    ambiguous: false,
    gapCount: 0,
    morphemes: [
      {
        lexemeId: id,
        morph: form,
        type: 'stem',
        gloss: form,
        features: {},
        start: 0,
        end: form.length,
        weight: 3,
        known: true,
      },
    ],
    alternates: [],
    ...overrides,
  }
}

const PLAN: ScheduleOutput = {
  ok: true,
  mode: 'best_effort',
  reason: null,
  assignments: [],
  unscheduled: [],
  witness: {},
  certificate: {
    totalEffortMinutes: 0,
    scheduledMinutes: 0,
    unscheduledCount: 0,
    windowMinutes: 120,
    utilisation: 0,
    peakDay: null,
    peakDayLoadMinutes: 0,
    peakDayCapacity: 0,
    residualByDay: {},
    verified: true,
    violations: [],
  },
}

const analysis = {
  ok: true,
  language: 'kavrin-demo',
  corpusHash: 'deadbeef',
  tokens: [token('t01', 'kav'), token('t02', 'kavm'), token('t03', 'nakav')],
  reviewNodes: [],
  plan: PLAN,
  stats: { tokens: 3 },
} as unknown as CorpusAnalysis

describe('filterTokens', () => {
  it('returns everything for an empty filter', () => {
    expect(filterTokens(analysis.tokens, '')).toHaveLength(3)
    expect(filterTokens(analysis.tokens, '   ')).toHaveLength(3)
  })

  it('matches the surface form, gloss and provenance, case-insensitively', () => {
    expect(filterTokens(analysis.tokens, 'KAVM')).toHaveLength(1)
    expect(filterTokens(analysis.tokens, 'gloss-nakav')).toHaveLength(1)
    expect(filterTokens(analysis.tokens, 'ELICITATION')).toHaveLength(3)
  })

  it('can return nothing', () => {
    expect(filterTokens(analysis.tokens, 'zzz')).toHaveLength(0)
  })
})

describe('reduce', () => {
  const start = (): TuiState => initialState(analysis, 10)

  it('starts on the first token with the list focused', () => {
    const state = start()
    expect(state.cursor).toBe(0)
    expect(state.focus).toBe('list')
    expect(state.rows).toHaveLength(3)
  })

  it('moves down and up', () => {
    let state = start()
    state = reduce(state, 'down')
    expect(state.cursor).toBe(1)
    state = reduce(state, 'down')
    expect(state.cursor).toBe(2)
    state = reduce(state, 'up')
    expect(state.cursor).toBe(1)
  })

  it('clamps at both ends', () => {
    let state = start()
    state = reduce(state, 'up')
    expect(state.cursor).toBe(0)
    for (let index = 0; index < 10; index += 1) state = reduce(state, 'down')
    expect(state.cursor).toBe(2)
  })

  it('jumps to home and end', () => {
    let state = reduce(start(), 'end')
    expect(state.cursor).toBe(2)
    state = reduce(state, 'home')
    expect(state.cursor).toBe(0)
  })

  it('pages by a screenful', () => {
    const state = reduce(start(), 'page-down')
    expect(state.cursor).toBe(2)
  })

  it('toggles focus', () => {
    const state = reduce(start(), 'tab')
    expect(state.focus).toBe('detail')
    expect(reduce(state, 'tab').focus).toBe('list')
  })

  it('filters while the filter is open and keeps the cursor in range', () => {
    let state = reduce(start(), 'filter-open')
    expect(state.filtering).toBe(true)
    state = reduce(state, 'char', analysis.tokens)
    expect(state.rows).toHaveLength(3)
    state = reduce(state, 'filter-close')
    expect(state.filtering).toBe(false)
  })

  it('refuses to navigate while typing a filter', () => {
    const state = reduce(reduce(start(), 'filter-open'), 'down')
    expect(state.cursor).toBe(0)
  })

  it('clears a filter and restores every row', () => {
    let state = reduce(start(), 'filter-open')
    state = reduce(state, 'char', analysis.tokens)
    state = { ...state, filter: 'zzz', rows: [] }
    state = reduce(state, 'filter-clear', analysis.tokens)
    expect(state.rows).toHaveLength(3)
    expect(state.filter).toBe('')
  })

  it('survives an empty row set', () => {
    const empty: TuiState = { ...start(), rows: [] }
    expect(reduce(empty, 'down').cursor).toBe(0)
    expect(reduce(empty, 'end').cursor).toBe(0)
  })

  it('returns the same state for a key it does not handle', () => {
    const state = start()
    expect(reduce(state, 'char')).toBe(state)
  })

  it('records the quit', () => {
    expect(reduce(start(), 'quit').message).toBe('bye')
  })
})

describe('mapKey', () => {
  it('maps vim keys', () => {
    expect(mapKey('j')).toBe('down')
    expect(mapKey('k')).toBe('up')
    expect(mapKey('q')).toBe('quit')
  })

  it('maps arrow keys as one keypress, not three characters', () => {
    expect(mapKey('\u001b[A')).toBe('up')
    expect(mapKey('\u001b[B')).toBe('down')
  })

  it('maps paging and navigation keys', () => {
    expect(mapKey('\u001b[5~')).toBe('page-up')
    expect(mapKey('\u001b[6~')).toBe('page-down')
    expect(mapKey('\u001b[H')).toBe('home')
    expect(mapKey('\u001b[F')).toBe('end')
  })

  it('maps control and editing keys', () => {
    expect(mapKey('\u0003')).toBe('quit')
    expect(mapKey('\u007f')).toBe('filter-clear')
    expect(mapKey('\t')).toBe('tab')
    expect(mapKey('\u001b')).toBe('filter-close')
    expect(mapKey('\r')).toBe('filter-close')
    expect(mapKey('/')).toBe('filter-open')
  })

  it('treats anything printable as a character', () => {
    expect(mapKey('a')).toBe('char')
    expect(mapKey('Z')).toBe('char')
  })
})

describe('renderFrame', () => {
  it('draws a header, a gutter and the token count', () => {
    const frame = renderFrame(initialState(analysis, 12), analysis, plain)
    expect(frame).toContain('glosslab kavrin-demo')
    expect(frame).toContain('hash deadbeef')
    expect(frame).toContain('3 tokens')
    expect(frame.split('\n').length).toBeGreaterThanOrEqual(7)
  })

  it('puts a pointer on exactly one row', () => {
    const state = reduce(initialState(analysis, 12), 'down')
    const frame = renderFrame(state, analysis, plain)
    const pointers = frame.split('\n').filter((line) => line.trimStart().startsWith('>'))
    expect(pointers).toHaveLength(1)
    expect(pointers[0]).toContain('kavm')
  })

  it('shows the selected token in the detail pane', () => {
    const state = reduce(initialState(analysis, 12), 'down')
    expect(renderFrame(state, analysis, plain)).toContain('gloss-kavm')
  })

  it('never exceeds the declared width', () => {
    const frame = renderFrame(initialState(analysis, 12), analysis, plain)
    for (const line of frame.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(WIDTH)
    }
  })

  it('says so when there is nothing to show', () => {
    const empty = { ...initialState(analysis, 12), rows: [] }
    expect(renderFrame(empty, analysis, plain)).toContain('no token selected')
  })

  it('still draws a full frame when the corpus has no tokens', () => {
    const bare = { ...analysis, tokens: [] } as unknown as CorpusAnalysis
    const frame = renderFrame(initialState(bare, 12), bare, plain)
    expect(frame).toContain('glosslab kavrin-demo')
    expect(frame).toContain('0 tokens')
  })
})

describe('renderRow', () => {
  it('flags each kind of dispute', () => {
    expect(renderRow(token('a', 'x', { ok: false, reason: 'unsegmentable' }), false, plain)).toContain(
      'UNSEG',
    )
    expect(renderRow(token('a', 'x', { ambiguous: true }), false, plain)).toContain('AMB')
    expect(renderRow(token('a', 'x', { gapCount: 1 }), false, plain)).toContain('GAP')
    expect(renderRow(token('a', 'x', { featureIssue: 'clash' }), false, plain)).toContain('FEAT')
  })

  it('shows a dash instead of a score when there is no reading', () => {
    expect(renderRow(token('a', 'x', { ok: false }), false, plain)).toContain('     -')
  })
})

describe('runTui', () => {
  it('draws once per key and stops on quit', async () => {
    const frames: string[] = []
    const keys = ['down', 'down', 'quit'] as const
    let index = 0
    await runTui(
      analysis,
      {
        write: (text) => frames.push(text),
        readKey: async () => {
          const key = keys[index]
          index += 1
          return key ?? null
        },
      },
      plain,
      12,
    )
    // initial frame + one per key, and the final line says the session ended.
    expect(frames).toHaveLength(keys.length + 1)
    expect(frames.at(-1)).toContain('session ended')
  })

  it('stops when the input ends', async () => {
    const frames: string[] = []
    await runTui(analysis, { write: (text) => frames.push(text), readKey: async () => null }, plain, 12)
    expect(frames).toHaveLength(2)
  })
})
