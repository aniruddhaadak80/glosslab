import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { ValidationError } from '@glosslab/core'
import { BaseChannel, defaultRetry, type RetryPolicy } from './base.js'
import type { ProbeResult } from './types.js'

/**
 * The interlinear gloss channel — the export format field linguists actually exchange.
 *
 * A `.txt` interlinear gloss is the lingua franca here: ELAN, FLEx, Leex and NexusPLAS all
 * read it, and a consultant can read it. So the product's outbound surface is not "post a
 * message somewhere" but "hand the corpus to the tools that already exist", which is the
 * only outbound surface this product would ever be honest about claiming.
 */
export interface InterlinearOptions {
  readonly retry?: RetryPolicy
  /** Reject keys containing anything that is not a safe filename. */
  readonly maxKeyLength?: number
}

export class InterlinearChannel extends BaseChannel {
  readonly id = 'interlinear'
  readonly displayName = 'Interlinear gloss (.txt)'
  readonly requiresNetwork = false

  readonly #maxKeyLength: number

  constructor(options: InterlinearOptions = {}) {
    super(options.retry ?? defaultRetry)
    this.#maxKeyLength = options.maxKeyLength ?? 80
  }

  /** A gloss file is plain UTF-8 with a fixed three-line header. */
  static header(lines: readonly string[]): string {
    return ['# glosslab interlinear gloss', ...lines.map((line) => `# ${line}`), ''].join('\n')
  }

  /** Where one gloss file lands. Pure, so the CLI can print the path before writing. */
  resolve(target: string, idempotencyKey: string): string {
    if (target.trim().length === 0) {
      throw new ValidationError('target directory must not be empty', { field: 'target' })
    }
    if (!/^[A-Za-z0-9._-]+$/.test(idempotencyKey)) {
      throw new ValidationError(`idempotencyKey "${idempotencyKey}" is not a safe filename`, {
        field: 'idempotencyKey',
        hint: 'use letters, digits, dot, dash or underscore',
      })
    }
    if (idempotencyKey.length > this.#maxKeyLength) {
      throw new ValidationError(`idempotencyKey is longer than ${this.#maxKeyLength} characters`, {
        field: 'idempotencyKey',
      })
    }
    const directory = isAbsolute(target) ? target : join(process.cwd(), target)
    return join(directory, `${idempotencyKey}.txt`)
  }

  protected async deliver(
    target: string,
    message: { readonly text: string; readonly idempotencyKey: string },
  ): Promise<void> {
    const path = this.resolve(target, message.idempotencyKey)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, message.text, 'utf8')
  }

  protected override probeImpl(): ProbeResult {
    if (!this.running) {
      return {
        channel: this.id,
        status: 'warn',
        detail: 'configured but not started',
        fix: 'run the channel before exporting a gloss file',
      }
    }
    return {
      channel: this.id,
      status: 'ok',
      detail: 'ready to write .txt interlinear gloss files',
      ...(writable(process.cwd())
        ? {}
        : {
            status: 'fail' as const,
            detail: `${process.cwd()} is not writable`,
            fix: 'check directory permissions',
          }),
    }
  }
}

/** A probe helper that never throws, because `doctor` must always produce a report. */
function writable(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK)
    return true
  } catch {
    return false
  }
}
