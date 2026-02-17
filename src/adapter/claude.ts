import { readdir, stat, readFile } from 'fs/promises'
import { join, basename } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import { execSync } from 'child_process'
import type { Adapter, GlobalSessionInfo, GlobalAdapterEvent } from './types.js'
import type { AdapterEvent, FileEditEvent, CommandRunEvent, TestResultEvent } from '../types.js'

export class ClaudeAdapter implements Adapter {
  name = 'claude'
  private lastOffsets = new Map<string, number>()

  findProjectDir(cwd: string): string | null {
    const home = process.env.HOME || process.env.USERPROFILE || '~'
    const projectsDir = join(home, '.claude', 'projects')

    if (!existsSync(projectsDir)) return null

    // Claude encodes the project path by replacing all / with -
    // e.g. /Users/foo/bar → -Users-foo-bar
    const encoded = cwd.replace(/\//g, '-')
    const candidate = join(projectsDir, encoded)

    if (existsSync(candidate)) return candidate

    return null
  }

  async detectActivity(cwd: string): Promise<boolean> {
    // First check: is a claude process running in this directory?
    if (this.isCliRunning(cwd)) return true

    // Fallback: check for recently modified JSONL files (last 5 min)
    const dir = this.findProjectDir(cwd)
    if (!dir) return false

    try {
      const files = await readdir(dir)
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))
      const cutoff = Date.now() - 5 * 60 * 1000
      for (const f of jsonlFiles) {
        const st = await stat(join(dir, f))
        if (st.mtimeMs > cutoff) return true
      }
    } catch {
      // ignore
    }

