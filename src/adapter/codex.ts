import { readdir, stat, readFile } from 'fs/promises'
import { join, basename } from 'path'
import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { execSync } from 'child_process'
import type { Adapter, GlobalSessionInfo, GlobalAdapterEvent } from './types.js'
import type { AdapterEvent, FileEditEvent, CommandRunEvent, TestResultEvent } from '../types.js'

export class CodexAdapter implements Adapter {
  name = 'codex'
  private lastOffsets = new Map<string, number>()
  private cwdCache = new Map<string, string>() // filePath → cwd

  private getSessionsDir(): string | null {
    const home = process.env.HOME || process.env.USERPROFILE || '~'
    const dir = join(home, '.codex', 'sessions')
    return existsSync(dir) ? dir : null
  }

  private getSessionCwd(filePath: string): string | null {
    if (this.cwdCache.has(filePath)) {
      return this.cwdCache.get(filePath)!
    }

    try {
      const content = readFileSync(filePath, 'utf-8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === 'session_meta' && parsed.payload?.cwd) {
            this.cwdCache.set(filePath, parsed.payload.cwd)
            return parsed.payload.cwd
          }
        } catch {
          continue
        }
      }
    } catch {
      // ignore
    }
    return null
  }

  private walkSessionFiles(sessionsDir: string): string[] {
    const files: string[] = []
    try {
      // Walk YYYY/MM/DD subdirectory structure
      for (const year of readdirSync(sessionsDir)) {
        const yearPath = join(sessionsDir, year)
        if (!statSync(yearPath).isDirectory() || !/^\d{4}$/.test(year)) continue
        for (const month of readdirSync(yearPath)) {
          const monthPath = join(yearPath, month)
          if (!statSync(monthPath).isDirectory() || !/^\d{2}$/.test(month)) continue
          for (const day of readdirSync(monthPath)) {
            const dayPath = join(monthPath, day)
            if (!statSync(dayPath).isDirectory() || !/^\d{2}$/.test(day)) continue
            for (const file of readdirSync(dayPath)) {
              if (file.endsWith('.jsonl')) {
                files.push(join(dayPath, file))
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
    return files
  }

  private findProjectSessions(cwd: string): string[] {
    const sessionsDir = this.getSessionsDir()
    if (!sessionsDir) return []

    const allFiles = this.walkSessionFiles(sessionsDir)
    return allFiles.filter(f => this.getSessionCwd(f) === cwd)
  }

  async detectActivity(cwd: string): Promise<boolean> {
    if (this.isCliRunning(cwd)) return true

    // Check for recently modified sessions matching this cwd
    const sessions = this.findProjectSessions(cwd)
    const cutoff = Date.now() - 5 * 60 * 1000
    for (const filePath of sessions) {
      try {
        const st = statSync(filePath)
        if (st.mtimeMs > cutoff) return true
      } catch {
        // ignore
      }
    }

    return false
  }

  isCliRunning(cwd: string): boolean {
    try {
      const pids = execSync('pgrep -x codex 2>/dev/null', { encoding: 'utf-8', timeout: 3000 })
        .trim()
        .split('\n')
        .filter(Boolean)

      for (const pid of pids) {
        try {
          const processCwd = execSync(
            `lsof -a -p ${pid} -d cwd -Fn 2>/dev/null | grep "^n" | sed 's/^n//'`,
            { encoding: 'utf-8', timeout: 3000 },
          ).trim()

          if (processCwd === cwd) return true
        } catch {
          // Can't inspect this PID
        }
      }
    } catch {
      // pgrep not found or no matches
    }

    return false
  }

  getActiveSessionId(cwd: string): string | null {
    const sessions = this.findProjectSessions(cwd)
    if (sessions.length === 0) return null

    // Find most recently modified
    let newest = sessions[0]
    let newestMtime = 0
    for (const f of sessions) {
      try {
        const st = statSync(f)
        if (st.mtimeMs > newestMtime) {
          newestMtime = st.mtimeMs
          newest = f
        }
      } catch {
        // ignore
      }
    }

    return this.extractSessionId(newest)
  }

  getActiveSessionPath(cwd: string): string | null {
    const sessions = this.findProjectSessions(cwd)
    if (sessions.length === 0) return null

    let newest = sessions[0]
    let newestMtime = 0
    for (const f of sessions) {
      try {
        const st = statSync(f)
        if (st.mtimeMs > newestMtime) {
          newestMtime = st.mtimeMs
          newest = f
        }
      } catch {
        // ignore
      }
    }

    return newest
  }

  async poll(cwd: string, since: number): Promise<AdapterEvent[]> {
    const sessionsDir = this.getSessionsDir()
    if (!sessionsDir) return []

    const events: AdapterEvent[] = []
    const allFiles = this.walkSessionFiles(sessionsDir)

    for (const filePath of allFiles) {
      try {
        const st = await stat(filePath)
        if (st.mtimeMs < since) continue
      } catch {
        continue
      }

      // Check if this session belongs to our cwd
      const sessionCwd = this.getSessionCwd(filePath)
      if (sessionCwd !== cwd) continue

      const sessionId = this.extractSessionId(filePath)
      const newEvents = await this.readNewLines(filePath, sessionId)
      events.push(...newEvents)
    }

    return events
  }

  async getAllActiveSessions(): Promise<GlobalSessionInfo[]> {
    const sessionsDir = this.getSessionsDir()
    if (!sessionsDir) return []

    const cutoff = Date.now() - 5 * 60 * 1000
    const allFiles = this.walkSessionFiles(sessionsDir)
    const results: GlobalSessionInfo[] = []

    // Group by cwd, keep newest per cwd
    const byCwd = new Map<string, { path: string; mtime: number; sessionId: string }>()

    for (const filePath of allFiles) {
      try {
        const st = statSync(filePath)
        if (st.mtimeMs < cutoff) continue

        const cwd = this.getSessionCwd(filePath)
        if (!cwd) continue

        const existing = byCwd.get(cwd)
        if (!existing || st.mtimeMs > existing.mtime) {
          byCwd.set(cwd, {
            path: filePath,
            mtime: st.mtimeMs,
            sessionId: this.extractSessionId(filePath),
          })
        }
      } catch { continue }
    }

    for (const [cwd, info] of byCwd) {
      results.push({
        cwd,
        sessionId: info.sessionId,
        sessionPath: info.path,
      })
    }

    return results
  }

  async pollAll(since: number): Promise<GlobalAdapterEvent[]> {
    const sessionsDir = this.getSessionsDir()
    if (!sessionsDir) return []

    const events: GlobalAdapterEvent[] = []
    const allFiles = this.walkSessionFiles(sessionsDir)

    for (const filePath of allFiles) {
      try {
        const st = await stat(filePath)
        if (st.mtimeMs < since) continue
      } catch { continue }

      const sessionCwd = this.getSessionCwd(filePath)
      if (!sessionCwd) continue

      const sessionId = this.extractSessionId(filePath)
      const newEvents = await this.readNewLines(filePath, sessionId)
      for (const event of newEvents) {
        events.push({ ...event, projectCwd: sessionCwd })
      }
    }

    return events
  }

  async parseConversation(filePath: string): Promise<AdapterEvent[]> {
    try {
      const content = await readFile(filePath, 'utf-8')
      const sessionId = this.extractSessionId(filePath)
      const events: AdapterEvent[] = []

      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        const parsed = this.parseCodexLine(line, sessionId)
        events.push(...parsed)
      }

      return events
    } catch {
      return []
    }
  }

  private extractSessionId(filePath: string): string {
    // e.g. rollout-1739700000-abc123.jsonl → rollout-1739700000-abc123
    return basename(filePath, '.jsonl')
  }

  private async readNewLines(filePath: string, sessionId: string): Promise<AdapterEvent[]> {
    const lastOffset = this.lastOffsets.get(filePath) ?? 0
    const content = await readFile(filePath, 'utf-8')

    if (content.length <= lastOffset) return []

    const newContent = content.slice(lastOffset)
    this.lastOffsets.set(filePath, content.length)

    const events: AdapterEvent[] = []
    for (const line of newContent.split('\n')) {
      if (!line.trim()) continue
      const parsed = this.parseCodexLine(line, sessionId)
      events.push(...parsed)
    }

    return events
  }

  private parseCodexLine(line: string, sessionId: string): AdapterEvent[] {
    const events: AdapterEvent[] = []

    try {
      const msg = JSON.parse(line)
      const ts = Date.now()

      if (msg.type === 'event_msg' && msg.payload) {
        if (msg.payload.type === 'task_started') {
          events.push({
            type: 'session_start',
            sessionId,
            agent: 'codex',
            timestamp: ts,
            prompt: msg.payload.text || msg.payload.message || undefined,
          })
        } else if (msg.payload.type === 'task_complete') {
          events.push({
            type: 'session_end',
            sessionId,
            timestamp: ts,
          })
        } else if (msg.payload.type === 'user_message') {
          // User messages can serve as session prompts; skip for events
        }
      }

      if (msg.type === 'response_item' && msg.payload) {
        const p = msg.payload

        // exec_command → CommandRunEvent
        if (p.type === 'function_call' && p.name === 'exec_command') {
          let args: { cmd?: string; workdir?: string } = {}
          try {
            args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : (p.arguments || {})
          } catch {
            // ignore
          }
          events.push({
            type: 'command_run',
            sessionId,
            timestamp: ts,
            command: args.cmd || '',
            exitCode: 0, // Updated from output
          } satisfies CommandRunEvent)
        }

        // function_call_output → detect test results
        if (p.type === 'function_call_output') {
          const output = typeof p.output === 'string' ? p.output : ''
          // Detect exit code from output
          const exitMatch = output.match(/exit code (\d+)/)
          const exitCode = exitMatch ? parseInt(exitMatch[1]) : undefined
          if (exitCode !== undefined && exitCode !== 0) {
            // Emit a command run event for the failure
            events.push({
              type: 'command_run',
              sessionId,
              timestamp: ts,
              command: '(codex exec)',
              exitCode,
              stdout: output.slice(0, 500),
            } satisfies CommandRunEvent)
          }

          const testResult = this.detectTestResult(output)
          if (testResult) {
            events.push({
              ...testResult,
              sessionId,
              timestamp: ts,
            })
          }
        }

        // apply_patch → FileEditEvent
        if (p.type === 'custom_tool_call' && p.name === 'apply_patch') {
          const input = typeof p.input === 'string' ? p.input : ''
          const fileMatch = input.match(/\*\*\* Update File:\s*(\S+)/)
            || input.match(/\*\*\* Add File:\s*(\S+)/)
          const filePath = fileMatch ? fileMatch[1] : 'unknown'

          // Count added/removed lines from patch
          const lines = input.split('\n')
          let added = 0
          let removed = 0
          for (const l of lines) {
            if (l.startsWith('+') && !l.startsWith('+++')) added++
            if (l.startsWith('-') && !l.startsWith('---')) removed++
          }

          events.push({
            type: 'file_edit',
            sessionId,
            timestamp: ts,
            path: filePath,
            linesAdded: added,
            linesRemoved: removed,
            tool: 'apply_patch',
          } satisfies FileEditEvent)
        }

        // custom_tool_call_output for apply_patch
        if (p.type === 'custom_tool_call_output') {
          // Parse output for success/failure info
          let outputData: { output?: string; metadata?: { exit_code?: number } } = {}
          try {
            outputData = typeof p.output === 'string' ? JSON.parse(p.output) : (p.output || {})
          } catch {
            // ignore
          }
          // We could track patch failures here if needed
        }
      }
    } catch {
      // Skip malformed lines
    }

    return events
  }

  detectTestResult(stdout: string): Omit<TestResultEvent, 'sessionId' | 'timestamp'> | null {
    // Jest / Vitest
    const jestMatch = stdout.match(/Tests:\s+(\d+)\s+failed.*?(\d+)\s+passed.*?(\d+)\s+total/s)
      || stdout.match(/Tests:\s+(\d+)\s+passed.*?(\d+)\s+total/s)
    if (jestMatch) {
      if (jestMatch.length === 4) {
        return { type: 'test_result', framework: 'jest', failed: parseInt(jestMatch[1]), passed: parseInt(jestMatch[2]), skipped: 0, raw: stdout.slice(0, 500) }
      }
      return { type: 'test_result', framework: 'jest', passed: parseInt(jestMatch[1]), failed: 0, skipped: 0, raw: stdout.slice(0, 500) }
    }

    // Pytest
    const pytestMatch = stdout.match(/(\d+)\s+passed(?:,\s+(\d+)\s+failed)?(?:,\s+(\d+)\s+skipped)?/)
    if (pytestMatch) {
      return { type: 'test_result', framework: 'pytest', passed: parseInt(pytestMatch[1]), failed: parseInt(pytestMatch[2] || '0'), skipped: parseInt(pytestMatch[3] || '0'), raw: stdout.slice(0, 500) }
    }

    // Go test
    const goMatch = stdout.match(/^(ok|FAIL)\s+\S+/m)
    if (goMatch) {
      const passed = goMatch[1] === 'ok' ? 1 : 0
      const failed = goMatch[1] === 'FAIL' ? 1 : 0
      return { type: 'test_result', framework: 'go', passed, failed, skipped: 0, raw: stdout.slice(0, 500) }
    }

    // Cargo test
    const cargoMatch = stdout.match(/test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored/)
    if (cargoMatch) {
      return { type: 'test_result', framework: 'cargo', passed: parseInt(cargoMatch[2]), failed: parseInt(cargoMatch[3]), skipped: parseInt(cargoMatch[4]), raw: stdout.slice(0, 500) }
    }

    return null
  }
}
