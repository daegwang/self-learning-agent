import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { execSync } from 'child_process'
import type { SlcConfig, AgentDef } from './types.js'

const DEFAULT_CONFIG: SlcConfig = {
  version: 1,
  adapters: {
    pollIntervalMs: 5000,
    agents: {
      claude: {
        command: 'claude',
        analyzeArgs: ['-p'],
        detected: false,
      },
      codex: {
        command: 'codex',
        analyzeArgs: ['exec'],
        detected: false,
      },
    },
  },
  instructionFiles: [],
  privacy: {
    redactSecrets: true,
    excludePaths: ['node_modules', '.env', '.env.local'],
  },
  analysis: {
    agent: 'auto',
    tokenBudget: 8000,
    timeoutMs: 120_000,
    minConfidence: 0.6,
  },
  retention: {
    maxAgeDays: 90,
  },
}

export { DEFAULT_CONFIG }

export function slagentRoot(): string {
  return join(homedir(), '.slagent')
}

export async function ensureSlagentDir(): Promise<void> {
  const slagentDir = slagentRoot()
  const subdirs = ['events', 'rules', 'backups', 'sessions']

  for (const sub of [slagentDir, ...subdirs.map(s => join(slagentDir, s))]) {
    if (!existsSync(sub)) {
      await mkdir(sub, { recursive: true })
    }
  }
}

export async function loadConfig(cwd: string): Promise<SlcConfig> {
  const configPath = join(slagentRoot(), 'config.json')

  let config: SlcConfig
  try {
    if (existsSync(configPath)) {
      const content = await readFile(configPath, 'utf-8')
      const stored = JSON.parse(content)
      config = deepMerge(DEFAULT_CONFIG, stored) as SlcConfig
    } else {
      config = structuredClone(DEFAULT_CONFIG)
    }
  } catch {
    config = structuredClone(DEFAULT_CONFIG)
  }

  // Always detect all known agents at runtime
  config.adapters.agents = detectAgents()

  // Auto-discover instruction files if none configured
  if (config.instructionFiles.length === 0) {
    config.instructionFiles = discoverInstructionFiles(cwd)
  }

  return config
}

export async function saveConfig(config: SlcConfig): Promise<void> {
  await ensureSlagentDir()
  const configPath = join(slagentRoot(), 'config.json')
  await writeFile(configPath, JSON.stringify(config, null, 2))
}

// Agent → instruction file mappings
const AGENT_INSTRUCTION_FILES: Record<string, { project: string[]; global: string[] }> = {
  claude: {
    project: ['CLAUDE.md', '.claude/settings.json'],
    global: ['.claude/CLAUDE.md', '.claude/settings.json'],
  },
  codex: {
    project: ['AGENTS.md', 'codex.md'],
    global: ['.codex/AGENTS.md'],
  },
}

// Fallback instruction files checked for any agent
const GENERIC_INSTRUCTION_FILES = [
  '.cursorrules',
  '.github/copilot-instructions.md',
  '.ai/rules.md',
]

export function discoverInstructionFiles(cwd: string): string[] {
  const candidates = [
    'CLAUDE.md',
    '.cursorrules',
    'AGENTS.md',
    '.github/copilot-instructions.md',
    '.ai/rules.md',
  ]

  return candidates.filter(f => existsSync(join(cwd, f)))
}

export interface AgentInstructionFiles {
  project: Record<string, string>  // relative path → content
  global: Record<string, string>   // relative path → content
}

export function discoverAgentInstructionFiles(agent: string, projectCwd: string): AgentInstructionFiles {
  const home = homedir()
  const mapping = AGENT_INSTRUCTION_FILES[agent]
  const result: AgentInstructionFiles = { project: {}, global: {} }

  // Agent-specific project files
  const projectCandidates = mapping ? [...mapping.project] : []
  // Add generic files
  projectCandidates.push(...GENERIC_INSTRUCTION_FILES)

  for (const file of projectCandidates) {
    const abs = join(projectCwd, file)
    if (existsSync(abs)) {
      result.project[file] = abs
    }
  }

  // Agent-specific global files
  const globalCandidates = mapping ? mapping.global : []
  for (const file of globalCandidates) {
    const abs = join(home, file)
    if (existsSync(abs)) {
      result.global[file] = abs
    }
  }

  return result
}

export function detectAgents(): Record<string, AgentDef> {
  const agents: Record<string, AgentDef> = {}

  const defs: Array<{ name: string; command: string; analyzeArgs: string[]; historyDir?: string }> = [
    { name: 'claude', command: 'claude', analyzeArgs: ['-p'], historyDir: join(homedir(), '.claude', 'projects') },
    { name: 'codex', command: 'codex', analyzeArgs: ['exec'], historyDir: join(homedir(), '.codex', 'sessions') },
  ]

  for (const def of defs) {
    const detected = commandExists(def.command)
    agents[def.name] = {
      command: def.command,
      analyzeArgs: def.analyzeArgs,
      detected,
      historyDir: def.historyDir,
    }
  }

  return agents
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function homedir(): string {
  return process.env.HOME || process.env.USERPROFILE || '~'
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key])
    } else {
      result[key] = source[key]
    }
  }
  return result
}
