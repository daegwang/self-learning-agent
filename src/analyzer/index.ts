import { readFile } from 'fs/promises'
import { Store } from '../store/index.js'
import { discoverAgentInstructionFiles } from '../config.js'
import { buildAnalysisContext } from './context-builder.js'
import { buildAnalysisPrompt, callReviewer, parseAnalysisResponse } from './reviewer.js'
import type { SlcConfig, ParsedSuggestion } from '../types.js'

export type ProgressFn = (step: string) => void

export interface AnalysisResult {
  suggestions: ParsedSuggestion[]
  reviewAgent: string
}

export async function analyzeSession(
  sessionId: string,
  store: Store,
  config: SlcConfig,
  onProgress?: ProgressFn,
): Promise<AnalysisResult> {
  const log = onProgress || (() => {})

  const events = await store.getSessionEvents(sessionId)
  const summary = await store.getSessionSummary(sessionId)
  if (!summary) throw new Error(`Session ${sessionId} not found`)

  const projectCwd = summary.projectCwd || process.cwd()
  const agent = summary.agent || 'claude'

  log(`loading ${events.length} events`)

  // Discover instruction files
  const agentFiles = discoverAgentInstructionFiles(agent, projectCwd)
  const instructionContents: Record<string, string> = {}
  for (const [file, absPath] of Object.entries(agentFiles.project)) {
    try {
      instructionContents[`[project] ${file}`] = await readFile(absPath, 'utf-8')
      log(`loaded ${file}`)
    } catch { /* skip */ }
  }
  for (const [file, absPath] of Object.entries(agentFiles.global)) {
    try {
      instructionContents[`[global] ${file}`] = await readFile(absPath, 'utf-8')
      log(`loaded ~/${file}`)
    } catch { /* skip */ }
  }

  const existingRules = await store.getRules()
  log(`${existingRules.length} existing learnings`)

  const context = buildAnalysisContext(
    events,
    summary,
    instructionContents,
    existingRules,
    config.analysis.tokenBudget,
    config.privacy,
  )

  const prompt = buildAnalysisPrompt(context, agent)

  // Resolve which agent CLI to use for review
  // Prefer the session's agent, fall back to config, then auto-detect
  let reviewAgent = config.analysis.agent
  if (reviewAgent === 'auto') {
    // Use the same agent that ran the session if available
    const sessionAgentDef = config.adapters.agents[agent]
    if (sessionAgentDef?.detected) {
      reviewAgent = agent
    } else {
      const detected = Object.keys(config.adapters.agents).find(
        name => config.adapters.agents[name].detected,
      )
      if (!detected) {
        throw new Error('No detected agent available for review. Install claude or codex, or set analysis.agent in config.')
      }
      reviewAgent = detected
    }
  }

  const agentDef = config.adapters.agents[reviewAgent]
  if (!agentDef) {
    throw new Error(`Unknown agent "${reviewAgent}". Available: ${Object.keys(config.adapters.agents).join(', ')}`)
  }
  if (!agentDef.detected) {
    throw new Error(`Agent "${reviewAgent}" is configured for review but not found on this system.`)
  }

  log(`sending to ${reviewAgent} for review...`)
  const raw = await callReviewer(prompt, agentDef, projectCwd, config.analysis.timeoutMs)
  const suggestions = parseAnalysisResponse(raw, agent)

  // Mark session as analyzed with current event count
  await store.saveSessionSummary({ ...summary, analyzed: true, reviewedEventCount: events.length })

  return { suggestions, reviewAgent }
}

export async function analyzeLatestSession(
  store: Store,
  config: SlcConfig,
): Promise<{ sessionId: string; suggestions: ParsedSuggestion[]; reviewAgent: string } | null> {
  const unanalyzed = await store.getUnanalyzedSessions()
  if (unanalyzed.length === 0) return null

  // Pick most recent
  const session = unanalyzed.sort((a, b) => b.endedAt - a.endedAt)[0]
  const { suggestions, reviewAgent } = await analyzeSession(session.id, store, config)

  return { sessionId: session.id, suggestions, reviewAgent }
}
