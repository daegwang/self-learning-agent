import type { Adapter } from './types.js'
import { ClaudeAdapter } from './claude.js'
import { CodexAdapter } from './codex.js'

export class AdapterRegistry {
  private adapters: Adapter[] = []

  register(adapter: Adapter): void {
    this.adapters.push(adapter)
  }

  getAll(): Adapter[] {
    return this.adapters
  }

  get(name: string): Adapter | undefined {
    return this.adapters.find(a => a.name === name)
  }

  async detectActive(cwd: string): Promise<Adapter[]> {
    const results: Adapter[] = []
    for (const adapter of this.adapters) {
      if (await adapter.detectActivity(cwd)) {
        results.push(adapter)
      }
    }
    return results
  }
}

export function createDefaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry()
  registry.register(new ClaudeAdapter())
  registry.register(new CodexAdapter())
  return registry
}
