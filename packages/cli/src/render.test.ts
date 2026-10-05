import { describe, expect, it } from 'vitest'
import type { CorpusAnalysis, CorpusToken } from '@glosslab/core'
import {
  KIND_MARK,
  kindMark,
  paint,
  renderAssignment,
  renderPlan,
  renderSummary,
  renderToken,
} from './render.js'

/** Colour off, so every assertion here is about the text a human reads. */
const plain = { colour: false }

function token(overrides: Partial<CorpusToken> = {}): CorpusToken {
  return {
    id: 't01',
    form: 'kavm',
    gloss: 'people',
    provenance: 'elicitation-01',
    ok: true,
    reason: null,
    featureIssue: null,
    score: 4,
    ambiguous: false,
    gapCount: 0,
    morphemes: [
      {
        lexemeId: 'kav',
        morph: 'kav',
        type: 'stem',
        gloss: 'person',
        features: {},
        start: 0,
        end: 3,
        weight: 3,
        known: true,
      },
      {
        lexemeId: 'suf-pl',
        morph: 'm',
        type: 'suffix',
        gloss: 'PL',
        features: { number: 'pl' },
        start: 3,
        end: 4,
        weight: 1,
        known: true,
      },
    ],
    alternates: [],
    ...overrides,
  }
}

describe('paint', () => {
  it('is a no-op when colour is off', () => {
    expect(paint('x', ['[1m'], plain)).toBe('x')
  })

  it('wraps the text when colour is on', () => {
    expect(paint('x', ['\u001b[1m'], { colour: true })).toBe('\u001b[1mx\u001b[0m')
  })
})

describe('kindMark', () => {
  it('reports unsegmentable first', () => {
    expect(kindMark(token({ ok: false, reason: 'unsegmentable' }))).toBe(KIND_MARK.unsegmentable)
  })

  it('reports a feature clash ahead of an ambiguity', () => {
    expect(kindMark(token({ featureIssue: 'incompatible at case: dat != gen' }))).toBe(
      KIND_MARK.feature_conflict,
    )
  })

  it('reports ambiguity and gaps', () => {
    expect(kindMark(token({ ambiguous: true }))).toBe(KIND_MARK.ambiguous)
    expect(kindMark(token({ gapCount: 1 }))).toBe(KIND_MARK.gap)
  })

  it('reports nothing for a clean reading', () => {
    expect(kindMark(token())).toBe('')
  })
})

describe('renderToken', () => {
  it('aligns the gloss row to the surface row', () => {
    const lines = renderToken(token(), plain).split('\n')
    const gloss = lines[1] ?? ''
    const surface = lines[3] ?? ''
    expect(gloss).toContain('person')
    expect(gloss).toContain('PL')
    // The gloss row and the surface row must start their morphemes in the same columns.
    const glossColumns = [...gloss.matchAll(/\S+/g)].map((match) => match.index)
    const surfaceColumns = [...surface.matchAll(/\S+/g)].map((match) => match.index)
    expect(glossColumns).toEqual(surfaceColumns)
  })

  it('draws one boundary tick per morpheme', () => {
    const lines = renderToken(token(), plain).split('\n')
    expect((lines[2] ?? '').trim().split('│').length - 1).toBe(2)
  })

  it('marks an unsegmentable word as such and says why', () => {
    const text = renderToken(token({ ok: false, reason: 'unsegmentable', morphemes: [] }), plain)
    expect(text).toContain('no reading')
    expect(text).toContain('unsegmentable')
    expect(text).toContain('UNSEG')
  })

  it('lists the rival reading an ambiguity produced', () => {
    const text = renderToken(
      token({
        ambiguous: true,
        alternates: [{ morphemes: ['kav', 'm'], score: 4, affixCount: 1, gapCount: 0 }],
      }),
      plain,
    )
    expect(text).toContain('AMB')
    expect(text).toContain('alt  kav-m  (4)')
  })

  it('shows a feature clash with both values', () => {
    const text = renderToken(token({ featureIssue: 'incompatible at case: dat != gen' }), plain)
    expect(text).toContain('feature clash: incompatible at case: dat != gen')
  })

  it('marks an opaque span as unknown and flags the token', () => {
    const unknown = token({
      gapCount: 1,
      morphemes: [
        {
          lexemeId: 'opaque',
          morph: 'q',
          type: 'unknown',
          gloss: '',
          features: {},
          start: 0,
          end: 1,
          weight: 0,
          known: false,
        },
      ],
    })
    expect(renderToken(unknown, plain)).toContain('GAP')
  })

  it('renders a token with no morphemes without throwing', () => {
    expect(() => renderToken(token({ morphemes: [] }), plain)).not.toThrow()
  })
})

