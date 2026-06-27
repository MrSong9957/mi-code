import { readFile, writeFile, appendFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

export interface HistoryEntry {
  input: string
  project: string
  sessionId: string
  timestamp: number
}

const MAX_HISTORY_ITEMS = 50

export class HistoryManager {
  private historyPath: string
  private sessionId: string
  private cache: HistoryEntry[] = []
  private historyIndex: number = -1
  private draft: string = ''
  private lastInput: string = ''

  constructor(historyPath?: string) {
    this.historyPath = historyPath || join(homedir(), '.micode', 'history.jsonl')
    this.sessionId = randomUUID()
  }

  async addEntry(input: string, project: string): Promise<void> {
    if (input === this.lastInput) {
      return
    }
    this.lastInput = input

    const entry: HistoryEntry = {
      input,
      project,
      sessionId: this.sessionId,
      timestamp: Date.now()
    }

    const dir = dirname(this.historyPath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }

    await appendFile(this.historyPath, JSON.stringify(entry) + '\n', 'utf-8')
    this.cache.unshift(entry)

    if (this.cache.length > MAX_HISTORY_ITEMS) {
      this.cache = this.cache.slice(0, MAX_HISTORY_ITEMS)
    }
  }

  async getHistory(project: string): Promise<HistoryEntry[]> {
    if (this.cache.length > 0) {
      return this.cache.filter(e => e.project === project)
    }

    if (!existsSync(this.historyPath)) {
      return []
    }

    const content = await readFile(this.historyPath, 'utf-8')
    const lines = content.split('\n').filter(line => line.trim())

    const entries: HistoryEntry[] = []
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as HistoryEntry
        if (entry.project === project) {
          entries.push(entry)
        }
      } catch {
        // skip corrupted lines
      }
    }

    entries.sort((a, b) => {
      if (a.sessionId === this.sessionId && b.sessionId !== this.sessionId) return -1
      if (a.sessionId !== this.sessionId && b.sessionId === this.sessionId) return 1
      return b.timestamp - a.timestamp
    })

    this.cache = entries.slice(0, MAX_HISTORY_ITEMS)
    return this.cache
  }

  async up(currentInput: string, project: string): Promise<string | null> {
    if (this.historyIndex === -1) {
      this.draft = currentInput
    }

    const history = await this.getHistory(project)

    if (history.length === 0) {
      return null
    }

    const newIndex = this.historyIndex + 1
    if (newIndex >= history.length) {
      return null
    }

    this.historyIndex = newIndex
    return history[newIndex].input
  }

  async down(project?: string): Promise<string | null> {
    if (this.historyIndex <= 0) {
      this.historyIndex = -1
      return this.draft
    }

    this.historyIndex--

    if (this.cache.length > 0 && this.historyIndex < this.cache.length) {
      return this.cache[this.historyIndex].input
    }

    return null
  }

  reset(): void {
    this.historyIndex = -1
    this.draft = ''
  }

  async cleanup(): Promise<void> {
    if (!existsSync(this.historyPath)) {
      return
    }

    const content = await readFile(this.historyPath, 'utf-8')
    const lines = content.split('\n').filter(line => line.trim())

    if (lines.length > MAX_HISTORY_ITEMS) {
      const keep = lines.slice(-MAX_HISTORY_ITEMS)
      await writeFile(this.historyPath, keep.join('\n') + '\n', 'utf-8')
    }
  }
}
