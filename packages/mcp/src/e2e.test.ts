import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { McpClient } from './client.js'

/**
 * The MCP surface, proven rather than asserted.
 *
 * This starts the real server as a child process over stdio, speaks the real protocol through
 * the SDK client, lists the tools and calls one that reaches the Python engine. If the
 * protocol regresses, this is the test that fails.
 *
 * Note there is no import of the CLI here: the registry is assembled by the CLI, so importing
 * it would be a cycle. Instead the CLI's own `tools --json` is compared against the protocol's
 * `tools/list` — which is a stronger check anyway, because it proves the two surfaces really
 * do expose the same capabilities rather than merely sharing a function.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const SERVER = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url))

function cliToolNames(): string[] {
  const raw = execFileSync(process.execPath, [SERVER, 'tools', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return (JSON.parse(raw) as { name: string }[]).map((tool) => tool.name).sort()
}

interface Connected {
  client: McpClient
  close: () => Promise<void>
}

async function connectServer(): Promise<Connected> {
  const client = new McpClient()
  await client.connect({
    id: 'glosslab',
    command: process.execPath,
    args: [SERVER, 'mcp', 'serve'],
    enabled: true,
    // The server resolves the corpus relative to its working directory.
    cwd: ROOT,
  })
  return { client, close: async () => client.close() }
}

describe('the CLI and the MCP server agree', () => {
  it('expose the same seven tools', async () => {
    const fromCli = cliToolNames()
    expect(fromCli).toEqual([
      'analyze_corpus',
      'list_plugins',
      'list_skills',
      'schedule_review',
      'segment_token',
      'unify_features',
      'verify_review_plan',
    ])

    const { client, close } = await connectServer()
    try {
      const fromMcp = (await client.listTools()).map((tool) => tool.name).sort()
      expect(fromMcp).toEqual(fromCli)
    } finally {
      await close()
    }
  }, 120_000)
})

describe('MCP over stdio', () => {
  it('initializes, lists the tools, and calls one that reaches the engine', async () => {
    const { client, close } = await connectServer()
    try {
      const tools = await client.listTools()
      const names = tools.map((tool) => tool.name)

      expect(names).toContain('segment_token')
      expect(names).toContain('analyze_corpus')
      expect(names.length).toBeGreaterThanOrEqual(5)

      // Every description is written for a model: what it does, when to use it, what it gives.
      for (const tool of tools) {
        expect(tool.description.length).toBeGreaterThan(40)
        expect(tool.inputSchema['type']).toBe('object')
      }

      const result = (await client.callTool('segment_token', { word: 'kavm' })) as {
        ok: boolean
        morphemes: { morph: string }[]
        score: number
      }
      expect(result.ok).toBe(true)
      expect(result.morphemes.map((morpheme) => morpheme.morph)).toEqual(['kav', 'm'])
      expect(result.score).toBeCloseTo(4, 6)
    } finally {
      await close()
    }
  }, 120_000)

  it('reports an uncovered word as a real answer, not an error', async () => {
    const { client, close } = await connectServer()
    try {
      const result = (await client.callTool('segment_token', { word: 'xkavri' })) as {
        ok: boolean
        reason: string
      }
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('unsegmentable')
    } finally {
      await close()
    }
  }, 120_000)

  it('returns an error envelope for invalid input instead of crashing', async () => {
    const { client, close } = await connectServer()
    try {
      await expect(client.callTool('segment_token', { word: '' })).rejects.toThrow()
    } finally {
      await close()
    }
  }, 120_000)

  it('serves a verified review plan over the protocol', async () => {
    const { client, close } = await connectServer()
    try {
      const result = (await client.callTool('schedule_review', {
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
      })) as { ok: boolean; certificate: { verified: boolean } }

      expect(result.ok).toBe(true)
      expect(result.certificate.verified).toBe(true)
    } finally {
      await close()
    }
  }, 120_000)

  it('reports the skill catalog', async () => {
    const { client, close } = await connectServer()
    try {
      const result = (await client.callTool('list_skills', {})) as {
        count: number
        skills: { name: string; version: string }[]
      }
      expect(result.count).toBeGreaterThanOrEqual(2)
      for (const skill of result.skills) expect(skill.version).toMatch(/^\d+\.\d+\.\d+$/)
    } finally {
      await close()
    }
  }, 120_000)

  it('keeps no state between calls', async () => {
    const { client, close } = await connectServer()
    try {
      const first = (await client.callTool('segment_token', { word: 'kav' })) as { score: number }
      await client.callTool('segment_token', { word: 'nakav' })
      const again = (await client.callTool('segment_token', { word: 'kav' })) as { score: number }
      expect(again.score).toBe(first.score)
    } finally {
      await close()
    }
  }, 120_000)
})
