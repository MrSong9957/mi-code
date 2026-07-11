// Dispatch Map 模式测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setWorkdir } from '../agent/tools/path-sandbox.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import { TOOLS, TOOL_HANDLERS, validateDispatchMap, createRegistryFromDispatchMap } from '../agent/dispatch-map.js';
import type { ToolDefinition, ToolExecutor } from '../agent/types.js';

describe('Dispatch Map Pattern', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mi-code-dispatch-test-'));
    setWorkdir(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('TOOLS Array', () => {
    it('should contain all core tool definitions', () => {
      const toolNames = TOOLS.map(t => t.name);

      expect(toolNames).toContain('run_bash');
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('write_file');
      expect(toolNames).toContain('edit_file');
      expect(toolNames).toContain('glob');
      expect(toolNames).toContain('grep');
    });

    it('should have valid JSON Schema for each tool', () => {
      for (const tool of TOOLS) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.parameters).toBeDefined();
        expect(tool.parameters.type).toBe('object');
        expect(tool.parameters.properties).toBeDefined();
      }
    });

    it('should have unique tool names', () => {
      const names = TOOLS.map(t => t.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });

  describe('TOOL_HANDLERS Dictionary', () => {
    it('should have handler for each tool in TOOLS', () => {
      for (const tool of TOOLS) {
        expect(TOOL_HANDLERS[tool.name]).toBeDefined();
        expect(typeof TOOL_HANDLERS[tool.name]).toBe('function');
      }
    });

    it('should not have extra handlers not in TOOLS', () => {
      const toolNames = new Set(TOOLS.map(t => t.name));
      for (const handlerName of Object.keys(TOOL_HANDLERS)) {
        expect(toolNames.has(handlerName)).toBe(true);
      }
    });
  });

  describe('validateDispatchMap', () => {
    it('should return no mismatches for valid dispatch map', () => {
      const result = validateDispatchMap();
      expect(result.missingHandlers).toEqual([]);
      expect(result.missingDefinitions).toEqual([]);
    });
  });

  describe('createRegistryFromDispatchMap', () => {
    it('should create registry with all tools', async () => {
      const { registry, validation } = await createRegistryFromDispatchMap();

      expect(validation.missingHandlers).toEqual([]);
      expect(validation.missingDefinitions).toEqual([]);
      expect(registry.size).toBe(TOOLS.length);
    });

    it('should execute read_file tool', async () => {
      const { registry } = await createRegistryFromDispatchMap();
      const testFile = join(tempDir, 'test.txt');
      writeFileSync(testFile, 'Hello, World!', 'utf8');

      const result = await registry.execute('read_file', { path: 'test.txt' });
      expect(result).toBe('Hello, World!');
    });

    it('should execute write_file tool', async () => {
      const { registry } = await createRegistryFromDispatchMap();

      const testContent = 'Test content for write_file validation';
      const testPath = 'output.txt';

      const result = await registry.execute('write_file', {
        path: testPath,
        content: testContent,
      });

      // 验证返回消息
      expect(result).toContain('File written');
      expect(result).toContain(testPath);

      // ⭐ 关键验证：检查文件是否真的被写入了！
      const writtenContent = readFileSync(join(tempDir, testPath), 'utf8');
      expect(writtenContent).toBe(testContent);
    });

    it('should return error for unknown tool', async () => {
      const { registry } = await createRegistryFromDispatchMap();
      const result = await registry.execute('unknown_tool', {});
      expect(result).toContain('Error: Unknown tool');
    });
  });

  describe('Boundary Values', () => {
    it('should handle null input gracefully', async () => {
      const { registry } = await createRegistryFromDispatchMap();
      const result = await registry.execute('read_file', null as any);
      // 验证返回错误消息，而不是崩溃
      expect(result).toContain('Error');
    });

    it('should handle undefined input gracefully', async () => {
      const { registry } = await createRegistryFromDispatchMap();
      const result = await registry.execute('read_file', undefined as any);
      expect(result).toContain('Error');
    });

    it('should handle missing required parameters', async () => {
      const { registry } = await createRegistryFromDispatchMap();
      const result = await registry.execute('read_file', {});
      // 验证返回错误消息，而不是崩溃或返回空内容
      expect(result).toContain('Error');
      // 验证错误消息提到缺失的参数
      expect(result.toLowerCase()).toContain('path');
    });

    it('should handle wrong parameter types', async () => {
      const { registry } = await createRegistryFromDispatchMap();
      const result = await registry.execute('read_file', { path: 123 });
      // 验证返回错误消息，而不是崩溃或返回意外结果
      expect(result).toContain('Error');
    });

    it('should handle null required parameters', async () => {
      const { registry } = await createRegistryFromDispatchMap();
      const result = await registry.execute('write_file', { path: null, content: null });
      expect(result).toContain('Error');
    });

    it('should handle empty string parameters', async () => {
      const { registry } = await createRegistryFromDispatchMap();
      const result = await registry.execute('read_file', { path: '' });
      // 空字符串应该被视为无效路径
      expect(result).toContain('Error');
    });
  });

  describe('Output Truncation', () => {
    it('should truncate large output from read_file', async () => {
      const { registry } = await createRegistryFromDispatchMap();

      // 创建一个超过 50KB 的文件
      const largeContent = 'x'.repeat(60 * 1024); // 60KB
      writeFileSync(join(tempDir, 'large.txt'), largeContent, 'utf8');

      const result = await registry.execute('read_file', { path: 'large.txt' });

      // 验证返回内容被截断
      expect(result.length).toBeLessThanOrEqual(50 * 1024 + 20); // 50KB + "... (truncated)" 长度
      expect(result).toContain('... (truncated)');
    });
  });

  describe('Regression Tests', () => {
    it('should still execute read_file correctly after adding defensive checks', async () => {
      const { registry } = await createRegistryFromDispatchMap();
      const testFile = join(tempDir, 'regression-test.txt');
      const testContent = 'Regression test content';
      writeFileSync(testFile, testContent, 'utf8');

      const result = await registry.execute('read_file', { path: 'regression-test.txt' });
      expect(result).toBe(testContent);
    });

    it('should still execute write_file correctly after adding defensive checks', async () => {
      const { registry } = await createRegistryFromDispatchMap();
      const testContent = 'Regression test content for write';
      const testPath = 'regression-output.txt';

      const result = await registry.execute('write_file', {
        path: testPath,
        content: testContent,
      });

      // 验证返回消息格式没有变化
      expect(result).toContain('File written');
      expect(result).toContain(testPath);

      // 验证文件内容没有变化
      const writtenContent = readFileSync(join(tempDir, testPath), 'utf8');
      expect(writtenContent).toBe(testContent);
    });

    it('should still execute edit_file correctly after adding defensive checks', async () => {
      const { registry } = await createRegistryFromDispatchMap();
      const testFile = join(tempDir, 'regression-edit.txt');
      writeFileSync(testFile, 'Hello, World!', 'utf8');

      const result = await registry.execute('edit_file', {
        path: 'regression-edit.txt',
        old_text: 'World',
        new_text: 'TypeScript',
      });

      // 验证返回消息格式没有变化
      expect(result).toContain('File edited');
      expect(result).toContain('regression-edit.txt');

      // 验证文件内容被正确修改
      const editedContent = readFileSync(testFile, 'utf8');
      expect(editedContent).toBe('Hello, TypeScript!');
    });

    it('should still return error for unknown tool', async () => {
      const { registry } = await createRegistryFromDispatchMap();
      const result = await registry.execute('unknown_tool', {});
      expect(result).toContain('Error: Unknown tool');
    });

    it('should still handle old_text not found in edit_file', async () => {
      const { registry } = await createRegistryFromDispatchMap();
      const testFile = join(tempDir, 'regression-edit-not-found.txt');
      writeFileSync(testFile, 'Hello, World!', 'utf8');

      const result = await registry.execute('edit_file', {
        path: 'regression-edit-not-found.txt',
        old_text: 'NotFound',
        new_text: 'Replacement',
      });

      // 验证错误消息格式没有变化
      expect(result).toContain('Error: old_text not found');
    });
  });

  describe('Concurrency', () => {
    it('should handle concurrent reads safely', async () => {
      const { registry } = await createRegistryFromDispatchMap();

      // 创建测试文件
      writeFileSync(join(tempDir, 'file1.txt'), 'Content 1', 'utf8');
      writeFileSync(join(tempDir, 'file2.txt'), 'Content 2', 'utf8');
      writeFileSync(join(tempDir, 'file3.txt'), 'Content 3', 'utf8');

      // 并发读取
      const results = await Promise.all([
        registry.execute('read_file', { path: 'file1.txt' }),
        registry.execute('read_file', { path: 'file2.txt' }),
        registry.execute('read_file', { path: 'file3.txt' }),
      ]);

      expect(results[0]).toBe('Content 1');
      expect(results[1]).toBe('Content 2');
      expect(results[2]).toBe('Content 3');
    });

    it('should handle concurrent writes safely', async () => {
      const { registry } = await createRegistryFromDispatchMap();

      // 并发写入不同文件
      await Promise.all([
        registry.execute('write_file', { path: 'out1.txt', content: 'A' }),
        registry.execute('write_file', { path: 'out2.txt', content: 'B' }),
        registry.execute('write_file', { path: 'out3.txt', content: 'C' }),
      ]);

      // 验证每个文件都被正确写入
      expect(readFileSync(join(tempDir, 'out1.txt'), 'utf8')).toBe('A');
      expect(readFileSync(join(tempDir, 'out2.txt'), 'utf8')).toBe('B');
      expect(readFileSync(join(tempDir, 'out3.txt'), 'utf8')).toBe('C');
    });
  });

  describe('Dispatch Map Decoupling', () => {
    it('should allow adding new tools without modifying core loop', async () => {
      const { registry } = await createRegistryFromDispatchMap();
      const initialSize = registry.size;

      // 新增工具只需：
      // 1. 在 TOOLS 数组添加定义
      // 2. 在 TOOL_HANDLERS 字典添加处理器
      // 核心循环完全不用动！
      const newTool: ToolDefinition = {
        name: 'custom_tool',
        description: 'Custom tool for testing',
        parameters: {
          type: 'object',
          properties: {
            data: { type: 'string' },
          },
          required: ['data'],
        },
      };
      const customExecutor: ToolExecutor = async (input) => `Custom: ${input.data}`;

      registry.register(newTool, customExecutor);

      expect(registry.size).toBe(initialSize + 1);
      expect(registry.getDefinitions().map(d => d.name)).toContain('custom_tool');
    });

    it('should maintain tool isolation', async () => {
      const { registry } = await createRegistryFromDispatchMap();

      // 注册两个独立的工具
      const tool1: ToolDefinition = {
        name: 'tool_a',
        description: 'Tool A',
        parameters: { type: 'object', properties: {} },
      };
      const tool2: ToolDefinition = {
        name: 'tool_b',
        description: 'Tool B',
        parameters: { type: 'object', properties: {} },
      };

      const results: string[] = [];
      const executor1: ToolExecutor = async () => {
        results.push('A executed');
        return 'A';
      };
      const executor2: ToolExecutor = async () => {
        results.push('B executed');
        return 'B';
      };

      registry.register(tool1, executor1);
      registry.register(tool2, executor2);

      await registry.execute('tool_a', {});
      await registry.execute('tool_b', {});

      expect(results).toEqual(['A executed', 'B executed']);
    });
  });
});