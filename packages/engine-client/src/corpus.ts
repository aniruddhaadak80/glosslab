import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CorpusAnalysis, CorpusInput, Grammar, Lexeme, Reviewer, Token } from '@glosslab/core'
import { ValidationError } from '@glosslab/core'

/**
 * The corpus file is a checked-in input; the artifact is a checked-in output.
 *
 * Committing the artifact is what lets the web app render real engine results on Vercel,
 * where Python is not available to run at request time. `gloss analyze` regenerates it, and
 * the corpus hash inside it means a stale artifact is detectable rather than merely
 * suspicious.
 */

export interface CorpusFile {
  readonly language: string
  readonly label: string
  readonly notice: string
  readonly grammar: Grammar
  readonly lexemes: readonly Lexeme[]
  readonly tokens: readonly Token[]
  readonly reviewers: readonly Reviewer[]
  readonly capacity: Readonly<Record<string, number>>
  readonly dayStartMinute: number
  readonly dayEndMinute: number
}

/** Narrow one raw field, naming the file and the field when it is the wrong shape. */
function require<T>(value: unknown, field: string, path: string): T {
  if (value === null || value === undefined) {
    throw new ValidationError(`${path} is missing "${field}"`, { field, path })
  }
  return value as T
}

export function parseCorpus(raw: string, path: string): CorpusFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new ValidationError(`${path} is not valid JSON: ${String(cause)}`, { path })
  }
  const file = parsed as Partial<CorpusFile>
  return {
    language: String(require(file.language, 'language', path)),
    label: String(require(file.label, 'label', path)),
    notice: String(require(file.notice, 'notice', path)),
    grammar: require<Grammar>(file.grammar, 'grammar', path),
    lexemes: require<Lexeme[]>(file.lexemes, 'lexemes', path),
    tokens: require<Token[]>(file.tokens, 'tokens', path),
    reviewers: require<Reviewer[]>(file.reviewers, 'reviewers', path),
    capacity: require<Record<string, number>>(file.capacity, 'capacity', path),
    dayStartMinute: Number(file.dayStartMinute ?? 9 * 60),
    dayEndMinute: Number(file.dayEndMinute ?? 17 * 60),
  }
}

export function loadCorpusFile(path: string): CorpusFile {
  return parseCorpus(readFileSync(path, 'utf8'), path)
}

/** Project the corpus file down to exactly the fields the engine operation takes. */
export function toCorpusInput(file: CorpusFile): CorpusInput {
  return {
    language: file.language,
    tokens: file.tokens,
    lexemes: file.lexemes,
    grammar: file.grammar,
    reviewers: file.reviewers,
    capacity: file.capacity,
    dayStartMinute: file.dayStartMinute,
    dayEndMinute: file.dayEndMinute,
  }
}

export function loadCorpusInput(path: string): CorpusInput {
  return toCorpusInput(loadCorpusFile(path))
}

/** The artifact is pretty-printed and key-sorted so a diff shows real changes only. */
export function serialiseAnalysis(analysis: CorpusAnalysis): string {
  return `${JSON.stringify(analysis, null, 2)}\n`
}

export function writeArtifact(path: string, analysis: CorpusAnalysis): void {
  writeFileSync(path, serialiseAnalysis(analysis), 'utf8')
}

export function readArtifact(path: string): CorpusAnalysis {
  const raw = readFileSync(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new ValidationError(`${path} is not valid JSON: ${String(cause)}`, { path })
  }
  const analysis = parsed as Partial<CorpusAnalysis>
  if (typeof analysis.corpusHash !== 'string' || !Array.isArray(analysis.tokens)) {
    throw new ValidationError(
      `${path} does not look like a corpus artifact — regenerate it with "glosslab analyze"`,
      { path },
    )
  }
  return analysis as CorpusAnalysis
}

/**
 * Is the committed artifact still what the corpus implies?
 *
 * The engine hashes the inputs it was given, so a corpus edit without a regenerated artifact
 * shows up as a hash mismatch rather than as stale numbers nobody notices.
 */
export function artifactHash(analysis: CorpusAnalysis): string {
  return analysis.corpusHash
}

export function ledgerPath(root: string): string {
  return join(root, 'corpus', 'demo', 'review-ledger.jsonl')
}

/**
 * Where the web app keeps its own copy of the artifact.
 *
 * Vercel deploys `apps/web` on its own and has no Python to run, so the deployed page reads a
 * committed artifact from inside the app. `check:analysis-artifact` compares the two copies by
 * engine hash, which is what stops this from quietly going stale.
 */
export function webArtifactPath(root: string): string {
  return join(root, 'apps', 'web', 'data', 'analysis.json')
}

/** Append-only: one JSON object per line, never rewritten. */
export function appendLedgerEvent(path: string, event: unknown): void {
  writeFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' })
}

export function readLedger(path: string): readonly unknown[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown)
}
