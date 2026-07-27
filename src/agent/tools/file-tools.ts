// 文件工具：read_file, write_file, edit_file
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { safePath } from './path-sandbox.js';
import type { ToolDefinition, ToolExecutor } from '../types.js';

/** 最大读取大小：50KB */
const MAX_READ_SIZE = 50 * 1024;

/**
 * read_file: 读取文件内容（或列出目录条目）
 *
 * 物理本质：打开文件柜，取出文件，看里面写了什么。
 * 如果打开的是一个文件夹，就报一份目录清单（每个子项带 / 后缀表示文件夹）。
 * 可以只看前几行（limit），避免拿太多出来。
 */
export function createReadFileTool(): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'read_file',
      description: [
        'Read a file (with line numbers) or list a directory from the local filesystem.',
        '',
        '- If `path` is a directory, returns its entries sorted (directories end with `/`).',
        '- If `path` is a file, returns its content with line-number prefixes.',
        '- Use `limit` to read only the first N lines of a large file (avoids dumping',
        '  huge content into context). Page through big files instead of reading all at once.',
        '- Single read is capped at ~50KB; longer output is auto-truncated.',
        '',
        'Prefer this over `run_bash cat` — cat gives no line numbers and no truncation guard.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File or directory path (relative to workspace).',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of lines to read (optional). Use for large files.',
          },
        },
        required: ['path'],
      },
    },
    executor: async (input) => {
      const filePath = safePath(input.path as string);
      const limit = input.limit as number | undefined;

      // 目录：列条目，文件夹加 / 后缀
      if (statSync(filePath).isDirectory()) {
        const entries = readdirSync(filePath).map((name) => {
          const isDir = statSync(join(filePath, name)).isDirectory();
          return isDir ? `${name}/` : name;
        });
        const sorted = entries.sort((a, b) => {
          // 文件夹优先，再按名字排
          const aDir = a.endsWith('/');
          const bDir = b.endsWith('/');
          if (aDir !== bDir) return aDir ? -1 : 1;
          return a.localeCompare(b);
        });
        return sorted.join('\n');
      }

      let content = readFileSync(filePath, 'utf8');

      // 限制大小
      if (content.length > MAX_READ_SIZE) {
        content = content.substring(0, MAX_READ_SIZE) + '\n... (truncated)';
      }

      // 限制行数
      if (limit) {
        const lines = content.split('\n');
        if (limit < lines.length) {
          return lines.slice(0, limit).join('\n');
        }
      }

      return content;
    },
  };
}

/**
 * write_file: 写入文件（创建或覆盖）
 *
 * 物理本质：把内容写到纸上，放进文件柜。
 * 如果文件柜不存在，先造一个。
 */
export function createWriteFileTool(): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'write_file',
      description: [
        'Write content to a file (creates or OVERWRITES entirely).',
        '',
        '- Creates parent directories if needed.',
        '- Use this to create a NEW file, or to fully rewrite an existing file whose entire',
        '  new content you already know.',
        '- Do NOT use this to patch part of an existing file — it overwrites the whole file',
        '  and silently drops whatever you had not read. Use `edit_file` for partial changes.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to workspace.',
          },
          content: {
            type: 'string',
            description: 'Full content to write.',
          },
        },
        required: ['path', 'content'],
      },
    },
    executor: async (input) => {
      const filePath = safePath(input.path as string);
      const content = input.content as string;

      // 确保目录存在
      mkdirSync(dirname(filePath), { recursive: true });

      writeFileSync(filePath, content, 'utf8');
      return `File written: ${input.path}`;
    },
  };
}

/**
 * edit_file: 替换文件中的文本
 *
 * 物理本质：找到纸上的一段话，换成另一段话。
 * 就像用涂改液涂掉旧的，写上新的。
 */
export function createEditFileTool(): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'edit_file',
      description: [
        'Replace text in a file by exact match (replaces the FIRST match only).',
        '',
        '- Finds `old_text` and replaces it with `new_text`. Only the first occurrence',
        '  in the file is replaced — plan accordingly if the text appears multiple times.',
        '- `old_text` MUST be unique in the file. If it is not, expand `old_text` to',
        '  include enough surrounding lines to make it unique.',
        '- If `old_text` is not found, the file has changed under you — `read_file` it',
        '  again before retrying. Never retry from memory.',
        '',
        'Best for small, precise changes (a few lines to ~30 lines).',
        'For creating a new file or rewriting one entirely, use `write_file`.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to workspace.',
          },
          old_text: {
            type: 'string',
            description: 'Exact text to find (must be unique in the file).',
          },
          new_text: {
            type: 'string',
            description: 'Text to replace it with.',
          },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
    executor: async (input) => {
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
  };
}
