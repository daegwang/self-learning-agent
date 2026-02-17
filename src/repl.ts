import * as readline from 'readline'
import { Store } from './store/index.js'
import { loadConfig, saveConfig } from './config.js'
import { LiveWatcher } from './watcher/index.js'
import { analyzeSession } from './analyzer/index.js'
import { presentSuggestions } from './rules/suggester.js'
import { applyRule } from './rules/patcher.js'
import { bold, dim, green, red, yellow, cyan, gray, salmon, seafoam, steelblue, teal } from './colors.js'
import type { SlcConfig, SessionSummary } from './types.js'

interface ReplState {
  cwd: string
  config: SlcConfig
  store: Store
  watcher: LiveWatcher
  rl?: readline.Interface
  /** Temporarily take over stdin for raw arrow-key selection. Returns selected index or null on cancel. */
  rawSelect?: (count: number, initial: number, render: (cursor: number) => void, menuLines: number) => Promise<number | null>
}

export async function startRepl(cwd: string, watcher: LiveWatcher): Promise<void> {
  const config = await loadConfig(cwd)
  const store = new Store()
  await store.init()

  const state: ReplState = { cwd, config, store, watcher }

  const rules = await store.getRules()

  const box = (s: string) => cyan(s)
  console.log('')
  console.log(`  ${box('╭─────────────────────────────────╮')}`)
  console.log(`  ${box('│')}  ${bold('self-learning-agent')} ${dim('(slagent)')}  ${box('│')}`)
  console.log(`  ${box('│')}  ${dim('v0.1.0')}                         ${box('│')}`)
  console.log(`  ${box('╰─────────────────────────────────╯')}`)
  console.log('')

  await printOverview(state)

  // Commands
  printHelp()

  function promptHr(): string {
    const cols = process.stdout.columns || 80
    return dim('─'.repeat(cols))
  }

  function drawPrompt(): void {
    console.log(promptHr())
    console.log(bold('> '))
    console.log(promptHr())
    // Move cursor back up to the prompt line, after "> "
    process.stdout.write('\x1b[2A\x1b[2C')
  }

  // Enable keypress events before creating readline interface
  readline.emitKeypressEvents(process.stdin)

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  state.rl = rl

  // Queue-based approach: buffer lines as they arrive, process sequentially
  const lineQueue: string[] = []
  let lineResolve: ((line: string | null) => void) | null = null

  // Listen for Esc keypress to cancel prompts
  process.stdin.on('keypress', (_ch: string, key: readline.Key) => {
    if (key && key.name === 'escape' && lineResolve) {
      const resolve = lineResolve
      lineResolve = null
      // Clear the current input line
      rl.write('', { ctrl: true, name: 'u' })
      resolve(null)
    }
  })

  rl.on('line', (line) => {
    if (lineResolve) {
      const resolve = lineResolve
      lineResolve = null
      resolve(line)
    } else {
      lineQueue.push(line)
    }
  })

  rl.on('close', () => {
    if (lineResolve) {
      const resolve = lineResolve
      lineResolve = null
      resolve(null)
    }
  })

  const nextLine = (): Promise<string | null> => {
    if (lineQueue.length > 0) {
      return Promise.resolve(lineQueue.shift()!)
    }
    return new Promise(resolve => { lineResolve = resolve })
  }

  state.rawSelect = (count, initial, render, menuLines) => {
    let cursor = initial

    const clearMenu = () => {
      process.stdout.write(`\x1b[${menuLines}A\x1b[0J`)
    }

    // Remove all existing stdin listeners so readline can't interfere
    const savedDataListeners = process.stdin.listeners('data').slice()
    const savedKeypressListeners = process.stdin.listeners('keypress').slice()
    process.stdin.removeAllListeners('data')
    process.stdin.removeAllListeners('keypress')

    const wasRaw = process.stdin.isRaw
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.resume()

    render(cursor)

    // Buffer for accumulating escape sequences
    let escBuf = ''
    let escTimer: ReturnType<typeof setTimeout> | null = null

    return new Promise<number | null>((resolve) => {
      const cleanup = (value: number | null) => {
        process.stdin.removeListener('data', onData)
        if (escTimer) clearTimeout(escTimer)
        if (process.stdin.isTTY) process.stdin.setRawMode(!!wasRaw)

        // Restore all saved listeners
        for (const fn of savedDataListeners) {
          process.stdin.on('data', fn as (...args: unknown[]) => void)
        }
        for (const fn of savedKeypressListeners) {
          process.stdin.on('keypress', fn as (...args: unknown[]) => void)
        }
        rl.resume()

        clearMenu()
        resolve(value)
      }

      const onData = (buf: Buffer) => {
        const str = buf.toString('utf8')

        for (let i = 0; i < str.length; i++) {
          const ch = str[i]

          if (escBuf.length > 0) {
            escBuf += ch
            if (escTimer) clearTimeout(escTimer)

            // Complete escape sequences: \x1b[ + letter
            if (escBuf.length >= 3 && escBuf[1] === '[') {
              const code = escBuf[2]
              escBuf = ''
              if (code === 'A') {
                // Up arrow
                cursor = (cursor - 1 + count) % count
                clearMenu()
                render(cursor)
              } else if (code === 'B') {
                // Down arrow
                cursor = (cursor + 1) % count
                clearMenu()
                render(cursor)
              }
              continue
            }

            // If buffer is getting long, discard it
            if (escBuf.length > 5) {
              escBuf = ''
            }
            continue
          }

          if (ch === '\x1b') {
            // Start of escape sequence — wait briefly to see if more bytes follow
            escBuf = ch
            escTimer = setTimeout(() => {
              // Standalone Esc (no sequence followed)
              escBuf = ''
              cleanup(null)
            }, 50)
            continue
          }

          if (ch === '\r' || ch === '\n') {
            cleanup(cursor)
            return
          }
        }
      }

      process.stdin.on('data', onData)
      process.stdin.resume()
    })
  }

  while (true) {
    drawPrompt()
    const input = await nextLine()
    // Clear the prompt block: move to top hr line, clear to end of screen
    // After readline enter, cursor is on the line after prompt (N+2).
    // Top hr is at N, so go up 2 lines and clear everything from there.
    process.stdout.write('\x1b[2A\x1b[0G\x1b[J')
    if (input === null) break
    const trimmed = input.trim()

    if (!trimmed) continue

    if (trimmed.startsWith('/')) {
      const handled = await handleCommand(trimmed, state, nextLine)
      if (handled === 'exit') {
        rl.close()
        watcher.stop()
        process.exit(0)
      }
    } else {
      console.log(dim('  Use /help for available commands.'))
    }
  }

  watcher.stop()
  process.exit(0)
}

