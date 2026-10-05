import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from 'commander'
import {
  loadCorpusFile,
  loadCorpusInput,
  readArtifact,
  resolveCorpusPaths,
  writeArtifact,
  type CorpusFile,
} from '@glosslab/engine-client'
import { ValidationError, type CorpusAnalysis } from '@glosslab/core'
import { InterlinearChannel } from '@glosslab/channels'
import { renderPlan, renderSummary, renderToken, type PaintOptions } from './render.js'
import { runTui, mapKey, type TuiKey } from './tui.js'

/**
 * The product commands. Each one is thin: read, call the engine, render. The logic lives in
 * the engine and in `render.ts`, so there is exactly one place where any of it can be wrong.
 */

export const GLOSSLAB_VERSION = '0.1.0'

function colourFor(): PaintOptions {
  return { colour: Boolean(process.stdout.isTTY) && process.env['NO_COLOR'] === undefined }
}

function emit(text: string): void {
  process.stdout.write(`${text}\n`)
}

/** Read the committed artifact. Prefer it so the CLI and the deployed web app agree. */
function loadAnalysis(root: string): CorpusAnalysis {
  const paths = resolveCorpusPaths(root)
  if (!existsSync(paths.artifact)) {
    throw new ValidationError('no committed artifact yet — run "glosslab analyze --write" first', {
      hint: 'glosslab analyze --write',
      corpus: paths.corpus,
    })
  }
  return readArtifact(paths.artifact)
}

/** Run the real engine over the corpus on disk. */
async function freshAnalysis(root: string): Promise<CorpusAnalysis> {
  const { createClient } = await import('@glosslab/engine-client')
  const paths = resolveCorpusPaths(root)
  return await createClient(paths.root).analyzeCorpus(loadCorpusInput(paths.corpus))
}

/** Rebuild the artifact by running the real engine, then compare with what is committed. */
export function registerAnalyze(program: Command): void {
  program
    .command('analyze')
    .description('run the engine over the corpus and (re)generate the committed artifact')
    .option('--write', 'write corpus/demo/analysis.json and the web app copy', false)
    .option('--refresh', 're-run the engine even when the artifact exists', false)
    .option('--json', 'machine-readable output')
    .action(async (options: { write: boolean; refresh: boolean; json: boolean }) => {
      const paths = resolveCorpusPaths(process.cwd())
      const analysis =
        options.refresh || options.write || !existsSync(paths.artifact)
          ? await freshAnalysis(paths.root)
          : readArtifact(paths.artifact)

      const written: string[] = []
      if (options.write) {
        const { mkdirSync } = await import('node:fs')
        const { webArtifactPath } = await import('@glosslab/engine-client')
        writeArtifact(paths.artifact, analysis)
        written.push(paths.artifact)
        // The web app is deployed on its own, so it gets its own committed copy.
        const webCopy = webArtifactPath(paths.root)
        mkdirSync(join(webCopy, '..'), { recursive: true })
        writeArtifact(webCopy, analysis)
        written.push(webCopy)
        if (!options.json) for (const path of written) emit(`wrote ${path}`)
      }

      const committed = existsSync(paths.artifact) ? readArtifact(paths.artifact) : null
      const stale = committed !== null && committed.corpusHash !== analysis.corpusHash
      if (options.json) {
        emit(JSON.stringify({ analysis, written, stale }, null, 2))
      } else {
        emit(renderSummary(analysis, colourFor()))
        if (stale) emit('  note: the committed artifact is stale — re-run with --write')
        if (committed === null) emit('  note: no committed artifact yet — re-run with --write')
      }
      if (stale) process.exitCode = 1
    })
}

/** One word through the segmenter, with the ambiguity rivals shown. */
export function registerSegment(program: Command): void {
  program
    .command('segment')
    .description('segment one word against the corpus lexicon')
    .argument('<word>', 'the surface form to segment')
    .option('--json', 'machine-readable output')
    .action(async (word: string, options: { json: boolean }) => {
      const paths = resolveCorpusPaths(process.cwd())
      const corpus = loadCorpusFile(paths.corpus)
      const { createClient } = await import('@glosslab/engine-client')
      const result = await createClient(paths.root).segment({
        word,
        lexemes: corpus.lexemes,
        grammar: corpus.grammar,
      })
      if (options.json) {
        emit(JSON.stringify(result, null, 2))
        return
      }
      if (!result.ok) {
        emit(`${word}: no reading (${result.reason ?? 'unknown'})`)
        emit(`  characters with no reading: ${result.failedAt.join(', ') || 'none'}`)
        process.exitCode = 1
        return
      }
      // The renderer works on corpus tokens, so give it the one word as a one-row corpus.
      emit(
        renderToken(
          {
            id: 'cli',
            form: result.word,
            gloss: '',
            provenance: 'cli',
            ok: result.ok,
            reason: result.reason,
            featureIssue: null,
            score: result.score,
            ambiguous: result.ambiguous,
            gapCount: result.gapCount,
            morphemes: result.morphemes,
            alternates: result.alternates,
          },
          colourFor(),
        ),
      )
    })
}

