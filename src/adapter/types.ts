import type { AdapterEvent } from '../types.js'

export interface GlobalSessionInfo {
  cwd: string
  sessionId: string
  sessionPath: string
}

export type GlobalAdapterEvent = AdapterEvent & { projectCwd: string }

export interface Adapter {
  name: string
  detectActivity(cwd: string): Promise<boolean>
  isCliRunning(cwd: string): boolean
  getActiveSessionId(cwd: string): string | null
  getActiveSessionPath(cwd: string): string | null
  poll(cwd: string, since: number): Promise<AdapterEvent[]>
  parseConversation(filePath: string): Promise<AdapterEvent[]>

  // Global (multi-project) methods
  getAllActiveSessions(): Promise<GlobalSessionInfo[]>
  pollAll(since: number): Promise<GlobalAdapterEvent[]>
}