async function handleCommand(
  input: string,
  state: ReplState,
  nextLine: () => Promise<string | null>,
): Promise<string | void> {
  const parts = input.slice(1).split(/\s+/)
  const cmd = parts[0].toLowerCase()

  switch (cmd) {
    case 'exit':
    case 'quit':
    case 'q':
      console.log(dim('  Goodbye!'))
      return 'exit'

    case 'help':
    case 'h':
    case '?':
      printHelp()
      break

    case 'review':
      await handleReview(state, nextLine)
      break

    case 'learnings':
      await handleLearnings(state, nextLine)
      break

    case 'setup':
      await handleSetup(state, nextLine)
      break

    case 'overview':
      await printOverview(state)
      break

    default:
      console.log(red(`  Unknown command: ${cmd}.`) + dim(' Type /help for available commands.'))
  }
}

function printHelp(): void {
  console.log(`
  ${bold('Commands:')}
    ${cyan('/review')}      ${dim('Review an agent run for improvements')}
    ${cyan('/learnings')}   ${dim('List current learnings')}
    ${cyan('/setup')}       ${dim('Configure settings')}
    ${cyan('/overview')}    ${dim('Show agents & learnings overview')}
    ${cyan('/help')}        ${dim('Show this help')}
    ${cyan('/exit')}        ${dim('Quit')}
`)
}

