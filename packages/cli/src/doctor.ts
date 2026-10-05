import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadCatalog } from '@glosslab/skills'
import { buildRegistry as buildPluginRegistry } from '@glosslab/plugins'
import { createClient, resolveCorpusPaths } from '@glosslab/engine-client'
import { MorphologyProjection, Store } from '@glosslab/memory'

export type Status = 'ok' | 'warn' | 'fail'

export interface Check {
  readonly name: string
  readonly status: Status
  readonly detail: string
  readonly fix?: string
}

export interface DoctorReport {
  readonly ok: boolean
  readonly checks: readonly Check[]
}

const pkg = { name: 'glosslab', version: '0.1.0' }

/** The engine has to answer for real, or nothing downstream is trustworthy. */
async function engineCheck(cwd: string): Promise<Check> {
  // A directory with no engine source is not a broken install, it is not a checkout — a
  // fixture, or the web app. That is a warning. An engine that is present and fails is a
  // failure, because then the product really is broken.
  if (!existsSync(join(cwd, 'services', 'engine', 'src', 'glosslab'))) {
    return {
      name: 'engine',
      status: 'warn',
      detail: `no engine source under ${join(cwd, 'services', 'engine', 'src')}`,
      fix: 'run glosslab from inside the repository, or pass --root',
    }
  }

  try {
    const paths = resolveCorpusPaths(cwd)
    const morphology = createClient(cwd)
    // The probe word and the probe lexicon have to agree, or the probe would be testing
    // the engine's ability to fail rather than its ability to answer.
    const result = await morphology.segment({
      word: 'kav',
      lexemes: [
        {
          id: 'probe',
          morph: 'kav',
          type: 'stem',
          gloss: 'person',
          weight: 1,
          priority: 1,
          features: {},
        },
      ],
    })
    const reading = result.morphemes.map((morpheme) => morpheme.morph).join('-')
    return {
      name: 'engine',
      status: result.ok ? 'ok' : 'fail',
      detail: result.ok
        ? `python engine answered (kav -> ${reading})`
        : `python engine refused a word its own lexicon covers: ${result.reason ?? 'unknown'}`,
      ...(result.ok && !existsSync(paths.artifact) ? { fix: 'run "glosslab analyze --write"' } : {}),
    }
  } catch (cause) {
    return {
      name: 'engine',
      status: 'fail',
      detail: `python engine unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      fix: 'install Python 3.11+ and run "python -m pytest services/engine" to confirm the engine',
    }
  }
}

/** The projection is derived, so a missing database is a warning, never a failure. */
function memoryCheck(): Check {
  try {
    const store = new Store(':memory:')
    const version = store.version
    const tables = (
      store.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
    ).length
    new MorphologyProjection(store).tokens()
    store.close()
    return { name: 'memory', status: 'ok', detail: `sqlite schema v${version}, ${tables} tables` }
  } catch (cause) {
    return {
      name: 'memory',
      status: 'warn',
      detail: `sqlite unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      fix: 'better-sqlite3 needs a prebuilt binary for this platform; run "npm rebuild better-sqlite3"',
    }
  }
}

/**
 * The flagship command. An agent that mutates its own configuration must be able to
 * diagnose itself, and every failing row carries a fix hint rather than only a status.
 */
export async function doctor(cwd = process.cwd()): Promise<DoctorReport> {
  const checks: Check[] = []

  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push(
    nodeMajor >= 22
      ? { name: 'node', status: 'ok', detail: `v${process.versions.node}` }
      : {
          name: 'node',
          status: 'fail',
          detail: `v${process.versions.node} is below the required v22.12.0`,
          fix: 'install Node 22.12 or newer (see .nvmrc)',
        },
  )

  checks.push({
    name: 'package',
    status: 'ok',
    detail: `${pkg.name}@${pkg.version}`,
  })

  const skills = loadCatalog(join(cwd, 'skills'))
  checks.push(
    skills.issues.length === 0
      ? { name: 'skills', status: 'ok', detail: `${skills.skills.length} skills, 0 invalid` }
      : {
          name: 'skills',
          status: 'fail',
          detail: `${skills.skills.length} valid, ${skills.issues.length} invalid`,
          fix: skills.issues[0] ?? 'see npm run check:skill-version',
        },
  )

  const plugins = buildPluginRegistry(join(cwd, 'plugins'))
  checks.push(
    plugins.rejected.length === 0
      ? {
          name: 'plugins',
          status: 'ok',
          detail: `${plugins.active.length} active, ${plugins.disabled.length} disabled`,
        }
      : {
          name: 'plugins',
          status: 'warn',
          detail: `${plugins.rejected.length} rejected`,
          fix: plugins.rejected[0]?.issues[0] ?? 'inspect plugins/*/plugin.json',
        },
  )

  const configPath = join(cwd, 'product.config.json')
  checks.push(
    existsSync(configPath)
      ? { name: 'config', status: 'ok', detail: 'product.config.json found' }
      : {
          name: 'config',
          status: 'warn',
          detail: 'no product.config.json — using defaults',
          fix: 'run with defaults, or create product.config.json',
        },
  )

  checks.push(memoryCheck())
  checks.push(await engineCheck(cwd))

  return { ok: checks.every((c) => c.status !== 'fail'), checks }
}

export function renderReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length), 5)
  const icon = (status: Status): string => (status === 'ok' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL')
  const lines = report.checks.map((c) => {
    const head = `  [${icon(c.status)}] ${c.name.padEnd(width)}  ${c.detail}`
    return c.fix === undefined ? head : `${head}\n         fix: ${c.fix}`
  })
  return [
    `${pkg.name} doctor`,
    ...lines,
    '',
    report.ok ? 'all required checks passed' : 'one or more checks failed',
  ].join('\n')
}
