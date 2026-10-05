import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ConflictError, ValidationError } from '@glosslab/core'
import { assertMcpSafeName, describeTools } from '@glosslab/mcp'
import { buildToolRegistry, createContext } from './bootstrap.js'

/**
 * The registry is the narrow waist, so these tests are about the waist holding: seven real
 * tools, no MCP-unsafe names, no duplicate overwrites, and at least one tool that genuinely
 * reaches the Python engine.
 */

// Resolved from this file rather than process.cwd(), because turbo runs each package's tests
// with that package as the working directory and the tools need the repository root.
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const registry = buildToolRegistry(ROOT)
const ALL_PERMISSIONS = ['fs:read', 'fs:write', 'net:fetch', 'proc:spawn', 'env:read'] as const

describe('buildToolRegistry', () => {
  it('registers the seven product tools', () => {
    expect(registry.names()).toEqual([
      'analyze_corpus',
      'list_plugins',
      'list_skills',
      'schedule_review',
      'segment_token',
      'unify_features',
      'verify_review_plan',
    ])
  })

  it('exposes at least the five tools the MCP contract promises', () => {
    expect(registry.size).toBeGreaterThanOrEqual(5)
  })

  it('gives every tool a description, schemas, permissions and a core surface', () => {
    for (const tool of registry.list()) {
      expect(tool.description.length).toBeGreaterThan(40)
      expect(tool.description).toMatch(/[.?"]$/)
      expect(tool.inputSchema['type']).toBe('object')
      expect(tool.outputSchema['type']).toBe('object')
      expect(tool.permissions.length).toBeGreaterThan(0)
      expect(registry.surfaceOf(tool.name)).toBe('core')
      expect(registry.sourceOf(tool.name)).toBe('core')
    }
  })

  it('names every tool so it can be exposed over MCP unchanged', () => {
    for (const tool of registry.list()) {
      expect(() => assertMcpSafeName(tool.name)).not.toThrow()
    }
  })

  it('refuses a duplicate name and names both sources', () => {
    expect(() =>
      registry.register(
        {
          name: 'segment_token',
          description: 'a second implementation of the same capability',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          permissions: [],
          surface: 'core',
          handler: async () => ({}),
        },
        { source: 'rogue' },
      ),
    ).toThrow(ConflictError)

    try {
      registry.register(
        {
          name: 'segment_token',
          description: 'a second implementation',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          permissions: [],
          surface: 'core',
          handler: async () => ({}),
        },
        { source: 'rogue' },
      )
    } catch (error) {
      expect((error as { details?: { existingSource?: string } }).details?.existingSource).toBe('core')
    }
  })

  it('refuses to invoke a tool whose permissions were not granted', async () => {
    await expect(
      registry.invoke('segment_token', { word: 'kav' }, createContext('test'), []),
    ).rejects.toThrow()
  })

  it('validates input before doing any work', async () => {
    await expect(
      registry.invoke('segment_token', { word: '' }, createContext('test'), ALL_PERMISSIONS),
    ).rejects.toThrow(ValidationError)

    await expect(
      registry.invoke('unify_features', { left: 'nope' }, createContext('test'), ALL_PERMISSIONS),
    ).rejects.toThrow(ValidationError)

    await expect(
      registry.invoke('schedule_review', { nodes: 'nope' }, createContext('test'), ALL_PERMISSIONS),
    ).rejects.toThrow(ValidationError)

    await expect(
      registry.invoke(
        'verify_review_plan',
        { nodes: [], reviewers: [] },
        createContext('test'),
        ALL_PERMISSIONS,
      ),
    ).rejects.toThrow(ValidationError)
  })
})

describe('tool descriptors', () => {
  it('describes exactly the registry, with schemas a model can fill', () => {
    const descriptors = describeTools(registry)
    expect(descriptors).toHaveLength(registry.size)
    for (const descriptor of descriptors) {
      expect(descriptor.inputSchema['type']).toBe('object')
      expect(descriptor.description).toMatch(/[.?"]$/)
    }
  })
})

describe('list_skills', () => {
  it('returns the catalog with issues surfaced', async () => {
    const value = (await registry.invoke('list_skills', {}, createContext('test'), ALL_PERMISSIONS)) as {
      count: number
      issues: string[]
    }
    expect(value.count).toBeGreaterThanOrEqual(2)
    expect(value.issues).toEqual([])
  })
})

describe('list_plugins', () => {
  it('returns the resolved registry', async () => {
    const value = (await registry.invoke('list_plugins', {}, createContext('test'), ALL_PERMISSIONS)) as {
      active: unknown[]
    }
    expect(Array.isArray(value.active)).toBe(true)
  })
})

describe('the engine-backed tools', () => {
  it('segments a word through the real Python engine', async () => {
    const value = (await registry.invoke(
      'segment_token',
      { word: 'kavm' },
      createContext('test'),
      ALL_PERMISSIONS,
    )) as { ok: boolean; morphemes: { morph: string }[]; score: number }

    expect(value.ok).toBe(true)
    expect(value.morphemes.map((part) => part.morph)).toEqual(['kav', 'm'])
    expect(value.score).toBeCloseTo(4, 6)
  }, 60_000)

  it('reports an uncovered word instead of inventing a boundary', async () => {
    const value = (await registry.invoke(
      'segment_token',
      { word: 'xkavri' },
      createContext('test'),
      ALL_PERMISSIONS,
    )) as { ok: boolean; reason: string; failedAt: number[] }

    expect(value.ok).toBe(false)
    expect(value.reason).toBe('unsegmentable')
    expect(value.failedAt.length).toBeGreaterThan(0)
  }, 60_000)

  it('unifies features with a typed failure', async () => {
    const value = (await registry.invoke(
      'unify_features',
      { left: { case: 'dat' }, right: { case: 'gen' } },
      createContext('test'),
      ALL_PERMISSIONS,
    )) as { ok: boolean; reason: string; conflicts: { path: string }[] }

    expect(value.ok).toBe(false)
    expect(value.reason).toBe('incompatible')
    expect(value.conflicts[0]?.path).toBe('case')
  }, 60_000)

  it('schedules reviews and returns a verified certificate', async () => {
    const value = (await registry.invoke(
      'schedule_review',
      {
        nodes: [
          {
            id: 'n1',
            token: 'kavm',
            kind: 'ambiguous',
            detail: 'two readings',
            priority: 60,
            effortMinutes: 30,
            deadline: null,
            requiredSkill: 'morphology',
          },
        ],
        reviewers: [
          {
            id: 'r1',
            skills: ['morphology'],
            capacityMinutesPerDay: 60,
            availableDays: ['2026-03-02'],
          },
        ],
        capacity: { '2026-03-02': 60 },
      },
      createContext('test'),
      ALL_PERMISSIONS,
    )) as { ok: boolean; assignments: unknown[]; certificate: { verified: boolean } }

    expect(value.ok).toBe(true)
    expect(value.assignments).toHaveLength(1)
    expect(value.certificate.verified).toBe(true)
  }, 60_000)

  it('verifies a plan it is handed, and catches an oversubscribed one', async () => {
    const assignment = {
      nodeId: 'n1',
      reviewerId: 'r1',
      day: '2026-03-02',
      startMinute: 540,
      endMinute: 600,
      minutes: 60,
    }
    const value = (await registry.invoke(
      'verify_review_plan',
      {
        nodes: [
          {
            id: 'n1',
            token: 'kavm',
            kind: 'manual',
            detail: '',
            priority: 10,
            effortMinutes: 30,
            deadline: null,
            requiredSkill: 'morphology',
          },
        ],
        reviewers: [
          {
            id: 'r1',
            skills: ['morphology'],
            capacityMinutesPerDay: 60,
            availableDays: ['2026-03-02'],
          },
        ],
        assignments: [assignment],
        capacity: { '2026-03-02': 60 },
      },
      createContext('test'),
      ALL_PERMISSIONS,
    )) as { feasible: boolean; violations: { code: string }[] }

    expect(value.feasible).toBe(false)
    expect(value.violations.map((violation) => violation.code)).toContain('effort_mismatch')
  }, 60_000)

  it('analyses the checked-in corpus end to end', async () => {
    const value = (await registry.invoke(
      'analyze_corpus',
      { useCorpus: true },
      createContext('test'),
      ALL_PERMISSIONS,
    )) as { ok: boolean; stats: Record<string, number>; plan: { certificate: { verified: boolean } } }

    expect(value.ok).toBe(true)
    expect(value.stats['tokens']).toBe(23)
    expect(value.stats['reviewNodes']).toBeGreaterThan(0)
    expect(value.plan.certificate.verified).toBe(true)
  }, 120_000)

  it('refuses to analyse a caller lexicon with no lexemes of its own', async () => {
    await expect(
      registry.invoke(
        'analyze_corpus',
        { tokens: [{ form: 'kav' }] },
        createContext('test'),
        ALL_PERMISSIONS,
      ),
    ).rejects.toThrow(ValidationError)
  }, 60_000)
})
