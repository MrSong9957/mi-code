// Dispatch Map 模式：显式分离工具定义和处理器
//
// 物理本质：餐厅点餐系统。
// TOOLS = 菜单（告诉客人有什么菜，每道菜需要什么配料）
// TOOL_HANDLERS = 厨师团队（每位厨师只会做特定的菜）
// ToolRegistry = 服务员（接收订单，分配给正确的厨师）
//
// 新增菜式 = 在菜单上加一行 + 招聘一位新厨师，服务员流程完全不变。

import type { ToolDefinition, ToolExecutor } from './types.js';

/**
 * 最大输出大小：50KB
 *
 * 物理本质：餐厅规定每道菜最多只能装 50KB 的盘子。
 * 如果菜太多，就截断一部分，避免客人吃不完（超出 LLM 上下文窗口）。
 */
const MAX_OUTPUT_SIZE = 50 * 1024;

/**
 * 截断超长输出
 *
 * 物理本质：把多余的菜切掉，只保留前 50KB，然后标注"还有更多"。
 */
function truncateOutput(output: string): string {
  if (output.length > MAX_OUTPUT_SIZE) {
    return output.substring(0, MAX_OUTPUT_SIZE) + '\n... (truncated)';
  }
  return output;
}

/**
 * 工具定义数组（JSON Schema 描述）
 *
 * 每个工具只需声明：
 * - name: 工具名（唯一标识）
 * - description: 告诉 LLM 这个工具能做什么
 * - parameters: JSON Schema 格式的参数定义
 *
 * 新增工具：在此数组末尾添加一个对象即可。
 */
export const TOOLS: ToolDefinition[] = [
  {
    name: 'run_bash',
    description: 'Execute a shell command and return its output',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file or directory from the local filesystem. If path is a directory, returns its entries (directories end with /). Returns first N lines if limit specified.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to workspace',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to read (optional)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to file. Creates parent directories if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to workspace',
        },
        content: {
          type: 'string',
          description: 'Content to write',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace text in file. Finds old_text and replaces with new_text.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to workspace',
        },
        old_text: {
          type: 'string',
          description: 'Text to find and replace',
        },
        new_text: {
          type: 'string',
          description: 'Replacement text',
        },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match files',
        },
        path: {
          type: 'string',
          description: 'Directory to search in (optional, defaults to workspace root)',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search for text patterns in files',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern to search for',
        },
        path: {
          type: 'string',
          description: 'File or directory to search in (optional)',
        },
        include: {
          type: 'string',
          description: 'File pattern to include (e.g., "*.ts")',
        },
      },
      required: ['pattern'],
    },
  },
  // ═══════════════════════════════════════════════════════════════
  // 新增工具示例（取消注释即可添加）：
  // ═══════════════════════════════════════════════════════════════
  // {
  //   name: 'my_new_tool',
  //   description: 'Description for LLM',
  //   parameters: {
  //     type: 'object',
  //     properties: {
  //       param1: { type: 'string', description: 'Parameter description' },
  //     },
  //     required: ['param1'],
  //   },
  // },
];

/**
 * 工具处理器字典（映射表）
 *
 * 每个处理器是一个异步函数，接收 input 对象，返回字符串结果。
 * 新增处理器：在此对象中添加一个键值对即可。
 *
 * 物理本质：厨师花名册。
 * key = 厨师姓名（必须和菜单上的菜名一致）
 * value = 厨师的做菜手艺（函数）
 */
