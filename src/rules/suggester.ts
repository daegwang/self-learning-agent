import { randomUUID } from 'crypto'
import { bold, dim, cyan, green, yellow, red } from '../colors.js'
import { resolveTargetFile } from './patcher.js'
import type { ParsedSuggestion, Rule } from '../types.js'

export function formatSuggestion(suggestion: ParsedSuggestion, index: number): string {
  const lines: string[] = []
  const scopeLabel = suggestion.scope === 'global'
    ? yellow('global')
    : yellow('project')
  lines.push('')
  lines.push(bold(`  Suggestion ${index + 1}:`))
  lines.push(`  ${dim('Target:')}     ${cyan(suggestion.target)} ${dim('(')}${scopeLabel}${dim(')')}`)
  lines.push(`  ${dim('Action:')}     ${suggestion.action}`)
  lines.push(`  ${dim('Confidence:')} ${formatConfidence(suggestion.confidence)}`)
  lines.push(`  ${dim('Rationale:')} ${suggestion.rationale}`)
  lines.push(`  ${dim('Content:')}`)
  for (const line of suggestion.content.split('\n')) {
    lines.push(`    ${green(line)}`)
  }
  lines.push('')
  return lines.join('\n')
}

function formatConfidence(conf: number): string {
  if (conf >= 0.8) return green(`${(conf * 100).toFixed(0)}%`)
  if (conf >= 0.6) return yellow(`${(conf * 100).toFixed(0)}%`)
  return red(`${(conf * 100).toFixed(0)}%`)
}

export async function presentSuggestions(
  suggestions: ParsedSuggestion[],
  nextLine: () => Promise<string | null>,
  agent: string,
): Promise<Rule[]> {
  const approved: Rule[] = []

  if (suggestions.length === 0) {
    console.log(dim('  No suggestions from review.'))
    return approved
  }

  console.log(bold(`\n  ${suggestions.length} suggestion(s) from review:\n`))

  for (let i = 0; i < suggestions.length; i++) {
    const suggestion = suggestions[i]
    console.log(formatSuggestion(suggestion, i))

    process.stdout.write(`  ${dim('[a]pprove [r]eject [s]kip [t]oggle scope(global/project):')} `)
    const answer = await nextLine()
    if (answer === null) {
      console.log(dim('  Cancelled.'))
      break
    }
    const choice = answer.trim().toLowerCase()

    if (choice === 't' || choice === 'toggle') {
      suggestion.scope = suggestion.scope === 'global' ? 'project' : 'global'
      suggestion.target = resolveTargetFile(agent, suggestion.scope)
      i-- // re-show with updated scope
      continue
    } else if (choice === 'a' || choice === 'approve') {
      const rule = suggestionToRule(suggestion)
      rule.status = 'approved'
      approved.push(rule)
      console.log(`  ${green('✓')} ${bold('Approved')}`)
    } else if (choice === 'r' || choice === 'reject') {
      const rule = suggestionToRule(suggestion)
      rule.status = 'rejected'
      approved.push(rule) // Still save as rejected for tracking
      console.log(red('  Rejected.'))
    } else {
      console.log(dim('  Skipped.'))
    }
  }

  return approved
}

function suggestionToRule(suggestion: ParsedSuggestion): Rule {
  return {
    id: randomUUID(),
    targetFile: suggestion.target,
    scope: suggestion.scope,
    action: suggestion.action,
    content: suggestion.content,
    rationale: suggestion.rationale,
    sourceSessionIds: [],
    status: 'proposed',
    metrics: {
      proposedAt: Date.now(),
      sessionsObserved: 1,
    },
  }
}