/** The plan and its certificate, straight from the committed artifact. */
export function registerPlan(program: Command): void {
  program
    .command('plan')
    .description('show the review plan and its feasibility certificate')
    .option('--json', 'machine-readable output')
    .option('--refresh', 're-run the engine instead of reading the artifact', false)
    .action(async (options: { json: boolean; refresh: boolean }) => {
      const paths = resolveCorpusPaths(process.cwd())
      const analysis = options.refresh ? await freshAnalysis(paths.root) : loadAnalysis(paths.root)
      if (options.json) {
        emit(JSON.stringify(analysis.plan, null, 2))
        return
      }
      emit(renderPlan(analysis.plan, colourFor()))
      if (!analysis.plan.certificate.verified) process.exitCode = 1
    })
}

/** Hand the corpus to ELAN/FLEx/NexusPLAS as an interlinear gloss file. */
export function registerExport(program: Command): void {
  program
    .command('export')
    .description('write an interlinear gloss file through the interlinear channel')
    .argument('[outdir]', 'directory to write into', 'corpus/demo/export')
    .option('--name', 'file name without the extension', 'kavrin-demo')
    .option('--dry-run', 'print the path instead of writing', false)
    .action(async (outdir: string, options: { name: string; dryRun: boolean }) => {
      const paths = resolveCorpusPaths(process.cwd())
      const analysis = loadAnalysis(paths.root)
      const corpus = loadCorpusFile(paths.corpus)
      const channel = new InterlinearChannel()
      const path = channel.resolve(outdir, options.name)
      if (options.dryRun) {
        emit(path)
        return
      }
      await channel.start()
      const receipt = await channel.send(outdir, {
        text: glossDocument(corpus, analysis),
        idempotencyKey: options.name,
      })
      await channel.stop()
      emit(`wrote ${path} (attempts ${receipt.attempts})`)
    })
}

/** The whole corpus as one gloss document: the standard three-line-per-token layout. */
export function glossDocument(corpus: CorpusFile, analysis: CorpusAnalysis): string {
  const lines = [
    `language: ${corpus.language}`,
    `label: ${corpus.label}`,
    `corpus-hash: ${analysis.corpusHash}`,
    `tokens: ${analysis.stats['tokens'] ?? 0}`,
    `review-nodes: ${analysis.stats['reviewNodes'] ?? 0}`,
    `certificate-verified: ${String(analysis.plan.certificate.verified)}`,
  ]
  const body = analysis.tokens.map((token) => {
    const gloss = token.morphemes.map((morpheme) => morpheme.gloss).join(' ')
    const types = token.morphemes.map((morpheme) => morpheme.type).join(' ')
    return [token.form, token.gloss, gloss, types, token.ok ? String(token.score) : 'UNSEG'].join('\t')
  })
  return `${InterlinearChannel.header(lines)}\n${body.join('\n')}\n`
}
/** The skill catalog, with every validation issue named. */
export function registerSkills(program: Command): void {
  program
    .command('skills')
    .description('list the skill catalog and any validation issues')
    .option('--json', 'machine-readable output')
    .action(async (options: { json: boolean }) => {
      const { loadCatalog } = await import('@glosslab/skills')
      const { skills, issues } = loadCatalog(join(resolveCorpusPaths(process.cwd()).root, 'skills'))
      if (options.json) {
        emit(JSON.stringify({ count: skills.length, issues, skills }, null, 2))
        return
      }
      for (const skill of skills) {
        emit(`  ${skill.name.padEnd(24)} ${skill.version.padEnd(8)} ${skill.description}`)
      }
      for (const issue of issues) emit(`  [invalid] ${issue}`)
      if (issues.length > 0) process.exitCode = 1
    })
}

