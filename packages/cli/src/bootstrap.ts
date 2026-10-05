import { join } from 'node:path'
import { ToolRegistry, ValidationError, type Tool, type ToolContext } from '@glosslab/core'
import type {
  Assignment,
  FeatureDictionary,
  FeatureStructure,
  Grammar,
  Lexeme,
  ReviewNode,
  Reviewer,
} from '@glosslab/core'
import { buildRegistry } from '@glosslab/plugins'
import { loadCatalog } from '@glosslab/skills'

export const ENGINE_MODULE = 'glosslab'

interface SegmentToolInput {
  readonly word: string
  readonly lexemes?: readonly Lexeme[]
  readonly grammar?: Grammar
  readonly dictionary?: FeatureDictionary
}

interface CorpusToolInput {
  readonly useCorpus?: boolean
  readonly tokens?: readonly { readonly id?: string; readonly form: string }[]
  readonly lexemes?: readonly Lexeme[]
}

/**
 * The one registry every surface shares.
 *
 * Every tool here does real product work: it reaches the Python engine, or reads the
 * catalog off disk. There is no tool whose job is to return a plausible-looking shape, and
 * that is the whole point — an agent that can call these gets the same answer the linguist
 * would get, and when the lexicon cannot cover a word it is told so.
 *
 * Names match ^[a-z][a-z0-9_]*$ so each one is directly exposable over MCP.
 */