async function handleReview(
  state: ReplState,
  nextLine: () => Promise<string | null>,
): Promise<void> {
  try {
    // Gather all sessions: active + recent ended (reviewed & unreviewed)
    const recentSessions = await state.store.getRecentSessions(20)
    const status = state.watcher.getStatus()
    const activeSessions = status.sessions

    interface ReviewChoice {
      label: string
      sessionId: string
      agent: string
      eventCount: number
      active: boolean
      projectCwd: string
    }

    const choices: ReviewChoice[] = []

    const timeAgo = (ts: number): string => {
      const mins = Math.floor((Date.now() - ts) / 60000)
      if (mins < 1) return 'just now'
      if (mins < 60) return `${mins}m ago`
      const hrs = Math.floor(mins / 60)
      if (hrs < 24) return `${hrs}h ago`
      return `${Math.floor(hrs / 24)}d ago`
    }

    const agentColor = (name: string) => name === 'claude' ? salmon : seafoam

    for (const s of activeSessions) {
      const shortPath = (s.projectCwd || state.cwd).replace(process.env.HOME || '', '~')
      const summary = await state.store.getSessionSummary(s.sessionId)
      const newEventCount = summary?.reviewedEventCount != null ? s.eventCount - summary.reviewedEventCount : 0
      const hasNewEvents = newEventCount > 0
      const reviewStatus = !summary?.analyzed
        ? yellow('[unreviewed]')
        : hasNewEvents
          ? cyan('[re-review]')
          : teal('[reviewed]')
      const newEventsSuffix = hasNewEvents ? ` ${cyan(`+${newEventCount} new`)}` : ''
      choices.push({
        label: `${green('●')} ${bold(agentColor(s.agent)(s.agent))} ${dim('(active)')} ${dim('·')} ${steelblue(shortPath)} ${dim('·')} ${dim(`${s.eventCount} events`)}${newEventsSuffix} ${reviewStatus}`,
        sessionId: s.sessionId,
        agent: s.agent,
        eventCount: s.eventCount,
        active: true,
        projectCwd: s.projectCwd || state.cwd,
      })
    }

    for (const s of recentSessions) {
      // Skip if already listed as active
      if (choices.some(c => c.sessionId === s.id)) continue
      const endedCwd = s.projectCwd || state.cwd
      const shortPath = endedCwd.replace(process.env.HOME || '', '~')
      const events = await state.store.getSessionEvents(s.id)
      const reviewStatus = s.analyzed ? teal('[reviewed]') : yellow('[unreviewed]')
      choices.push({
        label: `${gray('○')} ${bold(agentColor(s.agent)(s.agent))} ${dim('·')} ${steelblue(shortPath)} ${dim('·')} ${dim(`${events.length} events`)} ${dim('(')}${dim(timeAgo(s.startedAt))}${dim(')')} ${reviewStatus}`,
        sessionId: s.id,
        agent: s.agent,
        eventCount: 0,
        active: false,
        projectCwd: endedCwd,
      })
    }

    console.log(`\n  ${bold('●')} ${bold('Review')}\n`)

    if (choices.length === 0) {
      console.log(dim('  No agent runs to review.'))
      return
    }

    for (let i = 0; i < choices.length; i++) {
      console.log(`  ${cyan(`${i + 1})`)} ${choices[i].label}`)
    }
    console.log('')

    process.stdout.write(dim('  Select (number or esc to cancel): '))
    const choice = await nextLine()
    if (!choice || choice.trim().toLowerCase() === 'q') {
      console.log(dim('  Cancelled.'))
      return
    }

    const idx = parseInt(choice.trim()) - 1
    if (isNaN(idx) || idx < 0 || idx >= choices.length) {
      console.log(red('  Invalid selection.'))
      return
    }

    const picked = choices[idx]
    console.log(dim(`  Reviewing ${picked.agent} run ${picked.sessionId.slice(0, 8)}...`))

    let result

    if (picked.active) {
      // Active — create a temporary summary
      const events = await state.store.getSessionEvents(picked.sessionId)
      console.log(dim(`  Found ${events.length} events`))

      if (events.length === 0) {
        console.log(yellow('  No events recorded yet.'))
        return
      }

      const filesChanged = [...new Set(
        events.filter(e => e.type === 'file_edit').map(e => e.path)
      )]
      const testEvents = events.filter(e => e.type === 'test_result')
      const hasFailures = testEvents.some(e => e.type === 'test_result' && e.failed > 0)
      const hasSuccesses = testEvents.some(e => e.type === 'test_result' && e.passed > 0 && e.failed === 0)
      let outcome: SessionSummary['outcome'] = 'unknown'
      if (hasFailures && hasSuccesses) outcome = 'partial'
      else if (hasFailures) outcome = 'failure'
      else if (hasSuccesses) outcome = 'success'

      const tempSummary: SessionSummary = {
        id: picked.sessionId,
        agent: picked.agent,
        prompt: '',
        startedAt: events[0]?.timestamp ?? Date.now(),
        endedAt: Date.now(),
        outcome,
        filesChanged,
        interventions: 0,
        analyzed: false,
      }

      await state.store.saveSessionSummary(tempSummary)
      result = await analyzeSession(picked.sessionId, state.store, state.config, step => {
        console.log(dim(`  ${step}`))
      })
    } else {
      // Ended — review normally
      result = await analyzeSession(picked.sessionId, state.store, state.config, step => {
        console.log(dim(`  ${step}`))
      })
    }

    const { suggestions, reviewAgent } = result
    console.log(dim(`  ${suggestions.length} suggestion(s) from ${green(reviewAgent)}`))

    const rules = await presentSuggestions(suggestions, nextLine, picked.agent)

    for (const rule of rules) {
      rule.projectCwd = picked.projectCwd
      await state.store.saveRule(rule)

      if (rule.status === 'approved') {
        try {
          await applyRule(rule, state.store, picked.projectCwd)
          const appliedPath = rule.scope === 'global'
            ? `~/.claude/${rule.targetFile}`
            : `${picked.projectCwd}/${rule.targetFile}`
          console.log(`  ${green('✓')} Applied learning ${dim('→')} ${cyan(appliedPath)}`)
        } catch (err) {
          console.log(red(`  Failed to apply: ${(err as Error).message}`))
        }
      }
    }
  } catch (err) {
    console.log(red(`  Review failed: ${(err as Error).message}`))
  }
}

