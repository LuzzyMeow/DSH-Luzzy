// Minimal MCP stdio client, to drive AOCI against THIS workspace.
//
// WHY A HAND-ROLLED CLIENT
//
// The installed AOCI MCP server is launched from the global config with a hard-coded
// `--repo D:\.NekoTool\LuzzyRP`. Every `aoci_*` MCP tool in this session therefore operates on
// THAT repository — verified: `aoci_maintain` reported `runtime_repository_root =
// D:\.NekoTool\LuzzyRP` and listed files from that project, not from this one.
//
// The CLI authoring paths cannot substitute: `aoci index agent plan` answers
// `error_code: config` with "该命令或兼容写入路径不支持修改Volumes v1正式认知". So for a
// Volumes v1 repository, MCP is the ONLY authoring surface.
//
// Spawning the same binary with `--repo <this workspace>` does not touch any global config — it
// just runs the server against a different root. That is the whole point of this file.
import { spawn } from 'node:child_process'

const AOCI = 'C:\\Users\\Administrator\\.aoci\\bin\\aoci.exe'

export async function connect({ repo, timeoutMs = 180_000 } = {}) {
  const child = spawn(AOCI, ['--repo', repo, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })

  let buffer = ''
  const pending = new Map()
  let nextId = 0
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))

  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    // MCP over stdio is newline-delimited JSON-RPC.
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve } = pending.get(message.id)
        pending.delete(message.id)
        resolve(message)
      }
    }
  })

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer)
          resolve(message)
        },
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'luzzy-aoci-client', version: '1.0.0' },
  })
  notify('notifications/initialized', {})

  return {
    child,
    init,
    stderr,
    send,
    notify,
    async callTool(name, args = {}) {
      const message = await send('tools/call', { name, arguments: args })
      if (message.error) throw new Error(`${name}: ${JSON.stringify(message.error)}`)
      const content = message.result?.content ?? []
      const text = content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      return { isError: message.result?.isError === true, text, raw: message }
    },
    close() {
      try { child.stdin.end() } catch { /* already closed */ }
      try { child.kill() } catch { /* already gone */ }
    },
  }
}
