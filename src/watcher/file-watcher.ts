import { watch, type FSWatcher } from 'fs'
import { EventEmitter } from 'events'
import { createIgnoreMatcher } from './ignore.js'

export interface FileChangeEvent {
  path: string
  timestamp: number
}

export class FileWatcher extends EventEmitter {
  private fsWatcher: FSWatcher | null = null
  private ignoreMatcher: (path: string) => boolean

  constructor(private cwd: string) {
    super()
    this.ignoreMatcher = createIgnoreMatcher(cwd)
  }

  start(): void {
    this.fsWatcher = watch(this.cwd, { recursive: true }, (eventType, filename) => {
      if (!filename) return
      const relativePath = filename.toString()

      if (this.ignoreMatcher(relativePath)) return

      const event: FileChangeEvent = {
        path: relativePath,
        timestamp: Date.now(),
      }
      this.emit('change', event)
    })

    this.fsWatcher.on('error', (err) => {
      this.emit('error', err)
    })
  }

  stop(): void {
    if (this.fsWatcher) {
      this.fsWatcher.close()
      this.fsWatcher = null
    }
  }
}
