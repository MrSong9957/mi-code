import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { HistoryManager } from '../history.js'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

describe('HistoryManager', () => {
  const testHistoryPath = join(homedir(), '.micode', 'history.jsonl.test')
  let manager: HistoryManager

  beforeEach(() => {
    if (existsSync(testHistoryPath)) {
      rmSync(testHistoryPath)
    }
    manager = new HistoryManager(testHistoryPath)
  })

  afterEach(() => {
    if (existsSync(testHistoryPath)) {
      rmSync(testHistoryPath)
    }
  })

  it('should create HistoryManager instance', () => {
    expect(manager).toBeDefined()
    expect(manager).toBeInstanceOf(HistoryManager)
  })
})
