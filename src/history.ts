import { readFile, writeFile, appendFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

export interface HistoryEntry {
  input: string
  project: string
  sessionId: string
  timestamp: number
  /** 单调递增序号，作为 timestamp 相同时的稳定排序 tiebreaker（后加入的排前面）。 */
  seq?: number
}

const MAX_HISTORY_ITEMS = 50

export class HistoryManager {
  private historyPath: string
  private sessionId: string
  /** Project-keyed cache: maps project name to filtered entries. */
  private cacheByProject: Map<string, HistoryEntry[]> = new Map()
  private historyIndex: number = -1
  private draft: string = ''
  /** Per-session dedup key: only prevents consecutive duplicate inputs within the same HistoryManager instance. */
  private lastInput: string = ''
  /** Approximate line count in the history file, used to skip cleanup I/O when under the cap. */
  private lineCount: number = 0
  /** 单调递增序号：同毫秒内区分先后（timestamp tiebreaker，防 flaky 排序）。 */
  private seqCounter: number = 0

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
      timestamp: Date.now(),
      seq: ++this.seqCounter
    }

    const dir = dirname(this.historyPath)
    await mkdir(dir, { recursive: true })

    await appendFile(this.historyPath, JSON.stringify(entry) + '\n', 'utf-8')

    // Invalidate cache for this project so the next getHistory reads fresh data.
    this.cacheByProject.delete(project)

    // Enforce 50-item cap on the file only when over the limit.
    this.lineCount++
    if (this.lineCount > MAX_HISTORY_ITEMS) {
      await this.cleanup()
    }
  }

  async getHistory(project: string): Promise<HistoryEntry[]> {
    const cached = this.cacheByProject.get(project)
    if (cached !== undefined) {
      return cached
    }

    let content: string
    try {
      content = await readFile(this.historyPath, 'utf-8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const empty: HistoryEntry[] = []
        this.cacheByProject.set(project, empty)
        return empty
      }
      throw err
    }
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
      // timestamp 降序；同毫秒时用 seq 降序（后加入的排前面），保证排序稳定。
      // 高负载下 Date.now() 精度不足，连续 addEntry 可能同毫秒，无 tiebreaker 会 flaky。
      const tsDiff = b.timestamp - a.timestamp
      if (tsDiff !== 0) return tsDiff
      return (b.seq ?? 0) - (a.seq ?? 0)
    })

    const result = entries.slice(0, MAX_HISTORY_ITEMS)
    this.cacheByProject.set(project, result)
    return result
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

    const history = project ? await this.getHistory(project) : []
    if (history.length > 0 && this.historyIndex < history.length) {
      return history[this.historyIndex].input
    }

    return null
  }

  reset(): void {
    this.historyIndex = -1
    this.draft = ''
  }

  async cleanup(): Promise<void> {
    let content: string
    try {
      content = await readFile(this.historyPath, 'utf-8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw err
    }

    const lines = content.split('\n').filter(line => line.trim())

    if (lines.length > MAX_HISTORY_ITEMS) {
      const keep = lines.slice(-MAX_HISTORY_ITEMS)
      await writeFile(this.historyPath, keep.join('\n') + '\n', 'utf-8')
      this.lineCount = keep.length
    } else {
      this.lineCount = lines.length
    }
  }
}
