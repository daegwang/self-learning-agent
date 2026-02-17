import { Store } from '../store/index.js'
import { LiveWatcher } from '../watcher/index.js'
import { createDefaultRegistry } from '../adapter/registry.js'
import { SocketServer } from './socket-server.js'
import { loadConfig, ensureSlagentDir } from '../config.js'

export async function startDaemon(cwd: string): Promise<{ watcher: LiveWatcher; socketServer: SocketServer }> {
  await ensureSlagentDir()

  const config = await loadConfig(cwd)
  const store = new Store()
  await store.init()

  const registry = createDefaultRegistry()
  const watcher = new LiveWatcher(store, registry, config, cwd)
  const socketServer = new SocketServer(cwd)

  await socketServer.start()
  await watcher.start()

  // Graceful shutdown
  const shutdown = async () => {
    watcher.stop()
    socketServer.stop()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  return { watcher, socketServer }
}