async function handleSetup(
  state: ReplState,
  _nextLine: () => Promise<string | null>,
): Promise<void> {
  if (!state.rawSelect) return

  const currentAgent = state.config.analysis.agent
  const agents: Array<{ name: string; description: string }> = [
    { name: 'auto', description: "Use the session's own agent" },
    { name: 'claude', description: 'Use Claude Code for reviews' },
    { name: 'codex', description: 'Use OpenAI Codex for reviews' },
  ]
  const initial = Math.max(0, agents.findIndex(a => a.name === currentAgent))

  console.log(`\n  ${bold('●')} ${bold('Setup')}\n`)
  console.log(`  ${dim('Select which agent to use for /review analysis:')}\n`)

  const menuLines = agents.length * 2 + 2

  const renderMenu = (cur: number): void => {
    for (let i = 0; i < agents.length; i++) {
      const { name, description } = agents[i]
      const isCurrent = name === currentAgent
      if (i === cur) {
        console.log(`  ${cyan('❯')} ${green('●')} ${bold(name)}${isCurrent ? dim(' (current)') : ''}`)
      } else {
        console.log(`    ${gray('○')} ${name}${isCurrent ? dim(' (current)') : ''}`)
      }
      console.log(`      ${dim(description)}`)
    }
    console.log('')
    console.log(dim('  ↑/↓ move · enter select · esc cancel'))
  }

  const result = await state.rawSelect(agents.length, initial, renderMenu, menuLines)

  if (result === null) {
    console.log(dim('  Cancelled.'))
    return
  }

  const selected = agents[result].name
  if (selected === currentAgent) {
    console.log(dim(`  Already set to ${selected}.`))
    return
  }

  state.config.analysis.agent = selected
  await saveConfig(state.config)
  console.log(`  ${green('✓')} Review agent ${dim('→')} ${cyan(bold(selected))}`)
}

