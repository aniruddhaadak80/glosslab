#!/usr/bin/env node
// Fail when a committed corpus artifact is not what the engine produces today.
//
// The engine hashes its inputs, so the committed artifact carries the hash of the corpus that
// produced it. That makes staleness detectable instead of merely suspicious — and it is the
// difference between "the web page shows real segmentations" and "the web page shows whatever
// was true last Tuesday".
//
// Checks, in order:
//   1. corpus/demo/analysis.json exists and parses
//   2. apps/web/data/analysis.json exists and matches the corpus copy byte for byte
//   3. the engine's golden test file still equals a fresh run  (the anti-drift file)
//
// Python is required, and a missing engine is a failure rather than a skip: this gate exists
// precisely because the engine is the product.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORPUS_ARTIFACT = join(ROOT, 'corpus', 'demo', 'analysis.json')
const WEB_ARTIFACT = join(ROOT, 'apps', 'web', 'data', 'analysis.json')
const CORPUS = join(ROOT, 'corpus', 'demo', 'corpus.json')
const GOLDEN = join(ROOT, 'services', 'engine', 'tests', 'golden', 'demo_corpus.json')

const failures = []

function fail(message, hint) {
  failures.push({ message, hint })
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (cause) {
    return { __error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Canonical form: keys sorted recursively.
 *
 * The golden file is written with sorted keys and the engine replies in its own order, so
 * comparing them textually would report drift on every run. Compare the data, not the layout.
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

// ---------------------------------------------------------------- 1. artifacts exist
for (const [label, path] of [
  ['corpus artifact', CORPUS_ARTIFACT],
  ['web artifact', WEB_ARTIFACT],
]) {
  if (!existsSync(path)) {
    fail(`${label} is missing: ${path}`, 'run "glosslab analyze --write"')
  }
}

if (failures.length > 0) {
  report()
  process.exit(1)
}

const corpusArtifact = readJson(CORPUS_ARTIFACT)
const webArtifact = readJson(WEB_ARTIFACT)

if (corpusArtifact.__error !== undefined) {
  fail(`corpus artifact is not valid JSON: ${corpusArtifact.__error}`, 'regenerate it')
}
if (webArtifact.__error !== undefined) {
  fail(`web artifact is not valid JSON: ${webArtifact.__error}`, 'regenerate it')
}
if (typeof corpusArtifact.corpusHash !== 'string') {
  fail('corpus artifact has no corpusHash', 'regenerate it with "glosslab analyze --write"')
}

// ---------------------------------------------------------------- 2. the two copies agree
if (corpusArtifact.corpusHash !== webArtifact.corpusHash) {
  fail(
    `the web copy is stale: corpus ${corpusArtifact.corpusHash} vs web ${webArtifact.corpusHash}`,
    'run "glosslab analyze --write" — it writes both copies',
  )
}
if (canonical(corpusArtifact) !== canonical(webArtifact)) {
  fail('the two artifact copies differ in content, not only in hash', 'run "glosslab analyze --write"')
}

// ---------------------------------------------------------------- 3. the engine still agrees
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const corpus = existsSync(CORPUS) ? readJson(CORPUS) : null
if (corpus === null || corpus.__error !== undefined) {
  fail('corpus/demo/corpus.json is missing or invalid', 'restore it from version control')
} else {
  const request = JSON.stringify({
    op: 'analyze_corpus',
    input: {
      language: corpus.language,
      tokens: corpus.tokens,
      lexemes: corpus.lexemes,
      grammar: corpus.grammar,
      reviewers: corpus.reviewers,
      capacity: corpus.capacity,
      dayStartMinute: corpus.dayStartMinute,
      dayEndMinute: corpus.dayEndMinute,
    },
  })

  const engine = spawnSync(python, ['-m', 'glosslab'], {
    cwd: join(ROOT, 'services', 'engine', 'src'),
    input: request,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })

  if (engine.status !== 0) {
    fail(
      `the engine exited ${engine.status}: ${(engine.stderr || '').trim().slice(0, 200) || 'no stderr'}`,
      'check that Python 3.11+ is on PATH',
    )
  } else {
    let response
    try {
      response = JSON.parse((engine.stdout || '').trim())
    } catch (cause) {
      fail(`the engine returned invalid JSON: ${String(cause)}`, 'run it by hand to see the error')
    }
    if (response !== undefined) {
      if (response.ok !== true) {
        fail(
          `the engine reported ${response.error?.code}: ${response.error?.message}`,
          'fix the corpus, then regenerate',
        )
      } else if (response.value?.corpusHash !== corpusArtifact.corpusHash) {
        fail(
          `the committed artifact is stale: engine ${response.value?.corpusHash} vs artifact ${corpusArtifact.corpusHash}`,
          'run "glosslab analyze --write"',
        )
      } else if (existsSync(GOLDEN)) {
        const golden = readJson(GOLDEN)
        if (canonical(golden) !== canonical(response.value)) {
          fail(
            'the golden file no longer matches the engine',
            'review the diff, then regenerate it with the command in docs/adr/0004',
          )
        }
      }
    }
  }
}

report()

function report() {
  if (failures.length === 0) {
    console.log(
      `check:analysis-artifact — clean (hash ${corpusArtifact.corpusHash}, corpus copy matches the web copy and a fresh engine run)`,
    )
    process.exit(0)
  }
  console.log(`check:analysis-artifact — ${failures.length} problem(s)`)
  for (const failure of failures) {
    console.log(`  - ${failure.message}`)
    console.log(`    fix: ${failure.hint}`)
  }
  process.exit(1)
}
