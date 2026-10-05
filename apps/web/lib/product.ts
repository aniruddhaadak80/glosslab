import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The product's identity and surface manifest, in one typed place. The nav, the surfaces
 * page and the health endpoint all read from here so a value is never stated twice.
 */
export interface Surface {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly status: 'shipped' | 'omitted'
  /** Why it was left out, when it was. Omission without a reason is a TODO. */
  readonly reason?: string
}

export const PRODUCT = {
  name: 'Glosslab',
  slug: 'glosslab',
  version: '0.1.0',
  tagline: 'A morphology review harness.',
  oneLiner:
    'Segment an under-documented language against a declared morpheme lexicon, then schedule the disputed nodes into a proven-feasible review plan.',
} as const

export const SURFACES: readonly Surface[] = [
  {
    id: 'cli',
    title: 'CLI',
    summary:
      'segment, analyze, plan, project, export, tui — every capability without a browser, and the surface the TUI and the MCP server are both built on.',
    status: 'shipped',
  },
  {
    id: 'tui',
    title: 'Terminal UI',
    summary:
      'A split pane over the morpheme trees: dense token list on the left, interlinear gloss on the right, filter as you type. A pure state machine, so it is unit tested without a terminal.',
    status: 'shipped',
  },
  {
    id: 'web',
    title: 'Web',
    summary:
      'This app. Server-rendered corpus browser and review plan, reading the committed engine artifact so the deployed page shows real segmentations.',
    status: 'shipped',
  },
  {
    id: 'mcp',
    title: 'MCP server and client',
    summary:
      'The seven registry tools over stdio, so any MCP client can segment a word, unify features and plan a review. Stateless per call, with an error envelope.',
    status: 'shipped',
  },
  {
    id: 'skills',
    title: 'Skills catalog',
    summary:
      'Markdown skills loaded from disk with frontmatter validation and a version gate that fails when a body changes without a version bump.',
    status: 'shipped',
  },
  {
    id: 'plugins',
    title: 'Plugin registry',
    summary:
      'Manifest-driven extensions with priority-based conflict resolution and an explanation for every rejection.',
    status: 'shipped',
  },
  {
    id: 'memory',
    title: 'Memory',
    summary:
      'SQLite with WAL, numbered migrations and an FTS5 index, holding the projection of a corpus analysis so queries never re-run the engine.',
    status: 'shipped',
  },
  {
    id: 'channels',
    title: 'Channels',
    summary:
      'One adapter: interlinear gloss export, the .txt interchange ELAN, FLEx and NexusPLAS already read. Retries live in the base class.',
    status: 'shipped',
  },
  {
    id: 'desktop',
    title: 'Desktop',
    summary:
      'Not shipped. An Electron shell would be a second copy of the web app with no surface a linguist would use, and could not be honestly tested here.',
    status: 'omitted',
    reason: 'A worse version of the web app, with nothing added.',
  },
  {
    id: 'providers',
    title: 'Model providers',
    summary:
      'No remote model provider ships. Segmentation, unification and scheduling are decisions with right answers, so they are code; a model call here would only add a way to be wrong.',
    status: 'omitted',
    reason: 'The engine is the credibility of the product.',
  },
]

function packageVersion(): string {
  for (const candidate of [process.cwd(), join(process.cwd(), '..', '..')]) {
    try {
      const parsed = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')) as {
        version?: string
      }
      if (parsed.version !== undefined) return parsed.version
    } catch {
      /* try the next candidate */
    }
  }
  return PRODUCT.version
}

export function resolveVersion(): string {
  return packageVersion()
}

export function resolveCommit(): string {
  // No git on Vercel: the commit is an honest "unknown" rather than a fabricated one.
  return process.env['GIT_COMMIT_SHA'] ?? process.env['VERCEL_GIT_COMMIT_SHA'] ?? 'unknown'
}