async function printOverview(state: ReplState): Promise<void> {
  const rules = await state.store.getRules()
  const mainAgentColor = (name: string) => name === 'claude' ? salmon : seafoam
  const status = state.watcher.getStatus()
  const unreviewed = await state.store.getUnanalyzedSessions()
  const recentSessions = await state.store.getRecentSessions(50)

  const agentTargets: Record<string, string[]> = {
    claude: ['CLAUDE.md', '.claude/CLAUDE.md', '.claude/settings.json'],
    codex: ['AGENTS.md', 'codex.md', '.codex/AGENTS.md'],
  }

  let first = true
  for (const [name, agent] of Object.entries(state.config.adapters.agents)) {
    const label = first ? `${steelblue('overview')}  ` : '          '
    const activeSessions = status.sessions.filter(s => s.agent === name)
    const targets = agentTargets[name] || []
    const agentRules = rules.filter(r => r.status === 'applied' && targets.includes(r.targetFile))
    const globalCount = agentRules.filter(r => r.scope === 'global').length

    const globalSuffix = globalCount > 0
      ? ` ${dim('·')} ${teal(`${globalCount} learning${globalCount > 1 ? 's' : ''}`)} ${yellow('(global)')}`
      : ''

    const activePaths = new Set(activeSessions.map(s => s.projectCwd || state.cwd))
    const allPaths = new Set<string>()
    for (const s of recentSessions) {
      if (s.agent === name && s.projectCwd) allPaths.add(s.projectCwd)
    }
    for (const p of activePaths) allPaths.add(p)

    if (!agent.detected) {
      console.log(`  ${label}${gray('○')} ${gray(name)}`)
    } else {
      console.log(`  ${label}${mainAgentColor(name)('●')} ${mainAgentColor(name)(name)}${globalSuffix}`)
      for (const p of allPaths) {
        const shortPath = p.replace(process.env.HOME || '', '~')
        const activeSession = activeSessions.find(s => (s.projectCwd || state.cwd) === p)
        const projectRuleCount = agentRules.filter(r => r.scope === 'project' && r.projectCwd === p).length
        const projectSuffix = projectRuleCount > 0
          ? ` ${dim('·')} ${teal(`${projectRuleCount} learning${projectRuleCount > 1 ? 's' : ''}`)} ${yellow('(project)')}`
          : ''
        if (activeSession) {
          const liveLabel = activeSession.live ? '' : dim(' [idle]')
          console.log(`              ${dim('·')} ${steelblue(shortPath)} ${dim('·')} ${dim(`${activeSession.eventCount} events`)} ${green('● running')}${liveLabel}${projectSuffix}`)
        } else {
          console.log(`              ${dim('·')} ${steelblue(shortPath)}${projectSuffix}`)
        }
      }
    }
    first = false
  }

  if (unreviewed.length > 0) {
    console.log(`\n  ${yellow('⚡')} ${bold(`${unreviewed.length}`)} ${yellow('unreviewed run' + (unreviewed.length > 1 ? 's' : ''))} found ${dim('—')} run ${cyan('/review')} to review`)
  }
  console.log('')
}

async function handleLearnings(
  state: ReplState,
  nextLine: () => Promise<string | null>,
): Promise<void> {
  const rules = await state.store.getRules()

  console.log(`\n  ${bold('●')} ${bold('Learnings')}\n`)

  if (rules.length === 0) {
    console.log(dim('  No learnings yet. Run /review.'))
    return
  }
  const ruleAgent = (targetFile: string): string => {
    if (targetFile.includes('claude') || targetFile.includes('CLAUDE')) return 'claude'
    if (targetFile.includes('codex') || targetFile.includes('AGENTS')) return 'codex'
    return 'unknown'
  }
  const ruleAgentColor = (name: string) => name === 'claude' ? salmon : seafoam

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    const statusColor = rule.status === 'applied' ? green
      : rule.status === 'rejected' ? red
      : rule.status === 'reverted' ? gray
      : yellow
    const agent = ruleAgent(rule.targetFile)
    const scopeLabel = rule.scope === 'global' ? yellow('(global)') : yellow('(project)')
    console.log(`  ${cyan(`${i + 1})`)} ${statusColor(`[${rule.status}]`)} ${ruleAgentColor(agent)(agent)} ${scopeLabel} ${rule.rationale.slice(0, 50)}`)
    if (rule.scope === 'global') {
      console.log(`     ${dim('→')} ${dim('~/' + rule.targetFile)}`)
    } else {
      const shortPath = rule.projectCwd ? rule.projectCwd.replace(process.env.HOME || '', '~') : ''
      console.log(`     ${dim('→')} ${steelblue(shortPath)}${shortPath ? dim('/') : ''}${dim(rule.targetFile)}`)
    }
  }
  console.log('')

  process.stdout.write(dim('  View detail (number or esc to go back): '))
  const choice = await nextLine()
  if (!choice || choice.trim().toLowerCase() === 'q') {
    console.log('')
    return
  }

  const idx = parseInt(choice.trim()) - 1
  if (isNaN(idx) || idx < 0 || idx >= rules.length) {
    console.log(red('  Invalid selection.'))
    return
  }

  const rule = rules[idx]
  const projectPath = (rule.projectCwd || state.cwd).replace(process.env.HOME || '', '~')
  const scopeLabel = rule.scope === 'global' ? yellow('global') : yellow('project')
  const statusColor = rule.status === 'applied' ? green
    : rule.status === 'rejected' ? red
    : rule.status === 'reverted' ? gray
    : yellow
  console.log('')
  console.log(`  ${statusColor(`[${rule.status}]`)} ${rule.rationale}`)
  console.log('')
  for (const line of rule.content.split('\n')) {
    console.log(`    ${green(line)}`)
  }
  console.log('')
  console.log(`  ${dim('→')} ${cyan(`${projectPath}/${rule.targetFile}`)} ${dim('(')}${scopeLabel}${dim(')')} ${dim('·')} ${rule.action}`)
  console.log('')
}

