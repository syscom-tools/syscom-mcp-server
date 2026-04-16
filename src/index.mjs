#!/usr/bin/env node

/**
 * syscom-mcp-server — Zero-dependency MCP stdio bridge
 *
 * Conecta clientes MCP stdio (Claude Desktop, Cursor, OpenClaw, etc.)
 * al servidor MCP de Syscom via Streamable HTTP.
 *
 * Uso directo:
 *   MCP_TOKEN=tu_token npx syscom-mcp-server
 *
 * Configuracion en tu cliente MCP:
 *   {
 *     "mcpServers": {
 *       "syscom": {
 *         "command": "npx",
 *         "args": ["-y", "syscom-mcp-server"],
 *         "env": { "MCP_TOKEN": "tu_jwt_token" }
 *       }
 *     }
 *   }
 *
 * Variables de entorno:
 *   MCP_TOKEN  (requerido) — JWT de https://www.syscom.mx/mcp
 *   MCP_URL    (opcional)  — Default: https://www.syscom.mx/api/mcp
 */

import { stdin, stdout, stderr } from 'node:process'
import { createInterface } from 'node:readline'

const MCP_URL = process.env.MCP_URL || 'https://www.syscom.mx/api/mcp'
const MCP_TOKEN = process.env.MCP_TOKEN
const FETCH_TIMEOUT_MS = 60_000

if (!MCP_URL.startsWith('https://')) {
  stderr.write('[syscom-mcp] Error: MCP_URL debe usar HTTPS.\n')
  process.exit(1)
}

if (MCP_URL !== 'https://www.syscom.mx/api/mcp') {
  stderr.write(`[syscom-mcp] Advertencia: MCP_URL override -> ${MCP_URL}\n`)
}

if (!MCP_TOKEN) {
  stderr.write(
    '[syscom-mcp] Error: MCP_TOKEN es requerido.\n' +
      'Obten tu token en https://www.syscom.mx/mcp\n'
  )
  process.exit(1)
}

let sessionId = null

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
//
// Supports two framing modes (auto-detected from first chunk):
//   1. Newline-delimited JSON (NDJSON) — used by Claude Code, Claude Desktop
//   2. Content-Length framing (LSP-style) — used by some other MCP clients
// ---------------------------------------------------------------------------

let framing = null // 'ndjson' | 'content-length' — detected on first chunk
let readBuffer = ''
let rl = null

function startNDJSON() {
  framing = 'ndjson'
  // Drain anything already in readBuffer as lines
  if (readBuffer) {
    for (const line of readBuffer.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { handleMessage(JSON.parse(trimmed)) } catch {}
    }
    readBuffer = ''
  }
  // Switch to readline for subsequent input
  rl = createInterface({ input: stdin })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      handleMessage(JSON.parse(trimmed))
    } catch {
      stderr.write('[syscom-mcp] Malformed JSON from stdin\n')
    }
  })
  rl.on('close', () => {
    stdinEnded = true
    if (pending === 0) process.exit(0)
  })
}

function processContentLengthBuffer() {
  while (true) {
    const headerEnd = readBuffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return

    const header = readBuffer.slice(0, headerEnd)
    const match = header.match(/Content-Length:\s*(\d+)/i)
    if (!match) {
      readBuffer = readBuffer.slice(headerEnd + 4)
      continue
    }

    const contentLength = parseInt(match[1], 10)
    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + contentLength

    if (readBuffer.length < bodyEnd) return

    const body = readBuffer.slice(bodyStart, bodyEnd)
    readBuffer = readBuffer.slice(bodyEnd)

    try {
      handleMessage(JSON.parse(body))
    } catch {
      stderr.write('[syscom-mcp] Malformed JSON from stdin\n')
    }
  }
}

function sendToStdout(message) {
  if (framing === 'content-length') {
    const body = JSON.stringify(message)
    stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n${body}`)
  } else {
    stdout.write(JSON.stringify(message) + '\n')
  }
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

function parseSSEMessages(text) {
  const messages = []
  let currentData = ''

  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      currentData += line.slice(6)
    } else if (line === '' && currentData) {
      try {
        messages.push(JSON.parse(currentData))
      } catch {
        // skip malformed events
      }
      currentData = ''
    }
  }

  if (currentData) {
    try {
      messages.push(JSON.parse(currentData))
    } catch {
      // skip
    }
  }

  return messages
}

// ---------------------------------------------------------------------------
// HTTP forwarding
// ---------------------------------------------------------------------------

async function forwardToHttp(message) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${MCP_TOKEN}`,
  }

  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId
  }

  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  const newSessionId = response.headers.get('mcp-session-id')
  if (newSessionId) {
    sessionId = newSessionId
    stderr.write(`[syscom-mcp] Session: ${sessionId.slice(0, 8)}...\n`)
  }

  if (!response.ok) {
    const errorText = await response.text()
    stderr.write(`[syscom-mcp] HTTP ${response.status}: ${errorText}\n`)
    throw new Error(`HTTP ${response.status}`)
  }

  if (response.status === 202) return []

  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('text/event-stream')) {
    const text = await response.text()
    return parseSSEMessages(text)
  }

  if (contentType.includes('application/json')) {
    const json = await response.json()
    return Array.isArray(json) ? json : [json]
  }

  return []
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

let pending = 0
let stdinEnded = false

async function handleMessage(message) {
  pending++
  try {
    const responses = await forwardToHttp(message)
    for (const msg of responses) {
      sendToStdout(msg)
    }
  } catch (error) {
    stderr.write(`[syscom-mcp] Error: ${error.message}\n`)

    if (message.id !== undefined) {
      sendToStdout({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: `Bridge error: ${error.message}`,
        },
      })
    }
  } finally {
    pending--
    if (stdinEnded && pending === 0) process.exit(0)
  }
}

// ---------------------------------------------------------------------------
// Start — auto-detect framing from first chunk
// ---------------------------------------------------------------------------

stdin.setEncoding('utf-8')
stdin.on('data', (chunk) => {
  if (!framing) {
    // Detect framing mode from first data received.
    // Content-Length framing starts with "Content-Length:", NDJSON starts with "{"
    const trimmed = chunk.trimStart()
    if (trimmed.startsWith('Content-Length')) {
      framing = 'content-length'
      stderr.write('[syscom-mcp] Framing: Content-Length\n')
    } else {
      // NDJSON — hand off to readline, which takes over stdin
      stderr.write('[syscom-mcp] Framing: NDJSON\n')
      readBuffer = chunk
      startNDJSON()
      return
    }
  }

  if (framing === 'content-length') {
    readBuffer += chunk
    processContentLengthBuffer()
  }
})
stdin.on('end', () => {
  stdinEnded = true
  if (pending === 0) process.exit(0)
})

stderr.write(`[syscom-mcp] Running -> ${MCP_URL}\n`)