export function buildToolRegistry(cwd = process.cwd()): ToolRegistry {
  const registry = new ToolRegistry()
  const paths = {
    corpus: join(cwd, 'corpus', 'demo', 'corpus.json'),
    artifact: join(cwd, 'corpus', 'demo', 'analysis.json'),
  }

  // ---------------------------------------------------------------- discovery

  registry.register(
    {
      name: 'list_skills',
      description:
        'List the skill catalog with each skill name, version and description. Use this to discover what the agent can do before guessing a command.',
      inputSchema: {
        type: 'object',
        properties: {
          includeBodies: { type: 'boolean', description: 'Include each skill body.' },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          issues: { type: 'array', items: { type: 'string' } },
          skills: { type: 'array', items: { type: 'object' } },
        },
        required: ['count', 'issues', 'skills'],
      },
      permissions: ['fs:read'],
      surface: 'core',
      handler: async (input: { includeBodies?: boolean }) => {
        const { skills, issues } = loadCatalog(join(cwd, 'skills'))
        return {
          count: skills.length,
          issues: [...issues],
          skills: skills.map((skill) => ({
            name: skill.name,
            version: skill.version,
            description: skill.description,
            ...(input.includeBodies === true ? { body: skill.body } : {}),
          })),
        }
      },
    } satisfies Tool<{ includeBodies?: boolean }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'list_plugins',
      description:
        'List the resolved plugin registry, including plugins that were shadowed, disabled or rejected and why. Use this to explain why an expected capability is missing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object' },
      permissions: ['fs:read'],
      surface: 'core',
      handler: async () => {
        const result = buildRegistry(join(cwd, 'plugins'))
        return {
          active: result.active.map((plugin) => ({
            name: plugin.manifest.name,
            version: plugin.manifest.version,
            capabilities: plugin.manifest.capabilities,
            shadowed: plugin.shadowed,
          })),
          disabled: result.disabled.map((plugin) => plugin.manifest.name),
          rejected: result.rejected.map((plugin) => ({ path: plugin.path, issues: plugin.issues })),
        }
      },
    } satisfies Tool<Record<string, never>, unknown>,
    { source: 'core' },
  )

  // ---------------------------------------------------------------- morphology

  const lexemeSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      morph: { type: 'string', description: 'The surface form of this morpheme.' },
      type: { type: 'string', enum: ['stem', 'prefix', 'suffix', 'infix', 'clitic', 'unknown'] },
      gloss: { type: 'string' },
      weight: { type: 'number', description: 'Contribution to the segmentation score.' },
      priority: { type: 'integer', description: 'Higher wins a tie.' },
      features: { type: 'object' },
    },
    required: ['id', 'morph', 'type', 'gloss', 'weight', 'priority'],
  } as const

  const grammarProperties = {
    maxAffixes: { type: 'integer', minimum: 0 },
    allowPrefixStack: { type: 'boolean' },
    allowInfix: { type: 'boolean' },
    allowGap: { type: 'boolean', description: 'Admit spans the lexicon does not cover.' },
    gapPenalty: { type: 'number' },
    ambiguityMargin: {
      type: 'number',
      description: 'How close a rival reading must be to count as ambiguous.',
    },
    headFinalTypes: { type: 'array', items: { type: 'string' } },
    requiredFeatures: { type: 'array', items: { type: 'string' } },
  } as const

  /** Lexemes arrive with the call, or default to the checked-in demo lexicon. */
  const lexemesFor = async (provided: readonly Lexeme[] | undefined): Promise<readonly Lexeme[]> => {
    if (provided !== undefined) {
      if (!Array.isArray(provided)) {
        throw new ValidationError('"lexemes" must be an array when provided', { field: 'lexemes' })
      }
      return provided
    }
    const { loadCorpusFile } = await import('@glosslab/engine-client')
    return loadCorpusFile(paths.corpus).lexemes
  }

  const segmentInputSchema = {
    type: 'object',
    properties: {
      word: { type: 'string', description: 'The surface form to segment.' },
      lexemes: {
        type: 'array',
        items: lexemeSchema,
        description: 'Omit to use the checked-in demo lexicon.',
      },
      grammar: { type: 'object', properties: grammarProperties, additionalProperties: false },
      dictionary: { type: 'object', description: 'id -> feature structure, for @ref resolution.' },
    },
    required: ['word'],
    additionalProperties: false,
  } as const

  const segmentOutputSchema = {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      word: { type: 'string' },
      morphemes: { type: 'array', items: { type: 'object' } },
      score: { type: 'number' },
      scoreBreakdown: { type: 'array', items: { type: 'object' } },
      alternates: {
        type: 'array',
        description: 'Readings within the declared ambiguity margin of the winner.',
        items: { type: 'object' },
      },
      ambiguous: { type: 'boolean' },
      reason: { type: ['string', 'null'], description: 'Why no reading was produced.' },
      failedAt: { type: 'array', items: { type: 'integer' } },
    },
    required: ['ok', 'word', 'morphemes', 'score', 'alternates', 'ambiguous'],
  } as const

  const client = async () => {
    const { createClient } = await import('@glosslab/engine-client')
    return createClient(cwd)
  }

  registry.register(
    {
      name: 'segment_token',
      description:
        'Segment one word into morphemes using a declared lexicon and morphotactics. Deterministic: the same word and lexicon always give the same reading. Returns ok=false with a reason when the lexicon cannot cover the word rather than guessing a boundary, and lists the rival readings within the declared ambiguity margin. Use this instead of splitting words by string surgery.',
      inputSchema: segmentInputSchema,
      outputSchema: segmentOutputSchema,
      permissions: ['proc:spawn', 'fs:read'],
      surface: 'core',
      handler: async (input: SegmentToolInput) => {
        if (typeof input.word !== 'string' || input.word.length === 0) {
          throw new ValidationError('"word" must be a non-empty string', { field: 'word' })
        }
        const morphology = await client()
        return await morphology.segment({
          word: input.word,
          lexemes: await lexemesFor(input.lexemes),
          ...(input.grammar === undefined ? {} : { grammar: input.grammar }),
          ...(input.dictionary === undefined ? {} : { dictionary: input.dictionary }),
        })
      },
    } satisfies Tool<SegmentToolInput, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'unify_features',
      description:
        'Unify two morphological feature structures and report typed failures: "incompatible" when a feature gets two values, "missing" when a declared required feature is absent, "deref_fail" when an @ref points at nothing. Merged features and every disagreement path come back, so use this to check whether two words can agree before trusting an analysis.',
      inputSchema: {
        type: 'object',
        properties: {
          left: { type: 'object' },
          right: { type: 'object' },
          dictionary: { type: 'object', description: 'id -> feature structure for @ref resolution.' },
          required: { type: 'array', items: { type: 'string' }, description: 'Dotted paths.' },
        },
        required: ['left', 'right'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          reason: { type: ['string', 'null'], enum: ['deref_fail', 'incompatible', 'missing', null] },
          merged: { type: 'object' },
          conflicts: { type: 'array', items: { type: 'object' } },
          unspecified: { type: 'array', items: { type: 'object' } },
          unresolvedRefs: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'reason', 'merged', 'conflicts'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input: {
        left: FeatureStructure
        right: FeatureStructure
        dictionary?: FeatureDictionary
        required?: readonly string[]
      }) => {
        if (typeof input.left !== 'object' || input.left === null) {
          throw new ValidationError('"left" must be an object', { field: 'left' })
        }
        if (typeof input.right !== 'object' || input.right === null) {
          throw new ValidationError('"right" must be an object', { field: 'right' })
        }
        const morphology = await client()
        return await morphology.unify({
          left: input.left,
          right: input.right,
          ...(input.dictionary === undefined ? {} : { dictionary: input.dictionary }),
          ...(input.required === undefined ? {} : { required: input.required }),
        })
      },
    } satisfies Tool<
      {
        left: FeatureStructure
        right: FeatureStructure
        dictionary?: FeatureDictionary
        required?: readonly string[]
      },
      unknown
    >,
    { source: 'core' },
  )

  // ---------------------------------------------------------------- scheduling

  const nodeSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      token: { type: 'string' },
      kind: {
        type: 'string',
        enum: ['unsegmentable', 'ambiguous', 'gap', 'feature_conflict', 'manual'],
      },
      detail: { type: 'string', description: 'Why this needs a human.' },
      priority: { type: 'integer' },
      effortMinutes: { type: 'integer', minimum: 1 },
      deadline: { type: ['string', 'null'], description: 'ISO date, or null for no deadline.' },
      requiredSkill: { type: ['string', 'null'] },
    },
    required: ['id', 'effortMinutes'],
  } as const

  const reviewerSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      skills: { type: 'array', items: { type: 'string' } },
      capacityMinutesPerDay: { type: 'integer', minimum: 0 },
      availableDays: { type: 'array', items: { type: 'string' } },
    },
    required: ['id', 'skills', 'capacityMinutesPerDay', 'availableDays'],
  } as const

  const schedulingProperties = {
    nodes: { type: 'array', items: nodeSchema },
    reviewers: { type: 'array', items: reviewerSchema },
    capacity: {
      type: 'object',
      description: 'Day -> whole-team minutes. Undeclared days default to their reviewers.',
      additionalProperties: { type: 'integer' },
    },
    dayStartMinute: { type: 'integer', description: 'Minutes past midnight.' },
    dayEndMinute: { type: 'integer' },
  } as const

  registry.register(
    {
      name: 'schedule_review',
      description:
        'Assign morpheme review tasks to reviewers under real capacity limits, honouring skills, availability and deadlines. Returns assignments plus a feasibility certificate, or ok=false with a witness naming the exhausted resource. Use this to answer "we have three linguists and two weeks — what do we look at?"',
      inputSchema: {
        type: 'object',
        properties: {
          ...schedulingProperties,
          mode: {
            type: 'string',
            enum: ['all_or_nothing', 'best_effort'],
            description:
              'all_or_nothing refuses a partial plan; best_effort reports what it could not place.',
          },
        },
        required: ['nodes', 'reviewers'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          reason: { type: ['string', 'null'] },
          assignments: { type: 'array', items: { type: 'object' } },
          unscheduled: { type: 'array', items: { type: 'string' } },
          witness: { type: 'object' },
          certificate: { type: 'object' },
        },
        required: ['ok', 'assignments', 'certificate'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input: {
        nodes: readonly ReviewNode[]
        reviewers: readonly Reviewer[]
        capacity?: Readonly<Record<string, number>>
        dayStartMinute?: number
        dayEndMinute?: number
        mode?: 'all_or_nothing' | 'best_effort'
      }) => {
        if (!Array.isArray(input.nodes) || !Array.isArray(input.reviewers)) {
          throw new ValidationError('"nodes" and "reviewers" must both be arrays', {
            field: Array.isArray(input.nodes) ? 'reviewers' : 'nodes',
          })
        }
        const morphology = await client()
        return await morphology.scheduleReview({
          nodes: input.nodes,
          reviewers: input.reviewers,
          capacity: input.capacity ?? {},
          ...(input.dayStartMinute === undefined ? {} : { dayStartMinute: input.dayStartMinute }),
          ...(input.dayEndMinute === undefined ? {} : { dayEndMinute: input.dayEndMinute }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
        })
      },
    } satisfies Tool<
      {
        nodes: readonly ReviewNode[]
        reviewers: readonly Reviewer[]
        capacity?: Readonly<Record<string, number>>
        dayStartMinute?: number
        dayEndMinute?: number
        mode?: 'all_or_nothing' | 'best_effort'
      },
      unknown
    >,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'verify_review_plan',
      description:
        'Independently re-check a review plan against capacity, skills, availability and deadlines. This is a second implementation, not a re-run: it takes only the plan and the declared limits, and names the exact window that is oversubscribed. Use it before promising anyone a schedule.',
      inputSchema: {
        type: 'object',
        properties: {
          ...schedulingProperties,
          assignments: { type: 'array', items: { type: 'object' } },
        },
        required: ['nodes', 'reviewers', 'assignments'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          feasible: { type: 'boolean' },
          violations: { type: 'array', items: { type: 'object' } },
          checked: { type: 'integer' },
        },
        required: ['feasible', 'violations', 'checked'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input: {
        nodes: readonly ReviewNode[]
        reviewers: readonly Reviewer[]
        assignments: readonly Assignment[]
        capacity?: Readonly<Record<string, number>>
        dayStartMinute?: number
        dayEndMinute?: number
      }) => {
        if (!Array.isArray(input.assignments)) {
          throw new ValidationError('"assignments" must be an array', { field: 'assignments' })
        }
        const morphology = await client()
        return await morphology.verifyPlan({
          nodes: input.nodes ?? [],
          reviewers: input.reviewers ?? [],
          assignments: input.assignments,
          capacity: input.capacity ?? {},
          ...(input.dayStartMinute === undefined ? {} : { dayStartMinute: input.dayStartMinute }),
          ...(input.dayEndMinute === undefined ? {} : { dayEndMinute: input.dayEndMinute }),
        })
      },
    } satisfies Tool<
      {
        nodes: readonly ReviewNode[]
        reviewers: readonly Reviewer[]
        assignments: readonly Assignment[]
        capacity?: Readonly<Record<string, number>>
        dayStartMinute?: number
        dayEndMinute?: number
      },
      unknown
    >,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'analyze_corpus',
      description:
        'Run the whole pipeline over a corpus: segment every token, derive the disputes (unsegmentable, ambiguous, feature clash), then schedule them into a verified review plan. Reads the checked-in demo corpus when no input is given. Deterministic, so it can be re-run and compared.',
      inputSchema: {
        type: 'object',
        properties: {
          useCorpus: {
            type: 'boolean',
            description: 'Analyse the checked-in demo corpus. Ignored when tokens are supplied.',
          },
          tokens: { type: 'array', items: { type: 'object' } },
          lexemes: { type: 'array', items: lexemeSchema },
          grammar: { type: 'object', properties: grammarProperties, additionalProperties: false },
          reviewers: { type: 'array', items: reviewerSchema },
          capacity: { type: 'object', additionalProperties: { type: 'integer' } },
          dayStartMinute: { type: 'integer' },
          dayEndMinute: { type: 'integer' },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          language: { type: 'string' },
          corpusHash: { type: 'string', description: 'Changes whenever an input does.' },
          tokens: { type: 'array', items: { type: 'object' } },
          reviewNodes: { type: 'array', items: { type: 'object' } },
          plan: { type: 'object' },
          stats: { type: 'object' },
        },
        required: ['ok', 'corpusHash', 'tokens', 'reviewNodes', 'plan', 'stats'],
      },
      permissions: ['proc:spawn', 'fs:read'],
      surface: 'core',
      handler: async (input: CorpusToolInput) => {
        const morphology = await client()
        if (input.tokens === undefined || input.useCorpus === true) {
          const { loadCorpusInput } = await import('@glosslab/engine-client')
          return await morphology.analyzeCorpus(loadCorpusInput(paths.corpus))
        }
        if (input.lexemes === undefined) {
          throw new ValidationError(
            '"lexemes" is required when analysing your own tokens — the demo lexicon would be meaningless here',
            { field: 'lexemes', hint: 'or pass {"useCorpus": true} to analyse the demo corpus' },
          )
        }
        return await morphology.analyzeCorpus({
          tokens: input.tokens.map((token, index) => ({
            id: token.id ?? `t${index + 1}`,
            form: token.form,
            gloss: '',
            provenance: 'mcp',
          })),
          lexemes: input.lexemes,
          reviewers: [],
          capacity: {},
        })
      },
    } satisfies Tool<CorpusToolInput, unknown>,
    { source: 'core' },
  )

  return registry
}

/** A minimal, dependency-free logger for the tool context. */
export function createContext(requestId = 'cli'): ToolContext {
  return {
    requestId,
    now: () => Date.now(),
    log: (level, message, fields) => {
      process.stderr.write(`${JSON.stringify({ level, message, requestId, ...fields })}\n`)
    },
    dataDir: process.env.PRODUCT_DATA_DIR ?? '.data',
  }
}
