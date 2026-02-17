import { execSync } from 'child_process'
import { Store } from '../store/index.js'
import type { AdapterEvent, SessionSummary, FileEditEvent, SessionOutcome } from '../types.js'

const SESSION_GAP_MS = 30 * 60 * 1000 // 30 minutes between commits = new session

interface GitCommit {
  hash: string
  timestamp: number
  message: string
  author: string
}

export async function bootstrapFromGit(
  cwd: string,
  store?: Store,
): Promise<{ sessionsCreated: number; eventsCreated: number }> {
  if (!store) {
    store = new Store()
    await store.init()
  }

  let commits: GitCommit[]
  try {
    const log = execSync(
      'git log --all --format="%H %at %aN|%s" --no-merges',
      { cwd, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim()

    if (!log) return { sessionsCreated: 0, eventsCreated: 0 }

    commits = log.split('\n').map(line => {
      const [hash, atStr, ...rest] = line.split(' ')
      const remainder = rest.join(' ')
      const pipeIdx = remainder.indexOf('|')
      const author = remainder.slice(0, pipeIdx)
      const message = remainder.slice(pipeIdx + 1)
      return { hash, timestamp: parseInt(atStr) * 1000, message, author }
    })
  } catch {
    return { sessionsCreated: 0, eventsCreated: 0 }
  }

  // Sort by timestamp ascending
  commits.sort((a, b) => a.timestamp - b.timestamp)

  // Group by author + time proximity
  const sessions: GitCommit[][] = []
  let currentGroup: GitCommit[] = []
  let lastAuthor = ''
  let lastTime = 0

  for (const commit of commits) {
    if (
      currentGroup.length === 0 ||
      (commit.author === lastAuthor && commit.timestamp - lastTime < SESSION_GAP_MS)
    ) {
      currentGroup.push(commit)
    } else {
      sessions.push(currentGroup)
      currentGroup = [commit]
    }
    lastAuthor = commit.author
    lastTime = commit.timestamp
  }
  if (currentGroup.length > 0) {
    sessions.push(currentGroup)
  }

  let sessionsCreated = 0
  let eventsCreated = 0

  for (const group of sessions) {
    const sessionId = `git-${group[0].hash.slice(0, 8)}`
    const events: AdapterEvent[] = []

    // Session start
    events.push({
      type: 'session_start',
      sessionId,
      agent: 'git',
      timestamp: group[0].timestamp,
      prompt: group[0].message,
    })

    for (const commit of group) {
      // Get file changes for this commit
      const fileEvents = getCommitFileEvents(commit, sessionId, cwd)
      events.push(...fileEvents)
      eventsCreated += fileEvents.length

      // Detect test-related commits
      if (isTestCommit(commit.message)) {
        events.push({
          type: 'test_result',
          sessionId,
          timestamp: commit.timestamp,
          framework: 'git-inferred',
          passed: isFailureCommit(commit.message) ? 0 : 1,
          failed: isFailureCommit(commit.message) ? 1 : 0,
          skipped: 0,
          raw: commit.message,
        })
        eventsCreated++
      }
    }

    // Session end
    const lastCommit = group[group.length - 1]
    events.push({
      type: 'session_end',
      sessionId,
      timestamp: lastCommit.timestamp,
    })

    // Determine outcome from commit messages
    const outcome = determineOutcome(group)

    // Store events
    for (const event of events) {
      await store.appendEvent(event)
    }
    eventsCreated += 2 // start + end

    // Store session summary
    const filesChanged = new Set<string>()
    for (const e of events) {
      if (e.type === 'file_edit') filesChanged.add(e.path)
    }

    const summary: SessionSummary = {
      id: sessionId,
      agent: 'git',
      prompt: group[0].message,
      startedAt: group[0].timestamp,
      endedAt: lastCommit.timestamp,
      outcome,
      filesChanged: [...filesChanged],
      interventions: countInterventions(group),
      analyzed: false,
    }

    await store.saveSessionSummary(summary)
    sessionsCreated++
  }

  return { sessionsCreated, eventsCreated }
}

function getCommitFileEvents(commit: GitCommit, sessionId: string, cwd: string): FileEditEvent[] {
  const events: FileEditEvent[] = []

  try {
    const diffTree = execSync(
      `git diff-tree --no-commit-id -r --numstat ${commit.hash}`,
      { cwd, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim()

    if (!diffTree) return events

    for (const line of diffTree.split('\n')) {
      if (!line.trim()) continue
      const [addedStr, removedStr, ...pathParts] = line.split('\t')
      const path = pathParts.join('\t') // handle paths with tabs (rare)
      const added = addedStr === '-' ? 0 : parseInt(addedStr) || 0
      const removed = removedStr === '-' ? 0 : parseInt(removedStr) || 0

      events.push({
        type: 'file_edit',
        sessionId,
        timestamp: commit.timestamp,
        path,
        linesAdded: added,
        linesRemoved: removed,
        tool: 'git',
      })
    }
  } catch {
    // ignore
  }

  return events
}

function determineOutcome(group: GitCommit[]): SessionOutcome {
  const messages = group.map(c => c.message.toLowerCase())

  // Reverts and fixups are failure signals
  const hasRevert = messages.some(m => m.startsWith('revert'))
  const hasFixup = messages.some(m => m.startsWith('fixup!') || m.startsWith('squash!'))
  const hasFix = messages.some(m => m.includes('fix') && (m.includes('bug') || m.includes('error') || m.includes('crash')))

  if (hasRevert) return 'failure'
  if (hasFixup || hasFix) return 'partial'
  return 'success'
}

function isTestCommit(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('test') || lower.includes('spec') || lower.includes('jest') || lower.includes('pytest')
}

function isFailureCommit(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('fix') || lower.includes('revert') || lower.includes('broken')
}

function countInterventions(group: GitCommit[]): number {
  let count = 0
  for (const commit of group) {
    const lower = commit.message.toLowerCase()
    if (lower.startsWith('revert') || lower.startsWith('fixup!') || lower.startsWith('squash!')) {
      count++
    }
  }
  return count
}
