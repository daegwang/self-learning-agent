import { randomUUID } from 'crypto'
import type { Store } from '../store/index.js'
import { AdapterRegistry } from '../adapter/registry.js'
import { SignalEnricher } from './signals.js'
import type { SlcConfig, WatcherStatus, AgentSession, SessionSummary, AdapterEvent } from '../types.js'

interface TrackedSession {
  agent: string
  sessionId: string
  sessionPath?: string
  eventCount: number
  startTime: number
  prompt: string
  files: string[]
  active: boolean
  cwd: string
}

export type WatcherEventType = 'agent_online' | 'agent_offline' | 'session_start' | 'session_end'
export interface WatcherEvent {
  type: WatcherEventType
  agent: string
  sessionId?: string
  sessionPath?: string
  projectCwd?: string
}
type WatcherListener = (event: WatcherEvent) => void

export class LiveWatcher {
  private running = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastPollTime = 0
  // Keyed by "adapterName:cwd"
  private sessions = new Map<string, TrackedSession>()
  private listeners: WatcherListener[] = []
  private lastActive = new Map<string, boolean>() // "adapter:cwd" → was active
  // Per-project signal enrichers (lazy)
  private enrichers = new Map<string, SignalEnricher>()

  constructor(
    private store: Store,  // "main" store from CLI cwd
    private registry: AdapterRegistry,
    private config: SlcConfig,
    private cwd: string,
  ) {}

  on(listener: WatcherListener): void {
    this.listeners.push(listener)
  }

