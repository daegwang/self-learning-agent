import { readFile, writeFile, readdir, copyFile, unlink, stat } from 'fs/promises'
import { join } from 'path'
import { ensureSlagentDir, slagentRoot } from '../config.js'
import type { AdapterEvent, SessionSummary, Rule } from '../types.js'

export class Store {
  private root: string
  private initialized = false

  constructor() {
    this.root = slagentRoot()
  }

  async init(): Promise<void> {
    if (this.initialized) return
    await ensureSlagentDir()
    this.initialized = true
  }

  // ─── Events (JSONL per session) ───

  async appendEvent(event: AdapterEvent): Promise<void> {
    await this.init()
    const sessionId = event.sessionId
    const filePath = join(this.root, 'events', `${sessionId}.jsonl`)
    const line = JSON.stringify(event) + '\n'
    await writeFile(filePath, line, { flag: 'a' })
  }

  async getSessionEvents(sessionId: string): Promise<AdapterEvent[]> {
    const filePath = join(this.root, 'events', `${sessionId}.jsonl`)
    try {
      const content = await readFile(filePath, 'utf-8')
      return content
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as AdapterEvent)
    } catch {
      return []
    }
  }

  // ─── Session Summaries ───

  async saveSessionSummary(summary: SessionSummary): Promise<void> {
    await this.init()
    const filePath = join(this.root, 'sessions', `${summary.id}.json`)
    await writeFile(filePath, JSON.stringify(summary, null, 2))
  }

  async getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
    const filePath = join(this.root, 'sessions', `${sessionId}.json`)
    try {
      const content = await readFile(filePath, 'utf-8')
      return JSON.parse(content) as SessionSummary
    } catch {
      return null
    }
  }

  async getRecentSessions(limit = 10): Promise<SessionSummary[]> {
    const dir = join(this.root, 'sessions')
    try {
      const files = await readdir(dir)
      const jsonFiles = files.filter(f => f.endsWith('.json')).sort().reverse().slice(0, limit)
      const summaries = await Promise.all(
        jsonFiles.map(async f => {
          const content = await readFile(join(dir, f), 'utf-8')
          return JSON.parse(content) as SessionSummary
        })
      )
      return summaries
    } catch {
      return []
    }
  }

  async getUnanalyzedSessions(): Promise<SessionSummary[]> {
    const all = await this.getRecentSessions(100)
    return all.filter(s => !s.analyzed)
  }

  // ─── Rules ───

  async getRules(): Promise<Rule[]> {
    const filePath = join(this.root, 'rules', 'rules.json')
    try {
      const content = await readFile(filePath, 'utf-8')
      return JSON.parse(content) as Rule[]
    } catch {
      return []
    }
  }

  async saveRule(rule: Rule): Promise<void> {
    await this.init()
    const rules = await this.getRules()
    const idx = rules.findIndex(r => r.id === rule.id)
    if (idx >= 0) {
      rules[idx] = rule
    } else {
      rules.push(rule)
    }
    const filePath = join(this.root, 'rules', 'rules.json')
    await writeFile(filePath, JSON.stringify(rules, null, 2))
  }

  async updateRule(id: string, updates: Partial<Rule>): Promise<Rule | null> {
    const rules = await this.getRules()
    const idx = rules.findIndex(r => r.id === id)
    if (idx < 0) return null

    rules[idx] = { ...rules[idx], ...updates }
    const filePath = join(this.root, 'rules', 'rules.json')
    await writeFile(filePath, JSON.stringify(rules, null, 2))
    return rules[idx]
  }

  // ─── Backups ───

  async createBackup(filePath: string, cwd: string): Promise<string> {
    await this.init()
    const basename = filePath.replace(/[/\\]/g, '_')
    const backupName = `${Date.now()}-${basename}`
    const backupPath = join(this.root, 'backups', backupName)
    const absSource = join(cwd, filePath)
    await copyFile(absSource, backupPath)
    return backupPath
  }

  async restoreBackup(backupPath: string, targetPath: string, cwd: string): Promise<void> {
    const absTarget = join(cwd, targetPath)
    await copyFile(backupPath, absTarget)
  }

  // ─── Retention ───

  async pruneOldData(maxAgeDays: number): Promise<{ eventsDeleted: number; sessionsDeleted: number }> {
    const cutoff = Date.now() - maxAgeDays * 86_400_000
    let eventsDeleted = 0
    let sessionsDeleted = 0

    for (const subdir of ['events', 'sessions']) {
      const dir = join(this.root, subdir)
      try {
        const files = await readdir(dir)
        for (const f of files) {
          const fp = join(dir, f)
          const st = await stat(fp)
          if (st.mtimeMs < cutoff) {
            await unlink(fp)
            if (subdir === 'events') eventsDeleted++
            else sessionsDeleted++
          }
        }
      } catch {
        // Directory may not exist
      }
    }

    return { eventsDeleted, sessionsDeleted }
  }
}
