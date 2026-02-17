#!/usr/bin/env node

import { parseArgs } from 'util'
import { startRepl } from './repl.js'
import { Store } from './store/index.js'
import { loadConfig, ensureSlagentDir } from './config.js'
import { LiveWatcher } from './watcher/index.js'
import { createDefaultRegistry } from './adapter/registry.js'
import { bold, dim, cyan } from './colors.js'

async function main() {
  const rawArgs = process.argv.slice(2)
  const cwd = process.cwd()

  const { values } = parseArgs({
    args: rawArgs,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
    allowPositionals: true,
  })

  if (values.version) {
    console.log('self-learning-agent v0.1.0')
    process.exit(0)
  }

  if (values.help) {
    printHelp()
    process.exit(0)
  }

  // Start watcher in-process + REPL
  await ensureSlagentDir()
  const config = await loadConfig(cwd)
  const store = new Store()
  await store.init()

  const registry = createDefaultRegistry()
  const watcher = new LiveWatcher(store, registry, config, cwd)
  await watcher.start()

  await startRepl(cwd, watcher)
}

function printHelp(): void {
  console.log(`
${bold('self-learning-agent (slagent)')} v0.1.0

${dim('Watches coding AI agents and improves their instructions over time.')}

${bold('Usage:')}
  ${cyan('slagent')}            ${dim('Start watcher + interactive REPL')}

${bold('Options:')}
  ${cyan('-h, --help')}         ${dim('Show this help')}
  ${cyan('--version')}          ${dim('Show version')}

${bold('REPL commands:')}
  ${cyan('/review')}            ${dim('Review an agent run for improvements')}
  ${cyan('/learnings')}         ${dim('List current learnings')}
  ${cyan('/setup')}             ${dim('Configure settings')}
  ${cyan('/overview')}          ${dim('Show agents & learnings overview')}
  ${cyan('/help')}              ${dim('Show this help')}
  ${cyan('/exit')}              ${dim('Quit')}
`)
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
