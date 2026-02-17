import { readFile, writeFile, mkdir, readdir, copyFile } from 'fs/promises'
import { join, dirname } from 'path'
import { existsSync } from 'fs'
import { slagentRoot } from '../config.js'
import { Store } from '../store/index.js'
import type { Rule } from '../types.js'

const AGENT_TARGETS: Record<string, { project: string; global: string }> = {
  claude: { project: 'CLAUDE.md', global: '.claude/CLAUDE.md' },
  codex: { project: 'AGENTS.md', global: '.codex/AGENTS.md' },
}

export function resolveTargetFile(agent: string, scope: 'global' | 'project'): string {
  const targets = AGENT_TARGETS[agent] || AGENT_TARGETS.claude
  return scope === 'global' ? targets.global : targets.project
}

function resolveRulePath(rule: Rule, cwd: string): string {
  if (rule.scope === 'global') {
    const home = process.env.HOME || process.env.USERPROFILE || '~'
    return join(home, rule.targetFile)
  }
  return join(cwd, rule.targetFile)
}

export async function applyRule(rule: Rule, store: Store, cwd: string): Promise<void> {
  const absPath = resolveRulePath(rule, cwd)

  // Ensure parent directory exists (e.g. ~/.claude/)
  const dir = dirname(absPath)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }

  // Backup first
  if (existsSync(absPath)) {
    const backupBasename = absPath.replace(/[/\\]/g, '_')
    const backupName = `${Date.now()}-${backupBasename}`
    const backupPath = join(slagentRoot(), 'backups', backupName)
    await copyFile(absPath, backupPath)
  }

  let currentContent = ''
  try {
    currentContent = await readFile(absPath, 'utf-8')
  } catch {
    // New file
  }

  let newContent: string
  switch (rule.action) {
    case 'add':
      newContent = currentContent
        ? currentContent.trimEnd() + '\n\n' + rule.content + '\n'
        : rule.content + '\n'
      break
    case 'modify':
      if (rule.diff && currentContent.includes(rule.diff)) {
        newContent = currentContent.replace(rule.diff, rule.content)
      } else {
        // Fallback: append
        newContent = currentContent.trimEnd() + '\n\n' + rule.content + '\n'
      }
      break
    case 'remove':
      newContent = currentContent.replace(rule.content, '').replace(/\n{3,}/g, '\n\n')
      break
    default:
      throw new Error(`Unknown action: ${rule.action}`)
  }

  await writeFile(absPath, newContent)
  await store.updateRule(rule.id, {
    status: 'applied',
    metrics: { ...rule.metrics, appliedAt: Date.now() },
  })
}

export async function undoRule(rule: Rule, store: Store, cwd: string): Promise<void> {
  const absPath = resolveRulePath(rule, cwd)
  const backupsDir = join(slagentRoot(), 'backups')
  const backupBasename = absPath.replace(/[/\\]/g, '_')

  try {
    const files = await readdir(backupsDir)
    const matching = files
      .filter(f => f.endsWith(`-${backupBasename}`))
      .sort()
      .reverse()

    if (matching.length === 0) {
      throw new Error(`No backup found for ${rule.targetFile}`)
    }

    const backupPath = join(backupsDir, matching[0])
    await copyFile(backupPath, absPath)
    await store.updateRule(rule.id, { status: 'reverted' })
  } catch (err) {
    throw new Error(`Failed to undo rule: ${(err as Error).message}`)
  }
}

export async function detectConflicts(rule: Rule, cwd: string): Promise<boolean> {
  if (rule.action === 'add') return false

  const absPath = resolveRulePath(rule, cwd)
  try {
    const currentContent = await readFile(absPath, 'utf-8')
    if (rule.action === 'modify' && rule.diff) {
      return !currentContent.includes(rule.diff)
    }
    if (rule.action === 'remove') {
      return !currentContent.includes(rule.content)
    }
  } catch {
    return true // File doesn't exist
  }

  return false
}