export const TOOL_HANDLERS: Record<string, ToolExecutor> = {
  run_bash: async (input) => {
    const { spawnSync } = await import('child_process');
    const { Encoder } = await import('../output/encoder.js');

    // 防御性检查：验证输入参数
    if (!input || typeof input !== 'object') {
      return 'Error: input must be an object';
    }
    if (typeof input.command !== 'string' || input.command.trim() === '') {
      return 'Error: command is required and must be a non-empty string';
    }

    const command = input.command as string;
    const result = spawnSync(command, {
      shell: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (result.error) {
      const err = result.error as NodeJS.ErrnoException;
      if (err.code === 'ETIMEDOUT') {
        return 'Command timed out after 30 seconds';
      }
      return `Command failed: ${err.message}`;
    }

    if (result.stderr && result.stderr.length > 0) {
      const stderr = typeof result.stderr === 'string' ? result.stderr : Encoder.decodeBuffer(result.stderr);
      if (result.status !== 0) {
        return stderr;
      }
      const stdout = result.stdout ? (typeof result.stdout === 'string' ? result.stdout : Encoder.decodeBuffer(result.stdout)) : '';
      return stdout ? `${stdout}\n${stderr}` : stderr;
    }

    if (result.stdout) {
      return typeof result.stdout === 'string' ? result.stdout : Encoder.decodeBuffer(result.stdout);
    }

    return '';
  },

  read_file: async (input) => {
    const { readFileSync, readdirSync, statSync } = await import('fs');
    const { join } = await import('path');
    const { safePath } = await import('./tools/path-sandbox.js');

    // 防御性检查：验证输入参数
    if (!input || typeof input !== 'object') {
      return 'Error: input must be an object';
    }
    if (typeof input.path !== 'string' || input.path.trim() === '') {
      return 'Error: path is required and must be a non-empty string';
    }

    const filePath = safePath(input.path as string);
    const limit = input.limit as number | undefined;
    const MAX_READ_SIZE = 50 * 1024;

    if (statSync(filePath).isDirectory()) {
      const entries = readdirSync(filePath).map((name) => {
        const isDir = statSync(join(filePath, name)).isDirectory();
        return isDir ? `${name}/` : name;
      });
      const sorted = entries.sort((a, b) => {
        const aDir = a.endsWith('/');
        const bDir = b.endsWith('/');
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.localeCompare(b);
      });
      return sorted.join('\n');
    }

    let content = readFileSync(filePath, 'utf8');

    if (content.length > MAX_READ_SIZE) {
      content = content.substring(0, MAX_READ_SIZE) + '\n... (truncated)';
    }

    if (limit) {
      const lines = content.split('\n');
      if (limit < lines.length) {
        return lines.slice(0, limit).join('\n');
      }
    }

    return content;
  },

  write_file: async (input) => {
    const { writeFileSync, mkdirSync } = await import('fs');
    const { dirname } = await import('path');
    const { safePath } = await import('./tools/path-sandbox.js');

    // 防御性检查：验证输入参数
    if (!input || typeof input !== 'object') {
      return 'Error: input must be an object';
    }
    if (typeof input.path !== 'string' || input.path.trim() === '') {
      return 'Error: path is required and must be a non-empty string';
    }
    if (typeof input.content !== 'string') {
      return 'Error: content is required and must be a string';
    }

    const filePath = safePath(input.path as string);
    const content = input.content as string;

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
    return `File written: ${input.path}`;
  },

  edit_file: async (input) => {
    const { readFileSync, writeFileSync } = await import('fs');
    const { safePath } = await import('./tools/path-sandbox.js');

    // 防御性检查：验证输入参数
    if (!input || typeof input !== 'object') {
      return 'Error: input must be an object';
    }
    if (typeof input.path !== 'string' || input.path.trim() === '') {
      return 'Error: path is required and must be a non-empty string';
    }
    if (typeof input.old_text !== 'string') {
      return 'Error: old_text is required and must be a string';
    }
    if (typeof input.new_text !== 'string') {
      return 'Error: new_text is required and must be a string';
    }

    const filePath = safePath(input.path as string);
    const oldText = input.old_text as string;
    const newText = input.new_text as string;

    let content = readFileSync(filePath, 'utf8');

    if (!content.includes(oldText)) {
      return `Error: old_text not found in ${input.path}`;
    }

    content = content.replace(oldText, newText);
    writeFileSync(filePath, content, 'utf8');
    return `File edited: ${input.path}`;
  },

  glob: async (input) => {
    const { createGlobTool } = await import('./tools/search-tools.js');
    const tool = createGlobTool();
    // 防御性检查：验证输入参数
    if (!input || typeof input !== 'object') {
      return 'Error: input must be an object';
    }
    if (typeof input.pattern !== 'string' || input.pattern.trim() === '') {
      return 'Error: pattern is required and must be a non-empty string';
    }
    const result = await tool.executor(input);
    // 截断超长输出
    return truncateOutput(result);
  },

  grep: async (input) => {
    const { createGrepTool } = await import('./tools/search-tools.js');
    const tool = createGrepTool();
    // 防御性检查：验证输入参数
    if (!input || typeof input !== 'object') {
      return 'Error: input must be an object';
    }
    if (typeof input.pattern !== 'string' || input.pattern.trim() === '') {
      return 'Error: pattern is required and must be a non-empty string';
    }
    const result = await tool.executor(input);
    // 截断超长输出
    return truncateOutput(result);
  },

  // ═══════════════════════════════════════════════════════════════
  // 新增处理器示例（取消注释即可添加）：
  // ═══════════════════════════════════════════════════════════════
  // my_new_tool: async (input) => {
  //   const data = input.param1 as string;
  //   return `Processed: ${data}`;
  // },
};

/**
 * 验证 Dispatch Map 一致性
 *
 * 检查 TOOLS 数组和 TOOL_HANDLERS 字典是否匹配。
 * 返回不一致的工具名列表。
 *
 * 物理本质：核对菜单和厨师名单是否一致。
 * 菜单上有但没厨师 → 有菜没人做
 * 有厨师但菜单上没 → 有人但没菜可做
 */
export function validateDispatchMap(): { missingHandlers: string[]; missingDefinitions: string[] } {
  const toolNames = new Set(TOOLS.map(t => t.name));
  const handlerNames = new Set(Object.keys(TOOL_HANDLERS));

  const missingHandlers = TOOLS.filter(t => !handlerNames.has(t.name)).map(t => t.name);
  const missingDefinitions = Object.keys(TOOL_HANDLERS).filter(h => !toolNames.has(h));

  return { missingHandlers, missingDefinitions };
}

/**
 * 从 Dispatch Map 创建工具注册表
 *
 * 物理本质：服务员拿到菜单和厨师名单，开始营业。
 * 自动验证一致性，确保每道菜都有厨师，每位厨师都有菜可做。
 */
export async function createRegistryFromDispatchMap(): Promise<{
  registry: import('./tool-registry.js').ToolRegistry;
  validation: { missingHandlers: string[]; missingDefinitions: string[] };
}> {
  const { ToolRegistry } = await import('./tool-registry.js');
  const registry = new ToolRegistry();

  // 验证一致性
  const validation = validateDispatchMap();

  // 注册所有工具
  for (const tool of TOOLS) {
    const handler = TOOL_HANDLERS[tool.name];
    if (handler) {
      registry.register(tool, handler);
    }
  }

  return { registry, validation };
}