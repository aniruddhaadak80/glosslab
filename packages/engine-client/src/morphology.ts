import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CorpusAnalysis,
  CorpusInput,
  SegmentInput,
  SegmentOutput,
  ScheduleInput,
  ScheduleOutput,
  UnifyInput,
  UnifyOutput,
  VerifyInput,
  VerifyOutput,
} from '@glosslab/core'
import { NotFoundError, UpstreamError } from '@glosslab/core'
import { EngineBridge, type BridgeOptions } from './bridge.js'

export const ENGINE_MODULE = 'glosslab'

/**
 * The typed face of the Python engine.
 *
 * One spawn per call, which sounds expensive and is not: the engine has no server to start
 * and no state to warm up, so a "connection" would only add a way for it to break. Every
 * method here is a pure function with a declared input and a declared output, which is what
 * lets the CLI, the TUI, the MCP server and the web app all trust the same answer.
 */
export class Morphology {
  readonly #bridge: EngineBridge

  constructor(options: BridgeOptions = {}) {
    this.#bridge = new EngineBridge(options)
  }

  segment(input: SegmentInput): Promise<SegmentOutput> {
    return this.#call<SegmentOutput>('segment', input)
  }

  unify(input: UnifyInput): Promise<UnifyOutput> {
    return this.#call<UnifyOutput>('unify', input)
  }

  scheduleReview(input: ScheduleInput): Promise<ScheduleOutput> {
    return this.#call<ScheduleOutput>('schedule_review', input)
  }

  verifyPlan(input: VerifyInput): Promise<VerifyOutput> {
    return this.#call<VerifyOutput>('verify_plan', input)
  }

  analyzeCorpus(input: CorpusInput): Promise<CorpusAnalysis> {
    return this.#call<CorpusAnalysis>('analyze_corpus', input)
  }

  async #call<T>(op: string, input: unknown): Promise<T> {
    return await this.#bridge.call<T>({ op, input })
  }
}

export interface CorpusPaths {
  readonly root: string
  readonly corpus: string
  readonly artifact: string
}

/**
 * Locate the repository root from anywhere inside the tree, then the demo corpus and the
 * committed artifact. Walking up is what lets the CLI work from a subdirectory, which is
 * what a user will actually do.
 */
export function resolveCorpusPaths(start = process.cwd()): CorpusPaths {
  const root = findRoot(start)
  return {
    root,
    corpus: join(root, 'corpus', 'demo', 'corpus.json'),
    artifact: join(root, 'corpus', 'demo', 'analysis.json'),
  }
}

/** Walk upwards until the marker that only the repository root has. */
export function findRoot(start: string): string {
  let current = start
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, 'services', 'engine', 'src', 'glosslab'))) return current
    const parent = join(current, '..')
    if (parent === current) break
    current = parent
  }
  throw new NotFoundError('could not find the glosslab repository root', {
    hint: 'run this from inside the repository, or pass an explicit --root',
    searchedFrom: start,
  })
}

/**
 * A client configured for a repository checkout, with the engine located properly.
 *
 * The engine is imported as a package (`python -m glosslab`) with the engine source
 * directory as the working directory, because the engine uses relative imports that only
 * resolve that way.
 */
export function createClient(root: string, python = process.env.GLOSSLAB_PYTHON ?? 'python'): Morphology {
  const cwd = join(root, 'services', 'engine', 'src')
  if (!existsSync(cwd)) {
    throw new UpstreamError(`engine source is missing at ${cwd}`, {
      hint: 'the engine ships in the repository; run "npm install" at the root',
    })
  }
  return new Morphology({ module: ENGINE_MODULE, cwd, python, timeoutMs: 20_000 })
}
