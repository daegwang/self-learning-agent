// ─── Adapter Events ───

export interface SessionStartEvent {
  type: 'session_start'
  sessionId: string
  agent: string
  timestamp: number
  prompt?: string
}

export interface SessionEndEvent {
  type: 'session_end'
  sessionId: string
  timestamp: number
  exitCode?: number
}

export interface FileEditEvent {
  type: 'file_edit'
  sessionId: string
  timestamp: number
  path: string
  linesAdded: number
  linesRemoved: number
  tool?: string
}

export interface CommandRunEvent {
  type: 'command_run'
  sessionId: string
  timestamp: number
  command: string
  exitCode: number
  stdout?: string
  stderr?: string
}

export interface TestResultEvent {
  type: 'test_result'
  sessionId: string
  timestamp: number
  framework: string
  passed: number
  failed: number
  skipped: number
  raw?: string
}

export interface UserInterventionEvent {
  type: 'user_intervention'
  sessionId: string
  timestamp: number
  signal: 'manual_edit' | 'revert' | 'fixup' | 'long_pause' | 'abort'
  detail?: string
}

export type AdapterEvent =
  | SessionStartEvent
  | SessionEndEvent
  | FileEditEvent
  | CommandRunEvent
  | TestResultEvent
  | UserInterventionEvent

// ─── Session ───

export type SessionOutcome = 'success' | 'failure' | 'partial' | 'unknown'

export interface SessionSummary {
  id: string
  agent: string
  prompt: string
  projectCwd?: string
  startedAt: number
  endedAt: number
  outcome: SessionOutcome
  filesChanged: string[]
  interventions: number
  analyzed: boolean
  reviewedEventCount?: number
}

// ─── Rules ───

export type RuleAction = 'add' | 'modify' | 'remove'
export type RuleScope = 'global' | 'project'
export type RuleStatus = 'proposed' | 'approved' | 'applied' | 'rejected' | 'reverted'

export interface RuleMetrics {
  proposedAt: number
  appliedAt?: number
  sessionsObserved: number
}

export interface Rule {
  id: string
  targetFile: string
  projectCwd?: string
  scope: RuleScope
  action: RuleAction
  content: string
  diff?: string
  rationale: string
  sourceSessionIds: string[]
  status: RuleStatus
  metrics: RuleMetrics
}

// ─── Config ───

export interface AgentDef {
  command: string
  analyzeArgs: string[]
  detected: boolean
  historyDir?: string
}

export interface AdapterConfig {
  pollIntervalMs: number
  agents: Record<string, AgentDef>
}

export interface PrivacyConfig {
  redactSecrets: boolean
  excludePaths: string[]
}

export interface AnalysisConfig {
  agent: string  // 'auto' | 'claude' | 'codex' — which agent CLI to use for review
  tokenBudget: number
  timeoutMs: number
  minConfidence: number
}

export interface RetentionConfig {
  maxAgeDays: number
}

export interface SlcConfig {
  version: number
  adapters: AdapterConfig
  instructionFiles: string[]
  privacy: PrivacyConfig
  analysis: AnalysisConfig
  retention: RetentionConfig
}

// ─── Analysis ───

export interface AnalysisContext {
  systemPrompt: string
  events: string
  instructionContents: Record<string, string>
  existingRules: string
}

export interface ParsedSuggestion {
  target: string
  action: RuleAction
  scope: RuleScope
  confidence: number
  rationale: string
  content: string
}

// ─── Watcher ───

export interface AgentSession {
  agent: string
  sessionId: string
  eventCount: number
  live: boolean
  projectCwd?: string
}

export interface WatcherStatus {
  running: boolean
  sessions: AgentSession[]
  totalEvents: number
}

// ─── Daemon Socket Messages ───

export interface ShellHookMessage {
  type: 'command'
  command: string
  timestamp: number
  pid: number
}
