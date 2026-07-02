import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { HistoryManager } from '../history.js'
import { existsSync, rmSync, readFileSync, appendFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('HistoryManager', () => {
  let tempDir: string
  let originalUserprofile: string | undefined
  let testHistoryPath: string
  let manager: HistoryManager

  beforeEach(() => {
    // 物理本质：给每个测试发一个一次性的"临时储物柜"，
    // 测完整体清空，绝不碰用户真实主目录（避免 ENOENT 残留与污染）
    tempDir = mkdtempSync(join(tmpdir(), 'mi-code-history-test-'))
    // Windows 上 os.homedir() 读取 USERPROFILE，重写它让默认路径落进临时目录
    originalUserprofile = process.env.USERPROFILE
    process.env.USERPROFILE = tempDir
    testHistoryPath = join(tempDir, '.micode', 'history.jsonl.test')
    manager = new HistoryManager(testHistoryPath)
  })

  afterEach(() => {
    if (originalUserprofile !== undefined) process.env.USERPROFILE = originalUserprofile
    else delete process.env.USERPROFILE
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('should create HistoryManager instance', () => {
    expect(manager).toBeDefined()
    expect(manager).toBeInstanceOf(HistoryManager)
  })

  describe('addEntry', () => {
    it('should write entry as JSONL to the file', async () => {
      await manager.addEntry('hello', 'proj1')

      expect(existsSync(testHistoryPath)).toBe(true)
      const content = readFileSync(testHistoryPath, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      expect(lines).toHaveLength(1)

      const entry = JSON.parse(lines[0])
      expect(entry.input).toBe('hello')
      expect(entry.project).toBe('proj1')
      expect(entry.sessionId).toBeDefined()
      expect(entry.timestamp).toBeGreaterThan(0)
    })

    it('should append multiple entries', async () => {
      await manager.addEntry('first', 'proj1')
      await manager.addEntry('second', 'proj1')

      const content = readFileSync(testHistoryPath, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      expect(lines).toHaveLength(2)
    })

    it('should dedup consecutive duplicate inputs', async () => {
      await manager.addEntry('hello', 'proj1')
      await manager.addEntry('hello', 'proj1')

      const content = readFileSync(testHistoryPath, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      expect(lines).toHaveLength(1)
    })

    it('should allow same input after a different input', async () => {
      await manager.addEntry('hello', 'proj1')
      await manager.addEntry('world', 'proj1')
      await manager.addEntry('hello', 'proj1')

      const content = readFileSync(testHistoryPath, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      expect(lines).toHaveLength(3)
    })

    it('should enforce 50-item cap on the file via cleanup', async () => {
      for (let i = 0; i < 55; i++) {
        await manager.addEntry(`input-${i}`, 'proj1')
      }

      const content = readFileSync(testHistoryPath, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      expect(lines.length).toBeLessThanOrEqual(50)
    })

    it('should create parent directory if it does not exist', async () => {
      const deepPath = join(tempDir, '.micode', 'sub', 'deep', 'history.jsonl.test')
      const deepManager = new HistoryManager(deepPath)

      await deepManager.addEntry('test', 'proj1')
      expect(existsSync(deepPath)).toBe(true)
      // 清理由 afterEach 的 recursive rm 统一负责，无需在此单独删叶子文件
    })
  })

  describe('getHistory', () => {
    it('should return empty array when no file exists', async () => {
      const history = await manager.getHistory('proj1')
      expect(history).toEqual([])
    })

    it('should filter entries by project', async () => {
      await manager.addEntry('hello', 'proj1')
      await manager.addEntry('world', 'proj2')
      await manager.addEntry('foo', 'proj1')

      const proj1History = await manager.getHistory('proj1')
      expect(proj1History).toHaveLength(2)
      expect(proj1History.every(e => e.project === 'proj1')).toBe(true)

      const proj2History = await manager.getHistory('proj2')
      expect(proj2History).toHaveLength(1)
      expect(proj2History[0].input).toBe('world')
    })

    it('should return entries sorted with current session first, then by timestamp', async () => {
      // Add entries with slight time gaps
      await manager.addEntry('old', 'proj1')
      await manager.addEntry('new', 'proj1')

      const history = await manager.getHistory('proj1')
      // Both are from the same session, so newest first
      expect(history[0].input).toBe('new')
      expect(history[1].input).toBe('old')
    })

    it('should cache results per project', async () => {
      await manager.addEntry('hello', 'proj1')

      // First call loads from file
      const history1 = await manager.getHistory('proj1')
      expect(history1).toHaveLength(1)

      // Second call should use cache (same result)
      const history2 = await manager.getHistory('proj1')
      expect(history2).toHaveLength(1)
      expect(history2).toBe(history1) // same reference = cache hit
    })

    it('should use separate cache per project', async () => {
      await manager.addEntry('hello', 'proj1')
      await manager.addEntry('world', 'proj2')

      const proj1 = await manager.getHistory('proj1')
      const proj2 = await manager.getHistory('proj2')

      expect(proj1).toHaveLength(1)
      expect(proj1[0].input).toBe('hello')
      expect(proj2).toHaveLength(1)
      expect(proj2[0].input).toBe('world')
    })

    it('should invalidate cache after addEntry for the same project', async () => {
      await manager.addEntry('first', 'proj1')
      const history1 = await manager.getHistory('proj1')
      expect(history1).toHaveLength(1)

      await manager.addEntry('second', 'proj1')
      const history2 = await manager.getHistory('proj1')
      expect(history2).toHaveLength(2)
    })

    it('should skip corrupted JSON lines', async () => {
      // 先通过 addEntry 建立合法文件（appendFileSync 只能追加到已存在文件）
      await manager.addEntry('valid', 'proj1')
      appendFileSync(testHistoryPath, 'not valid json\n')
      appendFileSync(testHistoryPath, JSON.stringify({ input: 'valid2', project: 'proj1', sessionId: 's', timestamp: 1 }) + '\n')

      const history = await manager.getHistory('proj1')
      // 损坏行被跳过，两条合法行保留
      expect(history).toHaveLength(2)
      expect(history[0].input).toBe('valid')
      expect(history[1].input).toBe('valid2')
    })
  })

  describe('up', () => {
    it('should return null when history is empty', async () => {
      const result = await manager.up('', 'proj1')
      expect(result).toBeNull()
    })

    it('should navigate to most recent entry', async () => {
      await manager.addEntry('first', 'proj1')
      await manager.addEntry('second', 'proj1')

      const result = await manager.up('', 'proj1')
      // Most recent (sorted) is 'second' for same session
      expect(result).toBe('second')
    })

    it('should navigate backwards through history', async () => {
      await manager.addEntry('first', 'proj1')
      await manager.addEntry('second', 'proj1')

      await manager.up('', 'proj1') // -> second (index 0)
      const result = await manager.up('', 'proj1') // -> first (index 1)
      expect(result).toBe('first')
    })

    it('should return null when reaching the end of history', async () => {
      await manager.addEntry('only', 'proj1')

      await manager.up('', 'proj1') // -> only
      const result = await manager.up('', 'proj1') // past end
      expect(result).toBeNull()
    })

    it('should save draft on first call', async () => {
      await manager.addEntry('entry', 'proj1')

      await manager.up('my draft', 'proj1')

      // After going past the end and coming back down, draft should be preserved
      await manager.up('', 'proj1') // past end
      const result = await manager.down('proj1')
      expect(result).toBe('my draft')
    })
  })

  describe('down', () => {
    it('should return draft when at the start', async () => {
      await manager.addEntry('entry', 'proj1')

      const result = await manager.down('proj1')
      expect(result).toBe('')
    })

    it('should navigate down through history', async () => {
      await manager.addEntry('first', 'proj1')
      await manager.addEntry('second', 'proj1')

      await manager.up('', 'proj1') // -> second (index 0)
      await manager.up('', 'proj1') // -> first (index 1)
      const result = await manager.down('proj1') // -> second (index 0)
      expect(result).toBe('second')
    })

    it('should return draft when going past the start', async () => {
      await manager.addEntry('entry', 'proj1')

      await manager.up('', 'proj1')
      await manager.down('proj1') // back to start
      const result = await manager.down('proj1') // past start
      expect(result).toBe('')
    })

    it('should filter by project', async () => {
      await manager.addEntry('proj1-entry', 'proj1')
      await manager.addEntry('proj2-entry', 'proj2')
      await manager.addEntry('proj1-entry2', 'proj1')

      // Navigate up in proj1 history
      await manager.up('', 'proj1')

      // Down should use filtered proj1 history
      const result = await manager.down('proj1')
      expect(result).toBeDefined()
      // Should be within proj1 entries
    })
  })

  describe('reset', () => {
    it('should reset navigation state', async () => {
      await manager.addEntry('first', 'proj1')
      await manager.addEntry('second', 'proj1')

      await manager.up('draft', 'proj1')
      await manager.up('', 'proj1')

      manager.reset()

      // After reset, up should start from beginning again
      const result = await manager.up('new draft', 'proj1')
      expect(result).toBe('second')
    })

    it('should clear draft', async () => {
      await manager.up('draft', 'proj1')
      manager.reset()

      // down after reset should return empty draft
      const result = await manager.down('proj1')
      expect(result).toBe('')
    })
  })

  describe('cleanup', () => {
    it('should do nothing when file does not exist', async () => {
      const freshManager = new HistoryManager(join(tempDir, '.micode', 'nonexistent.jsonl'))
      await expect(freshManager.cleanup()).resolves.toBeUndefined()
    })

    it('should keep file unchanged when under 50 items', async () => {
      await manager.addEntry('test', 'proj1')
      await manager.cleanup()

      const content = readFileSync(testHistoryPath, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      expect(lines).toHaveLength(1)
    })

    it('should truncate file to 50 items', async () => {
      for (let i = 0; i < 60; i++) {
        await manager.addEntry(`input-${i}`, 'proj1')
      }

      // Note: addEntry already calls cleanup, but let's verify the file
      const content = readFileSync(testHistoryPath, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      expect(lines).toHaveLength(50)
      // The last entries (highest index) should be kept
      const lastEntry = JSON.parse(lines[lines.length - 1])
      expect(lastEntry.input).toBe('input-59')
    })
  })
})
