import type { AdapterEvent, Rule, SessionSummary, AnalysisContext, PrivacyConfig } from '../types.js'

export function buildAnalysisContext(
  events: AdapterEvent[],
  summary: SessionSummary,
  instructionContents: Record<string, string>,
  existingRules: Rule[],
  tokenBudget: number,
  privacyConfig?: PrivacyConfig,
): AnalysisContext {
  // Budget allocation: 40% events, 30% instructions, 20% system prompt, 10% existing rules
  const eventBudget = Math.floor(tokenBudget * 0.4)
  const instructionBudget = Math.floor(tokenBudget * 0.3)
  const ruleBudget = Math.floor(tokenBudget * 0.1)

  // Compress events — prioritize failures
  let compressedEvents = compressEvents(events, eventBudget)

  // Apply privacy redaction if enabled
  if (privacyConfig?.redactSecrets) {
    compressedEvents = redactSecrets(compressedEvents)
  }

  // Truncate instruction file contents to budget
  const truncatedInstructions: Record<string, string> = {}
  let instrChars = 0
  const instrCharBudget = instructionBudget * 4 // rough chars-per-token
  for (const [file, content] of Object.entries(instructionContents)) {
    // Skip files matching excludePaths
    if (privacyConfig?.excludePaths?.some(p => file.includes(p))) continue

    const remaining = instrCharBudget - instrChars
    if (remaining <= 0) break
    let text = content.slice(0, remaining)
    if (privacyConfig?.redactSecrets) {
      text = redactSecrets(text)
    }
    truncatedInstructions[file] = text
    instrChars += truncatedInstructions[file].length
  }

  // Existing rules summary
  const rulesText = existingRules.length > 0
    ? existingRules
        .map(r => `[${r.status}] ${r.targetFile}: ${r.action} — ${r.rationale.slice(0, 80)}`)
        .join('\n')
        .slice(0, ruleBudget * 4)
    : '(none)'

  const systemPrompt = [
    `Session: ${summary.id}`,
    `Agent: ${summary.agent}`,
    `Prompt: ${summary.prompt}`,
    `Outcome: ${summary.outcome}`,
    `Files changed: ${summary.filesChanged.join(', ')}`,
    `Interventions: ${summary.interventions}`,
  ].join('\n')

  return {
    systemPrompt,
    events: compressedEvents,
    instructionContents: truncatedInstructions,
    existingRules: rulesText,
  }
}

// ─── Privacy Redaction ───

const SECRET_PATTERNS = [
  // API keys and tokens
  /(?:API_KEY|APIKEY|API_SECRET|ACCESS_KEY|SECRET_KEY|AUTH_TOKEN|BEARER_TOKEN)\s*[=:]\s*['"]?[A-Za-z0-9_\-./+]{8,}['"]?/gi,
  // Generic SECRET= or TOKEN= assignments
  /(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD)\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9_\-./+]{20,}/g,
  // AWS access keys
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
  // AWS secret keys (40 chars base64)
  /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi,
  // Private key blocks
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
  // GitHub tokens
  /gh[ps]_[A-Za-z0-9_]{36,}/g,
  // Slack tokens
  /xox[bpras]-[A-Za-z0-9\-]{10,}/g,
  // Generic hex secrets (32+ chars)
  /(?:secret|token|key|password|credential)['"]?\s*[=:]\s*['"]?[0-9a-f]{32,}['"]?/gi,
]

export function redactSecrets(text: string): string {
  let result = text
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regexps
    pattern.lastIndex = 0
    result = result.replace(pattern, (match) => {
      // Find the = or : separator to preserve the key name
      const sepIdx = match.search(/[=:]/)
      if (sepIdx >= 0) {
        return match.slice(0, sepIdx + 1) + ' [REDACTED]'
      }
      return '[REDACTED]'
    })
  }
  return result
}

// ─── Event Compression ───

function compressEvents(events: AdapterEvent[], budgetTokens: number): string {
  const lines: string[] = []

  // Sort: test failures first, then errors, then rest
  const sorted = [...events].sort((a, b) => {
    const priority = (e: AdapterEvent): number => {
      if (e.type === 'test_result' && e.failed > 0) return 0
      if (e.type === 'command_run' && e.exitCode !== 0) return 1
      if (e.type === 'user_intervention') return 2
      return 3
    }
    return priority(a) - priority(b)
  })

  const charBudget = budgetTokens * 4

  for (const event of sorted) {
    const line = compressEvent(event)
    if (lines.join('\n').length + line.length > charBudget) break
    lines.push(line)
  }

  return lines.join('\n')
}

function compressEvent(event: AdapterEvent): string {
  switch (event.type) {
    case 'file_edit':
      return `edit ${event.path} (+${event.linesAdded}/-${event.linesRemoved})`
    case 'command_run':
      return `$ ${event.command.slice(0, 100)} → exit ${event.exitCode}`
    case 'test_result':
      return `test(${event.framework}): ${event.passed} passed, ${event.failed} failed`
    case 'user_intervention':
      return `intervention: ${event.signal}${event.detail ? ' — ' + event.detail : ''}`
    case 'session_start':
      return `session_start: ${event.agent}${event.prompt ? ' "' + event.prompt.slice(0, 60) + '"' : ''}`
    case 'session_end':
      return `session_end: exit ${event.exitCode ?? '?'}`
    default:
      return JSON.stringify(event).slice(0, 100)
  }
}
