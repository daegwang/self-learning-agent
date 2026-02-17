import { readFileSync } from 'fs'
import { join } from 'path'

const HARDCODED_IGNORES = ['.slagent/', '.git/', 'node_modules/', '.DS_Store']

export function createIgnoreMatcher(cwd: string): (relativePath: string) => boolean {
  const patterns: IgnorePattern[] = []

  // Hardcoded ignores
  for (const raw of HARDCODED_IGNORES) {
    patterns.push(parsePattern(raw))
  }

  // .gitignore
  const gitignorePaths = [
    join(cwd, '.gitignore'),
    join(cwd, '.git', 'info', 'exclude'),
  ]

  for (const filepath of gitignorePaths) {
    try {
      const content = readFileSync(filepath, 'utf-8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        patterns.push(parsePattern(trimmed))
      }
    } catch {
      // File doesn't exist, skip
    }
  }

  return (relativePath: string): boolean => {
    let ignored = false
    for (const pattern of patterns) {
      if (pattern.negated) {
        if (matchPattern(relativePath, pattern)) {
          ignored = false
        }
      } else {
        if (matchPattern(relativePath, pattern)) {
          ignored = true
        }
      }
    }
    return ignored
  }
}

interface IgnorePattern {
  negated: boolean
  dirOnly: boolean
  anchored: boolean
  regex: RegExp
}

function parsePattern(raw: string): IgnorePattern {
  let pattern = raw
  const negated = pattern.startsWith('!')
  if (negated) pattern = pattern.slice(1)

  const dirOnly = pattern.endsWith('/')
  if (dirOnly) pattern = pattern.slice(0, -1)

  const anchored = pattern.startsWith('/')
  if (anchored) pattern = pattern.slice(1)

  const regex = globToRegex(pattern, anchored)
  return { negated, dirOnly, anchored, regex }
}

function globToRegex(pattern: string, anchored: boolean): RegExp {
  let regex = ''
  let i = 0

  while (i < pattern.length) {
    const ch = pattern[i]

    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        regex += '(?:.+/)?'
        i += 3
      } else {
        regex += '.*'
        i += 2
      }
    } else if (ch === '*') {
      regex += '[^/]*'
      i++
    } else if (ch === '?') {
      regex += '[^/]'
      i++
    } else if (ch === '.') {
      regex += '\\.'
      i++
    } else {
      regex += ch
      i++
    }
  }

  if (anchored) {
    return new RegExp(`^${regex}(?:/|$)`)
  }
  return new RegExp(`(?:^|/)${regex}(?:/|$)`)
}

function matchPattern(path: string, pattern: IgnorePattern): boolean {
  return pattern.regex.test(path)
}
