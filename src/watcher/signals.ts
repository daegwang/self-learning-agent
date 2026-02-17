import { execSync } from 'child_process'
import { stat } from 'fs/promises'
import { join } from 'path'
import type { AdapterEvent, UserInterventionEvent, TestResultEvent } from '../types.js'

export class SignalEnricher {
  constructor(private cwd: string) {}

  async checkGitSignals(sessionId: string): Promise<UserInterventionEvent[]> {
    const events: UserInterventionEvent[] = []
    const ts = Date.now()

    try {
      const log = execSync('git log --oneline -20 --format="%s"', {
        cwd: this.cwd,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      for (const line of log.split('\n')) {
        const lower = line.toLowerCase()
        if (lower.includes('revert') || lower.startsWith('revert ')) {
          events.push({
            type: 'user_intervention',
            sessionId,
            timestamp: ts,
            signal: 'revert',
            detail: line.trim(),
          })
        }
        if (lower.includes('fixup') || lower.startsWith('fixup!')) {
          events.push({
            type: 'user_intervention',
            sessionId,
            timestamp: ts,
            signal: 'fixup',
            detail: line.trim(),
          })
        }
      }
    } catch {
      // Not a git repo or git not available
    }

    return events
  }

  async detectManualEdits(agentFiles: string[], afterTimestamp: number): Promise<UserInterventionEvent[]> {
    const events: UserInterventionEvent[] = []

    for (const file of agentFiles) {
      try {
        const absPath = join(this.cwd, file)
        const st = await stat(absPath)
        if (st.mtimeMs > afterTimestamp) {
          events.push({
            type: 'user_intervention',
            sessionId: '',
            timestamp: st.mtimeMs,
            signal: 'manual_edit',
            detail: file,
          })
        }
      } catch {
        // File may have been deleted
      }
    }

    return events
  }

  parseTestOutput(output: string): Omit<TestResultEvent, 'sessionId' | 'timestamp'> | null {
    // Jest / Vitest
    const jestFail = output.match(/Tests:\s+(\d+)\s+failed.*?(\d+)\s+passed.*?(\d+)\s+total/s)
    if (jestFail) {
      return { type: 'test_result', framework: 'jest', failed: parseInt(jestFail[1]), passed: parseInt(jestFail[2]), skipped: 0, raw: output.slice(0, 500) }
    }
    const jestPass = output.match(/Tests:\s+(\d+)\s+passed.*?(\d+)\s+total/s)
    if (jestPass) {
      return { type: 'test_result', framework: 'jest', passed: parseInt(jestPass[1]), failed: 0, skipped: 0, raw: output.slice(0, 500) }
    }

    // Pytest
    const pytest = output.match(/(\d+)\s+passed(?:,\s+(\d+)\s+failed)?(?:,\s+(\d+)\s+skipped)?/)
    if (pytest) {
      return { type: 'test_result', framework: 'pytest', passed: parseInt(pytest[1]), failed: parseInt(pytest[2] || '0'), skipped: parseInt(pytest[3] || '0'), raw: output.slice(0, 500) }
    }

    return null
  }

  detectTimingSignals(events: AdapterEvent[]): UserInterventionEvent[] {
    const results: UserInterventionEvent[] = []
    const GAP_MS = 5 * 60 * 1000 // 5 minutes

    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1]
      const curr = events[i]
      if (curr.timestamp - prev.timestamp > GAP_MS) {
        results.push({
          type: 'user_intervention',
          sessionId: curr.sessionId,
          timestamp: curr.timestamp,
          signal: 'long_pause',
          detail: `${Math.round((curr.timestamp - prev.timestamp) / 60000)}min gap`,
        })
      }
    }

    return results
  }
}
