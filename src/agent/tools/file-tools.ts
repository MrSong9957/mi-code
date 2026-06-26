// 文件工具：read_file, write_file, edit_file
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { safePath } from './path-sandbox.js';
import type { ToolDefinition, ToolExecutor } from '../types.js';

/** 最大读取大小：50KB */
const MAX_READ_SIZE = 50 * 1024;

/**
 * read_file: 读取文件内容
 *
 * 物理本质：打开文件柜，取出文件，看里面写了什么。
 * 可以只看前几行（limit），避免拿太多出来。
 */
export function createReadFileTool(): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'read_file',
      description: 'Read file content. Returns first N lines if limit specified.',
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
    executor: async (input) => {
      const filePath = safePath(input.path as string);
      const limit = input.limit as number | undefined;

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