    return false
  }

  isCliRunning(cwd: string): boolean {
    try {
      // Get PIDs of all 'claude' processes
      const pids = execSync('pgrep -x claude 2>/dev/null', { encoding: 'utf-8', timeout: 3000 })
        .trim()
        .split('\n')
        .filter(Boolean)

      for (const pid of pids) {
        try {
          // Check if this claude process's cwd matches our project
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
    const dir = this.findProjectDir(cwd)
    if (!dir) return null

    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      if (files.length === 0) return null

      // Find the most recently modified JSONL
      let newest = files[0]
      let newestMtime = 0
      for (const f of files) {
        const st = statSync(join(dir, f))
        if (st.mtimeMs > newestMtime) {
          newestMtime = st.mtimeMs
          newest = f
        }
      }

      return basename(newest, '.jsonl')
    } catch {
      return null
    }
  }

  getActiveSessionPath(cwd: string): string | null {
    const dir = this.findProjectDir(cwd)
    if (!dir) return null

    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      if (files.length === 0) return null

      let newest = files[0]
      let newestMtime = 0
      for (const f of files) {
        const st = statSync(join(dir, f))
        if (st.mtimeMs > newestMtime) {
          newestMtime = st.mtimeMs
          newest = f
        }
      }

      return join(dir, newest)
    } catch {
      return null
    }
  }

  async poll(cwd: string, since: number): Promise<AdapterEvent[]> {
    const dir = this.findProjectDir(cwd)
    if (!dir) return []

    const events: AdapterEvent[] = []

    try {
      const files = await readdir(dir)
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))

      for (const file of jsonlFiles) {
        const filePath = join(dir, file)
        const st = await stat(filePath)
        if (st.mtimeMs < since) continue

        const newEvents = await this.readNewLines(filePath, file)
        events.push(...newEvents)
      }
    } catch {
      // Directory may not exist yet
    }

    return events
  }

  private getProjectsDir(): string | null {
    const home = process.env.HOME || process.env.USERPROFILE || '~'
    const projectsDir = join(home, '.claude', 'projects')
    return existsSync(projectsDir) ? projectsDir : null
  }

  private decodeDirName(encoded: string): string {
    // Claude encodes /Users/foo/bar as -Users-foo-bar
    // This is lossy: hyphens in dir names (e.g. baby-tracker) become indistinguishable.
    // Strategy: walk segments, trying to reconstruct the real path by checking the filesystem.
    if (!encoded.startsWith('-')) return encoded.replace(/-/g, '/')

    const parts = encoded.slice(1).split('-') // e.g. ['Users','daegwang','workspace','baby','tracker']
    let path = ''

    let i = 0
    while (i < parts.length) {
      // Try progressively longer hyphenated segments to find one that exists on disk
      let found = false
      for (let j = parts.length; j > i; j--) {
        const candidate = path + '/' + parts.slice(i, j).join('-')
        try {
          statSync(candidate)
          path = candidate
          i = j
          found = true
          break
        } catch {
          // doesn't exist, try shorter
        }
      }
      if (!found) {
        // Fallback: just use the single segment
        path += '/' + parts[i]
        i++
      }
    }

    return path
  }

  async getAllActiveSessions(): Promise<GlobalSessionInfo[]> {
    const projectsDir = this.getProjectsDir()
    if (!projectsDir) return []

    const results: GlobalSessionInfo[] = []
    const cutoff = Date.now() - 5 * 60 * 1000

    try {
      const projectDirs = readdirSync(projectsDir)

      for (const dirName of projectDirs) {
        const dirPath = join(projectsDir, dirName)
        try {
          if (!statSync(dirPath).isDirectory()) continue
        } catch { continue }

        const cwd = this.decodeDirName(dirName)

        try {
          const files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))
          if (files.length === 0) continue

          // Find newest JSONL
          let newest = files[0]
          let newestMtime = 0
          for (const f of files) {
            try {
              const st = statSync(join(dirPath, f))
              if (st.mtimeMs > newestMtime) {
                newestMtime = st.mtimeMs
                newest = f
              }
            } catch { continue }
          }

          // Include if recently active OR if the CLI process is running
          if (newestMtime < cutoff && !this.isCliRunning(cwd)) continue

          results.push({
            cwd,
            sessionId: basename(newest, '.jsonl'),
            sessionPath: join(dirPath, newest),
          })
        } catch { continue }
      }
    } catch {
      // ignore
    }

    return results
  }

  async pollAll(since: number): Promise<GlobalAdapterEvent[]> {
    const projectsDir = this.getProjectsDir()
    if (!projectsDir) return []

    const events: GlobalAdapterEvent[] = []

    try {
      const projectDirs = readdirSync(projectsDir)

      for (const dirName of projectDirs) {
        const dirPath = join(projectsDir, dirName)
        try {
          if (!statSync(dirPath).isDirectory()) continue
        } catch { continue }

        const cwd = this.decodeDirName(dirName)

        try {
          const files = await readdir(dirPath)
          const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))

          for (const file of jsonlFiles) {
            const filePath = join(dirPath, file)
            const st = await stat(filePath)
            if (st.mtimeMs < since) continue

            const newEvents = await this.readNewLines(filePath, file)
            for (const event of newEvents) {
              events.push({ ...event, projectCwd: cwd })
            }
          }
        } catch { continue }
      }
    } catch {
      // ignore
    }

    return events
  }

  async parseConversation(filePath: string): Promise<AdapterEvent[]> {
    try {
      const content = await readFile(filePath, 'utf-8')
      const sessionId = basename(filePath, '.jsonl')
      const events: AdapterEvent[] = []

      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        const parsed = this.parseClaudeLine(line, sessionId)
        events.push(...parsed)
      }

      return events
    } catch {
      return []
    }
  }

  private async readNewLines(filePath: string, filename: string): Promise<AdapterEvent[]> {
    const lastOffset = this.lastOffsets.get(filePath) ?? 0
    const content = await readFile(filePath, 'utf-8')

    if (content.length <= lastOffset) return []

    const newContent = content.slice(lastOffset)
    this.lastOffsets.set(filePath, content.length)

    const sessionId = basename(filename, '.jsonl')
    const events: AdapterEvent[] = []

    for (const line of newContent.split('\n')) {
      if (!line.trim()) continue
      const parsed = this.parseClaudeLine(line, sessionId)
      events.push(...parsed)
    }

    return events
  }

  private parseClaudeLine(line: string, sessionId: string): AdapterEvent[] {
    const events: AdapterEvent[] = []

    try {
      const msg = JSON.parse(line)

      // Handle assistant messages with tool use
      if (msg.type === 'assistant' && msg.message?.content) {
        const content = Array.isArray(msg.message.content) ? msg.message.content : [msg.message.content]

        for (const block of content) {
          if (block.type !== 'tool_use') continue

          const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now()

          if (block.name === 'write_to_file' || block.name === 'Write') {
            const input = block.input || {}
            events.push({
              type: 'file_edit',
              sessionId,
              timestamp: ts,
              path: input.file_path || input.path || 'unknown',
              linesAdded: (input.content || '').split('\n').length,
              linesRemoved: 0,
              tool: block.name,
            } satisfies FileEditEvent)
          } else if (block.name === 'edit_file' || block.name === 'Edit') {
            const input = block.input || {}
            events.push({
              type: 'file_edit',
              sessionId,
              timestamp: ts,
              path: input.file_path || input.path || 'unknown',
              linesAdded: (input.new_string || input.new_str || '').split('\n').length,
              linesRemoved: (input.old_string || input.old_str || '').split('\n').length,
              tool: block.name,
            } satisfies FileEditEvent)
          } else if (block.name === 'execute_command' || block.name === 'Bash') {
            const input = block.input || {}
            events.push({
              type: 'command_run',
              sessionId,
              timestamp: ts,
              command: input.command || '',
              exitCode: 0, // Will be updated from tool result
            } satisfies CommandRunEvent)
          }
        }
      }

      // Handle tool results to capture exit codes and test output
      if (msg.type === 'tool_result' || (msg.type === 'human' && msg.message?.content)) {
        const content = msg.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result' && block.content) {
              const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
              const testResult = this.detectTestResult(text)
              if (testResult) {
                events.push({
                  ...testResult,
                  sessionId,
                  timestamp: Date.now(),
                })
              }
            }
          }
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
