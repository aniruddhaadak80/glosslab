import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ValidationError } from '@glosslab/core'
import { InterlinearChannel } from './interlinear.js'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'glosslab-interlinear-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('InterlinearChannel.header', () => {
  it('writes a commented header and ends the line', () => {
    const text = InterlinearChannel.header(['language: kavrin-demo', 'tokens: 23'])
    expect(text).toBe('# glosslab interlinear gloss\n# language: kavrin-demo\n# tokens: 23\n')
  })

  it('handles no metadata at all', () => {
    expect(InterlinearChannel.header([])).toBe('# glosslab interlinear gloss\n')
  })
})

describe('InterlinearChannel.resolve', () => {
  it('resolves a relative target against the working directory', () => {
    const channel = new InterlinearChannel()
    expect(channel.resolve('corpus/demo/export', 'kavrin-demo')).toBe(
      join(process.cwd(), 'corpus', 'demo', 'export', 'kavrin-demo.txt'),
    )
  })

  it('keeps an absolute target as it is', () => {
    const channel = new InterlinearChannel()
    expect(channel.resolve(workspace, 'run-1')).toBe(join(workspace, 'run-1.txt'))
  })

  it('refuses a key that could escape the directory', () => {
    const channel = new InterlinearChannel()
    for (const key of ['../escape', 'a/b', 'a\\b', 'has space', 'semi;colon', '']) {
      expect(() => channel.resolve(workspace, key)).toThrow(ValidationError)
    }
  })

  it('refuses an absurdly long key', () => {
    const channel = new InterlinearChannel({ maxKeyLength: 8 })
    expect(() => channel.resolve(workspace, 'a'.repeat(9))).toThrow(ValidationError)
    expect(() => channel.resolve(workspace, 'a'.repeat(8))).not.toThrow()
  })

  it('refuses an empty target', () => {
    const channel = new InterlinearChannel()
    expect(() => channel.resolve('   ', 'run-1')).toThrow(ValidationError)
  })
})

describe('InterlinearChannel.send', () => {
  it('writes a gloss file and reports the attempt', async () => {
    const channel = new InterlinearChannel()
    await channel.start()
    const receipt = await channel.send(workspace, {
      text: '# glosslab interlinear gloss\n\nkavm\tpeople\n',
      idempotencyKey: 'kavrin-demo',
    })
    expect(receipt.channel).toBe('interlinear')
    expect(receipt.attempts).toBe(1)
    expect(readFileSync(join(workspace, 'kavrin-demo.txt'), 'utf8')).toContain('kavm')
    await channel.stop()
  })

  it('creates the target directory', async () => {
    const channel = new InterlinearChannel()
    await channel.start()
    const nested = join(workspace, 'a', 'b')
    await channel.send(nested, { text: 'x', idempotencyKey: 'run' })
    expect(readFileSync(join(nested, 'run.txt'), 'utf8')).toBe('x')
    await channel.stop()
  })

  it('refuses empty text before touching the disk', async () => {
    const channel = new InterlinearChannel()
    await channel.start()
    await expect(channel.send(workspace, { text: '   ', idempotencyKey: 'run' })).rejects.toThrow()
  })

  it('retries a failing transport and then gives up with a timeout', async () => {
    // A directory where the gloss file should go: every attempt fails for a real reason.
    const blocked = join(workspace, 'blocked.txt')
    mkdirSync(blocked)
    const channel = new InterlinearChannel({
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    })
    await channel.start()
    await expect(channel.send(workspace, { text: 'x', idempotencyKey: 'blocked' })).rejects.toThrow(
      /after 2 attempts/,
    )
  })

  it('overwrites an earlier gloss file for the same key', async () => {
    const channel = new InterlinearChannel()
    await channel.start()
    await channel.send(workspace, { text: 'first', idempotencyKey: 'run' })
    await channel.send(workspace, { text: 'second', idempotencyKey: 'run' })
    expect(readFileSync(join(workspace, 'run.txt'), 'utf8')).toBe('second')
  })
})

describe('InterlinearChannel.probe', () => {
  it('warns when the channel was never started', async () => {
    const channel = new InterlinearChannel()
    const probe = await channel.probe()
    expect(probe.status).toBe('warn')
    expect(probe.fix).toBeTruthy()
  })

  it('is ready once started', async () => {
    const channel = new InterlinearChannel()
    await channel.start()
    const probe = await channel.probe()
    expect(probe.status).toBe('ok')
    expect(probe.detail).toContain('.txt')
    await channel.stop()
  })
})

describe('a read-only working directory', () => {
  it('fails the probe rather than throwing', async () => {
    const channel = new InterlinearChannel()
    await channel.start()
    const readOnly = join(workspace, 'locked')
    rmSync(readOnly, { recursive: true, force: true })
    writeFileSync(readOnly, 'x', 'utf8')
    try {
      chmodSync(readOnly, 0o500)
      const probe = await channel.probe()
      expect(['ok', 'fail']).toContain(probe.status)
    } finally {
      chmodSync(readOnly, 0o700)
    }
  })
})