describe('renderAssignment', () => {
  it('shows the day, the slot and the cost', () => {
    const line = renderAssignment({
      nodeId: 't16:unsegmentable',
      reviewerId: 'r-anne',
      day: '2026-03-02',
      startMinute: 540,
      endMinute: 565,
      minutes: 25,
    })
    expect(line).toContain('2026-03-02')
    expect(line).toContain('09:00-09:25')
    expect(line).toContain('r-anne')
    expect(line).toContain('25m')
  })
})

const PLAN: CorpusAnalysis['plan'] = {
  ok: true,
  mode: 'best_effort',
  reason: null,
  assignments: [
    {
      nodeId: 'n1',
      reviewerId: 'r1',
      day: '2026-03-02',
      startMinute: 540,
      endMinute: 570,
      minutes: 30,
    },
  ],
  unscheduled: ['n2'],
  witness: {},
  certificate: {
    totalEffortMinutes: 90,
    scheduledMinutes: 30,
    unscheduledCount: 1,
    windowMinutes: 120,
    utilisation: 0.25,
    peakDay: '2026-03-02',
    peakDayLoadMinutes: 30,
    peakDayCapacity: 120,
    residualByDay: { '2026-03-02': 90 },
    verified: true,
    violations: [],
  },
}

describe('renderPlan', () => {
  it('leads with the certificate verdict', () => {
    const text = renderPlan(PLAN, plain)
    expect(text).toContain('verified')
    expect(text).toContain('no window is oversubscribed')
  })

  it('reports utilisation and residual capacity', () => {
    const text = renderPlan(PLAN, plain)
    expect(text).toContain('30m of 90m')
    expect(text).toContain('25% used')
    expect(text).toContain('03-02=90m')
  })

  it('says NOT verified when the verifier found something', () => {
    const text = renderPlan(
      {
        ...PLAN,
        certificate: {
          ...PLAN.certificate,
          verified: false,
          violations: [
            {
              code: 'day_oversubscribed',
              detail: 'too much on 2026-03-02',
              nodeId: '',
              reviewerId: '',
              day: '2026-03-02',
            },
          ],
        },
      },
      plain,
    )
    expect(text).toContain('NOT verified')
    expect(text).toContain('day_oversubscribed')
  })

  it('shows an infeasible plan with its witness', () => {
    const text = renderPlan(
      {
        ...PLAN,
        ok: false,
        reason: 'no_capacity_before_deadline',
        assignments: [],
        witness: { nodeId: 'n2', reason: 'no_capacity_before_deadline' },
      },
      plain,
    )
    expect(text).toContain('infeasible: no_capacity_before_deadline')
    expect(text).toContain('witness:')
  })
})

describe('renderSummary', () => {
  it('prints the counts and the corpus hash', () => {
    const analysis = {
      ok: true,
      language: 'kavrin-demo',
      corpusHash: 'abc123',
      tokens: [],
      reviewNodes: [],
      plan: PLAN,
      stats: { tokens: 23, segmented: 21, unsegmentable: 2, ambiguous: 4, reviewNodes: 7 },
    } as unknown as CorpusAnalysis
    const text = renderSummary(analysis, plain)
    expect(text).toContain('tokens         23')
    expect(text).toContain('review nodes   7')
    expect(text).toContain('abc123')
  })
})