  private emit(event: WatcherEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* ignore */ }
    }
  }

  private sessionKey(adapterName: string, projectCwd: string): string {
    return `${adapterName}:${projectCwd}`
  }

  private getEnricher(projectCwd: string): SignalEnricher {
    let enricher = this.enrichers.get(projectCwd)
    if (!enricher) {
      enricher = new SignalEnricher(projectCwd)
      this.enrichers.set(projectCwd, enricher)
    }
    return enricher
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.lastPollTime = Date.now() - 30 * 60 * 1000

    // Detect all running agents across all projects
    await this.detectExistingSessions()

    // Count events for detected sessions
    await this.countSessionEvents()

    // Start polling
    this.pollTimer = setInterval(() => {
      this.pollAdapters().catch(() => {})
    }, this.config.adapters.pollIntervalMs)
  }

  stop(): void {
    this.running = false
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  getStatus(): WatcherStatus {
    const sessionList: AgentSession[] = []
    for (const [, s] of this.sessions) {
      sessionList.push({
        agent: s.agent,
        sessionId: s.sessionId,
        eventCount: s.eventCount,
        live: s.active,
        projectCwd: s.cwd,
      })
    }

    let totalEvents = 0
    for (const s of sessionList) totalEvents += s.eventCount

    return {
      running: this.running,
      sessions: sessionList,
      totalEvents,
    }
  }

  private async detectExistingSessions(): Promise<void> {
    for (const adapter of this.registry.getAll()) {
      try {
        const globalSessions = await adapter.getAllActiveSessions()

        for (const gs of globalSessions) {
          const key = this.sessionKey(adapter.name, gs.cwd)
          this.lastActive.set(key, true)

          this.sessions.set(key, {
            agent: adapter.name,
            sessionId: gs.sessionId,
            sessionPath: gs.sessionPath,
            eventCount: 0,
            startTime: Date.now(),
            prompt: '',
            files: [],
            active: true,
            cwd: gs.cwd,
          })
        }
      } catch {
        // ignore
      }
    }
  }

  private async countSessionEvents(): Promise<void> {
    for (const [key, session] of this.sessions) {
      const adapter = this.registry.get(session.agent)
      if (!adapter) continue

      try {
        const events = await adapter.poll(session.cwd, 0)
        const matched = events.filter(e => e.sessionId === session.sessionId)

        for (const event of matched) {
          if (event.type === 'file_edit') {
            session.files.push(event.path)
          }
        }

        session.eventCount = matched.length
      } catch {
        // ignore
      }
    }

    this.lastPollTime = Date.now()
  }

  async sealSession(key: string): Promise<SessionSummary | null> {
    const session = this.sessions.get(key)
    if (!session) return null

    const enricher = this.getEnricher(session.cwd)
    const events = await this.store.getSessionEvents(session.sessionId)

    const gitSignals = await enricher.checkGitSignals(session.sessionId)
    for (const sig of gitSignals) {
      sig.sessionId = session.sessionId
      await this.store.appendEvent(sig)
    }

    const manualEdits = await enricher.detectManualEdits(session.files, Date.now() - 60_000)
    for (const edit of manualEdits) {
      edit.sessionId = session.sessionId
      await this.store.appendEvent(edit)
    }

    const timingSignals = enricher.detectTimingSignals(events)
    for (const sig of timingSignals) {
      await this.store.appendEvent(sig)
    }

    const interventionCount = gitSignals.length + manualEdits.length + timingSignals.length
    const testEvents = events.filter(e => e.type === 'test_result')
    const hasFailures = testEvents.some(e => e.type === 'test_result' && e.failed > 0)
    const hasSuccesses = testEvents.some(e => e.type === 'test_result' && e.passed > 0 && e.failed === 0)

    let outcome: SessionSummary['outcome'] = 'unknown'
    if (hasFailures && hasSuccesses) outcome = 'partial'
    else if (hasFailures) outcome = 'failure'
    else if (hasSuccesses) outcome = 'success'

    const summary: SessionSummary = {
      id: session.sessionId,
      agent: session.agent,
      prompt: session.prompt,
      projectCwd: session.cwd,
      startedAt: session.startTime,
      endedAt: Date.now(),
      outcome,
      filesChanged: [...new Set(session.files)],
      interventions: interventionCount,
      analyzed: false,
    }

    await this.store.saveSessionSummary(summary)
    this.sessions.delete(key)
    return summary
  }

  private async pollAdapters(): Promise<void> {
    const since = this.lastPollTime
    this.lastPollTime = Date.now()

    for (const adapter of this.registry.getAll()) {
      try {
        // Use pollAll to get events from all projects
        const globalEvents = await adapter.pollAll(since)

        // Also check getAllActiveSessions to detect online/offline transitions
        const activeSessions = await adapter.getAllActiveSessions()
        const activeKeys = new Set<string>()

        for (const gs of activeSessions) {
          const key = this.sessionKey(adapter.name, gs.cwd)
          activeKeys.add(key)
          const wasActive = this.lastActive.get(key) ?? false
          const existing = this.sessions.get(key)

          // Agent just became active for this project — start a session
          if (!wasActive) {
            if (existing) await this.sealSession(key)

            this.sessions.set(key, {
              agent: adapter.name,
              sessionId: gs.sessionId,
              sessionPath: gs.sessionPath,
              eventCount: 0,
              startTime: Date.now(),
              prompt: '',
              files: [],
              active: true,
              cwd: gs.cwd,
            })

            await this.store.appendEvent({
              type: 'session_start',
              sessionId: gs.sessionId,
              agent: adapter.name,
              timestamp: Date.now(),
            })

            this.emit({ type: 'agent_online', agent: adapter.name, projectCwd: gs.cwd })
            this.emit({ type: 'session_start', agent: adapter.name, sessionId: gs.sessionId, sessionPath: gs.sessionPath, projectCwd: gs.cwd })
          }

          // Check if session ID changed (new session while still active)
          if (wasActive && existing && gs.sessionId !== existing.sessionId) {
            // Seal old, start new
            await this.store.appendEvent({
              type: 'session_end',
              sessionId: existing.sessionId,
              timestamp: Date.now(),
            })
            this.emit({ type: 'session_end', agent: adapter.name, sessionId: existing.sessionId, projectCwd: gs.cwd })
            await this.sealSession(key)

            this.sessions.set(key, {
              agent: adapter.name,
              sessionId: gs.sessionId,
              sessionPath: gs.sessionPath,
              eventCount: 0,
              startTime: Date.now(),
              prompt: '',
              files: [],
              active: true,
              cwd: gs.cwd,
            })

            await this.store.appendEvent({
              type: 'session_start',
              sessionId: gs.sessionId,
              agent: adapter.name,
              timestamp: Date.now(),
            })
            this.emit({ type: 'session_start', agent: adapter.name, sessionId: gs.sessionId, sessionPath: gs.sessionPath, projectCwd: gs.cwd })
          }

          this.lastActive.set(key, true)
        }

        // Detect sessions that went offline
        for (const [key, session] of this.sessions) {
          if (session.agent !== adapter.name) continue
          if (activeKeys.has(key)) continue

          const wasActive = this.lastActive.get(key) ?? false
          if (!wasActive) continue

          await this.store.appendEvent({
            type: 'session_end',
            sessionId: session.sessionId,
            timestamp: Date.now(),
          })

          this.emit({ type: 'session_end', agent: adapter.name, sessionId: session.sessionId, sessionPath: session.sessionPath, projectCwd: session.cwd })
          this.emit({ type: 'agent_offline', agent: adapter.name, projectCwd: session.cwd })
          await this.sealSession(key)
          this.lastActive.set(key, false)
        }

        // Process polled events grouped by project cwd
        for (const event of globalEvents) {
          const { projectCwd, ...baseEvent } = event
          const key = this.sessionKey(adapter.name, projectCwd)

          // Auto-create session from events if none exists
          let session = this.sessions.get(key)
          if (!session) {
            const sid = baseEvent.sessionId || randomUUID()
            session = {
              agent: adapter.name,
              sessionId: sid,
              eventCount: 0,
              startTime: baseEvent.timestamp,
              prompt: '',
              files: [],
              active: true,
              cwd: projectCwd,
            }
            this.sessions.set(key, session)
            this.lastActive.set(key, true)
            this.emit({ type: 'session_start', agent: adapter.name, sessionId: sid, projectCwd })
          }

          if (baseEvent.type === 'file_edit') {
            session.files.push(baseEvent.path)
          }

          const stored: AdapterEvent = { ...baseEvent, sessionId: session.sessionId }
          await this.store.appendEvent(stored)
          session.eventCount++
        }
      } catch {
        // Adapter error — skip this cycle
      }
    }
  }
}