/** The plugin registry, including everything that was shadowed or rejected, and why. */
export function registerPlugins(program: Command): void {
  program
    .command('plugins')
    .description('show the resolved plugin registry and the reason for every decision')
    .option('--json', 'machine-readable output')
    .action(async (options: { json: boolean }) => {
      const { buildRegistry } = await import('@glosslab/plugins')
      const registry = buildRegistry(join(resolveCorpusPaths(process.cwd()).root, 'plugins'))
      if (options.json) {
        emit(
          JSON.stringify(
            {
              active: registry.active.map((plugin) => ({
                name: plugin.manifest.name,
                version: plugin.manifest.version,
                capabilities: plugin.manifest.capabilities,
                shadowed: plugin.shadowed,
              })),
              disabled: registry.disabled.map((plugin) => plugin.manifest.name),
              rejected: registry.rejected,
            },
            null,
            2,
          ),
        )
        return
      }
      for (const plugin of registry.active) {
        const shadowed = plugin.shadowed.length === 0 ? '' : ` shadows ${plugin.shadowed.join(', ')};`
        emit(
          `  ${plugin.manifest.name.padEnd(24)} ${plugin.manifest.version.padEnd(8)} ${plugin.manifest.capabilities.join(', ')}${shadowed}`,
        )
      }
      for (const plugin of registry.disabled) emit(`  [disabled] ${plugin.manifest.name}`)
      for (const rejection of registry.rejected) {
        emit(`  [rejected] ${rejection.path}: ${rejection.issues.join('; ')}`)
      }
    })
}

/**
 * Invoke one tool without the MCP transport. The same registry, the same handler, the same
 * error codes — only the transport differs, which is the point of the narrow waist.
 */
export function registerRun(program: Command): void {
  program
    .command('run')
    .description('invoke a tool directly, without MCP')
    .argument('<tool>', 'tool name')
    .option('--input <json>', 'JSON input document', '{}')
    .action(async (tool: string, options: { input: string }) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(options.input)
      } catch (cause) {
        process.stderr.write(`error: --input is not valid JSON — ${String(cause)}\n`)
        process.exitCode = 2
        return
      }
      const { buildToolRegistry, createContext } = await import('./bootstrap.js')
      const registry = buildToolRegistry()
      try {
        const value = await registry.invoke(tool, parsed, createContext('cli'), [
          'fs:read',
          'fs:write',
          'net:fetch',
          'proc:spawn',
        ])
        emit(JSON.stringify(value ?? null, null, 2))
      } catch (cause) {
        const code = (cause as { code?: string }).code ?? 'INTERNAL'
        process.stderr.write(`${code}: ${cause instanceof Error ? cause.message : String(cause)}\n`)
        process.exitCode = 1
      }
    })
}

/** Materialise the SQLite projection so queries never re-run the engine. */
export function registerProject(program: Command): void {
  program
    .command('project')
    .description('build the SQLite projection of the analysis and report what it holds')
    .option('--db', 'database file', '.data/glosslab.sqlite')
    .option('--json', 'machine-readable output')
    .action(async (options: { db: string; json: boolean }) => {
      const paths = resolveCorpusPaths(process.cwd())
      const analysis = loadAnalysis(paths.root)
      const { mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')
      mkdirSync(dirname(options.db), { recursive: true })

      const { MorphologyProjection, Store } = await import('@glosslab/memory')
      const store = new Store(options.db)
      const projection = new MorphologyProjection(store)
      const result = projection.replace(analysis)

      if (options.json) {
        emit(JSON.stringify({ ...result, database: options.db, version: store.version }, null, 2))
      } else {
        emit(`projected ${result.tokens} tokens, ${result.morphemes} morphemes into ${options.db}`)
        emit(`  review nodes ${result.reviewNodes}, assignments ${result.assignments}`)
        emit(`  corpus hash ${result.corpusHash}, schema v${store.version}`)
      }
      store.close()
    })
}

/** The split-pane terminal interface over the corpus. */
export function registerTui(program: Command): void {
  program
    .command('tui')
    .description('browse the morpheme trees in the terminal')
    .option('--height', 'rows to draw', '20')
    .option('--refresh', 're-run the engine instead of reading the artifact', false)
    .action(async (options: { height: string; refresh: boolean }) => {
      const paths = resolveCorpusPaths(process.cwd())
      const analysis = options.refresh ? await freshAnalysis(paths.root) : loadAnalysis(paths.root)

      if (!process.stdin.isTTY) {
        emit('tui needs a terminal; use --json on the other commands for scripting')
        process.exitCode = 2
        return
      }

      const height = Math.max(Number.parseInt(options.height, 10) || 20, 8)
      const stdin = process.stdin
      // Raw mode, because a line-buffered TTY would swallow one keypress per line.
      stdin.setRawMode?.(true)
      stdin.resume()

      try {
        await runTui(
          analysis,
          {
            write: (text) => process.stdout.write(text),
            readKey: async () =>
              await new Promise<TuiKey | null>((resolve) => {
                const onData = (chunk: Buffer) => {
                  stdin.off('data', onData)
                  resolve(mapKey(chunk.toString('utf8')))
                }
                stdin.once('data', onData)
              }),
          },
          colourFor(),
          height,
        )
      } finally {
        stdin.setRawMode?.(false)
        stdin.pause()
      }
    })
}
