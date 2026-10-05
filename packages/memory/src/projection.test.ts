import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CorpusAnalysis } from '@glosslab/core'
import { LATEST_VERSION, MorphologyProjection, Store } from './index.js'

/**
 * The projection is derived state, so the properties that matter are: it is idempotent, it
 * never leaves a stale row behind, and it answers the questions the TUI asks.
 */

// Resolved from this file, not from the working directory, so the test is independent of
// where it was launched from.
const ARTIFACT = fileURLToPath(new URL('../../../corpus/demo/analysis.json', import.meta.url))
const ANALYSIS = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as CorpusAnalysis

function projection(): { store: Store; view: MorphologyProjection } {
  const store = new Store(':memory:')
  return { store, view: new MorphologyProjection(store) }
}

describe('migrations', () => {
  it('reaches the latest version on a fresh database', () => {
    const store = new Store(':memory:')
    expect(store.version).toBe(LATEST_VERSION)
    expect(store.isPending).toBe(false)
    store.close()
  })

  it('is idempotent', () => {
    const store = new Store(':memory:')
    expect(store.migrate()).toBe(store.migrate())
    store.close()
  })

  it('creates every table the projection writes to', () => {
    const store = new Store(':memory:')
    const names = (
      store.connection.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as {
        name: string
      }[]
    ).map((row) => row.name)
    for (const table of [
      'records',
      'records_fts',
      'tokens',
      'tokens_fts',
      'morphemes',
      'alternates',
      'review_nodes',
      'assignments',
    ]) {
      expect(names).toContain(table)
    }
    store.close()
  })
})

describe('MorphologyProjection.replace', () => {
  it('projects every entity the analysis contains', () => {
    const { store, view } = projection()
    const result = view.replace(ANALYSIS)

    expect(result.tokens).toBe(ANALYSIS.tokens.length)
    expect(result.morphemes).toBe(ANALYSIS.tokens.reduce((total, token) => total + token.morphemes.length, 0))
    expect(result.reviewNodes).toBe(ANALYSIS.reviewNodes.length)
    expect(result.assignments).toBe(ANALYSIS.plan.assignments.length)
    expect(result.corpusHash).toBe(ANALYSIS.corpusHash)
    store.close()
  })

  it('is idempotent', () => {
    const { store, view } = projection()
    view.replace(ANALYSIS)
    const first = view.tokens()
    view.replace(ANALYSIS)
    expect(view.tokens()).toEqual(first)
    store.close()
  })

  it('leaves no stale rows when the corpus shrinks', () => {
    const { store, view } = projection()
    view.replace(ANALYSIS)
    expect(view.tokens().length).toBe(ANALYSIS.tokens.length)

    const smaller: CorpusAnalysis = { ...ANALYSIS, tokens: ANALYSIS.tokens.slice(0, 2) }
    view.replace(smaller)
    expect(view.tokens()).toHaveLength(2)
    // "ritual" belongs to t09, which is past the slice: it must be gone from the index too.
    expect(view.search('ritual')).toHaveLength(0)
    expect(view.morphemesOf('t09')).toEqual([])
    store.close()
  })

  it('stores the features as JSON, not as a blob of nothing', () => {
    const { store, view } = projection()
    view.replace(ANALYSIS)
    const plural = view.morphemesOf('t02').find((row) => row.lexeme_id === 'suf-pl')
    expect(JSON.parse(plural?.features ?? '{}')).toEqual({ number: 'pl' })
    store.close()
  })

  it('records the morpheme spans that tile the word', () => {
    const { store, view } = projection()
    view.replace(ANALYSIS)
    const rows = view.morphemesOf('t04')
    let cursor = 0
    for (const row of rows) {
      expect(row.span_from).toBe(cursor)
      cursor = row.span_to
    }
    expect(rows.at(-1)?.span_to).toBe('prakavm'.length)
    store.close()
  })

  it('accepts an empty analysis', () => {
    const { store, view } = projection()
    const result = view.replace({
      ...ANALYSIS,
      tokens: [],
      reviewNodes: [],
      plan: { ...ANALYSIS.plan, assignments: [] },
    })
    expect(result.tokens).toBe(0)
    expect(view.tokens()).toEqual([])
    store.close()
  })
})

describe('MorphologyProjection queries', () => {
  it('lists tokens in corpus order', () => {
    const { store, view } = projection()
    view.replace(ANALYSIS)
    expect(view.tokens().map((row) => row.id)).toEqual(ANALYSIS.tokens.map((token) => token.id))
    store.close()
  })

  it('filters to the tokens that need a human', () => {
    const { store, view } = projection()
    view.replace(ANALYSIS)
    const disputed = view.tokens(true)
    expect(disputed.length).toBe(ANALYSIS.reviewNodes.length)
    for (const row of disputed) {
      const isDisputed =
        row.ok === 0 || row.feature_issue !== null || row.ambiguous === 1 || row.gap_count > 0
      expect(isDisputed).toBe(true)
    }
    store.close()
  })

  it('fetches one token and its morphemes', () => {
    const { store, view } = projection()
    view.replace(ANALYSIS)
    expect(view.token('t09')?.form).toBe('sakm')
    expect(view.morphemesOf('t09').map((row) => row.morph)).toEqual(['sakm'])
    store.close()
  })

  it('returns undefined for an unknown token', () => {
    const { store, view } = projection()
    view.replace(ANALYSIS)
    expect(view.token('nope')).toBeUndefined()
    store.close()
  })

  it('orders review nodes by priority', () => {
    const { store, view } = projection()
    view.replace(ANALYSIS)
    const priorities = view.reviewNodes().map((row) => row.priority)
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities)
    store.close()
  })

  it('orders assignments by day then start time', () => {
    const { store, view } = projection()
    view.replace(ANALYSIS)
    const rows = view.assignments()
    const keys = rows.map((row) => `${row.day}T${String(row.start_minute).padStart(4, '0')}`)
    expect([...keys].sort()).toEqual(keys)
    store.close()
  })

  it('counts how often each lexeme is used', () => {
    const { store, view } = projection()
    view.replace(ANALYSIS)
    const usage = view.lexemeUsage()
    const kav = usage.find((row) => row.lexeme_id === 'kav')
    expect(kav?.uses).toBeGreaterThan(0)
    expect(usage.reduce((total, row) => total + row.uses, 0)).toBe(
      ANALYSIS.tokens.reduce((sum, token) => sum + token.morphemes.length, 0),
    )
    store.close()
  })

  it('searches forms and glosses through FTS5', () => {
    const { store, view } = projection()
    view.replace(ANALYSIS)
    expect(view.search('people').map((row) => row.form)).toContain('kavm')
    expect(view.search('zzz-nothing')).toEqual([])
    store.close()
  })
})
