import { createServer, createConnection, type Server } from 'net'
import { unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import type { ShellHookMessage } from '../types.js'

const RING_BUFFER_SIZE = 50

export class SocketServer {
  private server: Server | null = null
  private ringBuffer: ShellHookMessage[] = []
  private socketPath: string

  constructor(cwd: string) {
    this.socketPath = join(cwd, '.slagent', 'watch.sock')
  }

  getBuffer(): ShellHookMessage[] {
    return this.ringBuffer
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Clean up stale socket
      if (existsSync(this.socketPath)) {
        try {
          unlinkSync(this.socketPath)
        } catch {
          // Ignore
        }
      }

      this.server = createServer((conn) => {
        let data = ''
        conn.on('data', (chunk) => {
          data += chunk.toString()
        })
        conn.on('end', () => {
          try {
            const msg = JSON.parse(data)
            if (msg.type === 'command') {
              this.pushToBuffer(msg as ShellHookMessage)
              conn.end(JSON.stringify({ ok: true }))
            } else if (msg.type === 'status') {
              conn.end(JSON.stringify({
                ok: true,
                status: 'running',
                buffered: this.ringBuffer.length,
              }))
            } else if (msg.type === 'pipeline-lock') {
              // Informational - correlator checks lock file directly
              conn.end(JSON.stringify({ ok: true }))
            }
          } catch {
            conn.end(JSON.stringify({ ok: false, error: 'invalid message' }))
          }
        })
      })

      this.server.on('error', reject)
      this.server.listen(this.socketPath, () => resolve())
    })
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath)
      } catch {
        // Ignore
      }
    }
  }

  private pushToBuffer(msg: ShellHookMessage): void {
    this.ringBuffer.push(msg)
    if (this.ringBuffer.length > RING_BUFFER_SIZE) {
      this.ringBuffer.shift()
    }
  }
}

export async function notifyDaemon(cwd: string, msg: object): Promise<boolean> {
  const socketPath = join(cwd, '.slagent', 'watch.sock')
  if (!existsSync(socketPath)) return false

  return new Promise((resolve) => {
    const conn = createConnection(socketPath)
    conn.on('error', () => resolve(false))
    conn.on('connect', () => {
      conn.end(JSON.stringify(msg))
    })
    conn.on('data', () => {
      resolve(true)
    })
    setTimeout(() => {
      conn.destroy()
      resolve(false)
    }, 2000)
  })
}

export async function queryDaemonStatus(cwd: string): Promise<{ running: boolean; buffered?: number }> {
  const socketPath = join(cwd, '.slagent', 'watch.sock')
  if (!existsSync(socketPath)) return { running: false }

  return new Promise((resolve) => {
    const conn = createConnection(socketPath)
    let data = ''
    conn.on('error', () => resolve({ running: false }))
    conn.on('data', (chunk) => { data += chunk.toString() })
    conn.on('end', () => {
      try {
        const resp = JSON.parse(data)
        resolve({ running: resp.ok, buffered: resp.buffered })
      } catch {
        resolve({ running: false })
      }
    })
    conn.write(JSON.stringify({ type: 'status' }))
    conn.end()
    setTimeout(() => {
      conn.destroy()
      resolve({ running: false })
    }, 2000)
  })
}
