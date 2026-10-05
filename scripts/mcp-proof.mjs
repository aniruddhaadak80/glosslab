#!/usr/bin/env node
// A raw, readable MCP transcript against the real server over stdio.
//
// The contract test proves the protocol; this proves it to a human. It spawns
// `glosslab mcp serve`, speaks JSON-RPC by hand, and prints every frame, so the transcript in
// the README is a transcript rather than a claim.
//
//   node scripts/mcp-proof.mjs            # human summary
//   node scripts/mcp-proof.mjs --frames   # every JSON-RPC frame

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'packages', 'cli', 'dist', 'bin.js')
const SHOW_FRAMES = process.argv.includes('--frames')

const REQUESTS = [
  {
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-proof', version: '0.1.0' },
    },
  },
  { method: 'tools/list', params: {} },
  { method: 'tools/call', params: { name: 'segment_token', arguments: { word: 'kavm' } } },
  {
    method: 'tools/call',
    params: { name: 'segment_token', arguments: { word: 'xkavri' } },
  },
]

const child = spawn(process.execPath, [SERVER, 'mcp', 'serve'], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
let index = 0
const seen = []

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line.length > 0) {
      const frame = JSON.parse(line)
      seen.push(frame)
      report(frame)
    }
    newline = buffer.indexOf('\n')
  }
})

child.stderr.on('data', () => {
  /* the server logs to stderr; the transcript is stdout only */
})

function report(frame) {
  const request = REQUESTS[index - 1]
  if (SHOW_FRAMES) console.log(`<< ${JSON.stringify(frame)}`)

  if (frame.id !== undefined && request?.method === 'initialize') {
    console.log(
      `initialize        ok — ${frame.result?.serverInfo?.name} ${frame.result?.serverInfo?.version}`,
    )
  }
  if (frame.id !== undefined && request?.method === 'tools/list') {
    const names = (frame.result?.tools ?? []).map((tool) => tool.name)
    console.log(`tools/list        ${names.length} tools: ${names.join(', ')}`)
  }
  if (frame.id !== undefined && request?.method === 'tools/call') {
    const text = (frame.result?.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
    const value = JSON.parse(text)
    const label = request.params.name
    if (value.ok === true) {
      console.log(
        `tools/call        ${label}("kavm") -> ${value.morphemes
          .map((morpheme) => `${morpheme.morph}:${morpheme.gloss}`)
          .join('-')} score ${value.score}`,
      )
    } else {
      console.log(
        `tools/call        ${label}("xkavri") -> ok=false reason=${value.reason} failedAt=[${value.failedAt.join(',')}]`,
      )
    }
  }

  if (index < REQUESTS.length) {
    const next = REQUESTS[index]
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index, ...next })}\n`)
    if (SHOW_FRAMES) console.log(`>> ${JSON.stringify({ jsonrpc: '2.0', id: index, ...next })}`)
    index += 1
    return
  }
  child.stdin.end()
}

child.on('close', (code) => {
  const errors = seen.filter((frame) => frame.error !== undefined)
  console.log(`exit              code ${code}, ${seen.length} frames, ${errors.length} protocol errors`)
  process.exit(errors.length === 0 && code === 0 ? 0 : 1)
})

// Kick off the first request.
const first = REQUESTS[0]
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, ...first })}\n`)
if (SHOW_FRAMES) console.log(`>> ${JSON.stringify({ jsonrpc: '2.0', id: 0, ...first })}`)
index = 1
