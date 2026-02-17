import { spawn } from 'child_process'
import { resolveTargetFile } from '../rules/patcher.js'
import type { AnalysisContext, ParsedSuggestion, AgentDef, RuleAction, RuleScope } from '../types.js'

export function buildAnalysisPrompt(context: AnalysisContext, agent: string): string {
  const parts: string[] = []

  const targetFiles: Record<string, { project: string; global: string }> = {
    claude: { project: 'CLAUDE.md', global: '~/.claude/CLAUDE.md' },
    codex: { project: 'AGENTS.md', global: '~/.codex/instructions.md' },
  }
  const targets = targetFiles[agent] || targetFiles.claude

  parts.push(`You are an AI coding assistant reviewer. Analyze this agent session and suggest improvements to instruction files.

The session agent is "${agent}". Suggestions will be applied to:
- Project-scoped rules → ${targets.project}
- Global-scoped rules → ${targets.global}
Reference the correct file name in your rationale.

SESSION METADATA:
${context.systemPrompt}

SESSION EVENTS:
${context.events}
`)

  if (Object.keys(context.instructionContents).length > 0) {
    parts.push('CURRENT INSTRUCTION FILES:')
    for (const [file, content] of Object.entries(context.instructionContents)) {
      parts.push(`--- ${file} ---\n${content}\n`)
    }
  }

  if (context.existingRules !== '(none)') {
    parts.push(`EXISTING RULES:\n${context.existingRules}\n`)
  }

  parts.push(`Based on the session events, identify patterns where the agent could have performed better. For each suggestion, output in EXACTLY this format:

SUGGESTION 1:
ACTION: <add|modify|remove>
SCOPE: <global|project> (global = best practice across all projects, project = specific to this project)
CONFIDENCE: <0.0 to 1.0>
RATIONALE: <why this change would help>
CONTENT: <the exact text to add/modify in the instruction file>
END_SUGGESTION

Only suggest changes if you have high confidence they would prevent the observed issues. Do not suggest trivial or cosmetic changes.
If there are no useful suggestions, output: NO_SUGGESTIONS`)

  return parts.join('\n')
}

export async function callReviewer(
  prompt: string,
  agentDef: AgentDef,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use stdin to pass the prompt — avoids OS arg length limits
    const args = [...agentDef.analyzeArgs, '-']
    const env = { ...process.env }
    delete env.CLAUDECODE
    const child = spawn(agentDef.command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn ${agentDef.command}: ${err.message}`))
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(`${agentDef.command} exited with code ${code}: ${stderr.slice(0, 500)}`))
      }
    })

    // Write prompt to stdin
    child.stdin.write(prompt)
    child.stdin.end()

    // Hard timeout
    setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Review timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
}

export function parseAnalysisResponse(raw: string, agent: string): ParsedSuggestion[] {
  if (raw.includes('NO_SUGGESTIONS')) return []

  // Strip markdown fences and bold markers that AI responses often include
  let cleaned = raw
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```\w*\n?/g, '').replace(/```/g, ''))
    .replace(/\*\*/g, '')

  const suggestions: ParsedSuggestion[] = []
  const blocks = cleaned.split(/SUGGESTION\s+\d+\s*:/i)

  for (const block of blocks) {
    if (!block.trim()) continue

    const action = extractField(block, 'ACTION')
    const scope = extractField(block, 'SCOPE')
    const confidence = extractField(block, 'CONFIDENCE')
    const rationale = extractField(block, 'RATIONALE')
    const content = extractContent(block)

    if (!action || !content) continue

    const parsedAction = (['add', 'modify', 'remove'].includes(action.toLowerCase())
      ? action.toLowerCase()
      : 'add') as RuleAction

    const parsedScope: RuleScope = scope?.toLowerCase() === 'global' ? 'global' : 'project'
    const target = resolveTargetFile(agent, parsedScope)

    suggestions.push({
      target,
      action: parsedAction,
      scope: parsedScope,
      confidence: parseFloat(confidence || '0.5') || 0.5,
      rationale: rationale || '',
      content,
    })
  }

  // Debug: show raw response when parsing yields nothing
  if (suggestions.length === 0 && raw.trim().length > 0) {
    console.log('  [debug] AI response (first 500 chars):')
    console.log('  ' + raw.slice(0, 500).replace(/\n/g, '\n  '))
  }

  return suggestions
}

function extractField(block: string, field: string): string | null {
  const regex = new RegExp(`${field}\\s*:\\s*(.+?)(?:\\n|$)`, 'i')
  const match = block.match(regex)
  return match ? match[1].trim() : null
}

function extractContent(block: string): string | null {
  const contentMatch = block.match(/CONTENT\s*:\s*([\s\S]*?)(?:END_SUGGESTION|SUGGESTION\s+\d+\s*:|$)/i)
  if (!contentMatch) return null
  return contentMatch[1].trim() || null
}
