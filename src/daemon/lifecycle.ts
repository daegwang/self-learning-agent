import { spawn } from 'child_process'
import { readFileSync, writeFileSync, unlinkSync, existsSync, openSync, closeSync } from 'fs'
import { join } from 'path'
import { queryDaemonStatus } from './socket-server.js'

export function daemonize(cwd: string): void {
  const slagentDir = join(cwd, '.slagent')
  const logPath = join(slagentDir, 'watch.log')
  const pidPath = join(slagentDir, 'watch.pid')

  const logFd = openSync(logPath, 'a')

  const child = spawn(process.execPath, [process.argv[1], 'watch', '--foreground'], {
    cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })

  child.unref()
  closeSync(logFd)

  if (child.pid) {
    writeFileSync(pidPath, String(child.pid))
    console.log(`Daemon started (PID ${child.pid})`)
    console.log(`Log: ${logPath}`)
  }
}

export function stopDaemon(cwd: string): boolean {
  const pidPath = join(cwd, '.slagent', 'watch.pid')

  if (!existsSync(pidPath)) {
    console.log('No daemon PID file found.')
    return false
  }

  const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)

  try {
    process.kill(pid, 'SIGTERM')
    console.log(`Stopped daemon (PID ${pid})`)
  } catch {
    console.log(`Process ${pid} not running.`)
  }

  try {
    unlinkSync(pidPath)
  } catch {
    // Already gone
  }

  return true
}

export async function getDaemonStatus(cwd: string): Promise<void> {
  const pidPath = join(cwd, '.slagent', 'watch.pid')

  if (!existsSync(pidPath)) {
    console.log('Status: not running (no PID file)')
    return
  }

  const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)

  // Check if process is alive
  let processAlive = false
  try {
    process.kill(pid, 0) // Signal 0 just checks existence
    processAlive = true
  } catch {
    processAlive = false
  }

  if (!processAlive) {
    console.log(`Status: dead (PID ${pid} not running)`)
    try { unlinkSync(pidPath) } catch { /* ignore */ }
    return
  }

  // Check socket connectivity
  const status = await queryDaemonStatus(cwd)
  if (status.running) {
    console.log(`Status: running (PID ${pid})`)
    console.log(`Buffered hook messages: ${status.buffered ?? 0}`)
  } else {
    console.log(`Status: running but socket unresponsive (PID ${pid})`)
  }
}
