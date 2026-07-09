// 搜索工具：glob（按文件名模式找文件）、grep（按内容找文件）
//
// 物理本质：
// - glob：拿着一张"通缉令"（pattern，比如 **/*.ts），逐个房间（目录）搜，
//         把长相符合通缉令的文件（文件名匹配）全部捞出来。
// - grep：拿着一把"显形灯"（regex），把每个文件的每一行照一遍，
//         哪一行有匹配的关键字，就把"哪个文件 + 第几行 + 那行写了啥"全部报告。
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { safePath, getWorkdir } from './path-sandbox.js';
import type { ToolDefinition, ToolExecutor } from '../types.js';

/** 默认忽略的目录（搜索结果不进入这些目录） */
const DEFAULT_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
]);

// 把 glob pattern 翻译成正则
//
// 支持：
// - **  匹配任意层目录（含 0 层）
// - *   匹配单层内任意字符（不含路径分隔符）
// - ?   匹配单个字符
// - .   字面量
// - 其余字符按字面量
function globToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      // ** ：匹配任意层目录（含 0 层）
      // 吃掉后面紧跟的 /
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 3;
      } else {
        re += '.*';
        i += 2;
      }
    } else if (c === '*') {
      // * ：匹配单层内任意字符（不含 /）
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

/** 递归收集 workdir 下所有文件（相对路径），跳过 DEFAULT_IGNORE 目录 */
function collectFiles(root: string): string[] {
  const results: string[] = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (DEFAULT_IGNORE.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        results.push(relative(root, full).replace(/\\/g, '/'));
      }
    }
  };

  walk(root);
  return results;
}

/**
 * glob：按文件名模式找文件
 *
 * 物理本质：拿着通缉令（pattern）逐个房间搜，
 * 把文件名匹配的文件全部捞出来。返回相对路径。
 */
export function createGlobTool(): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'glob',
      description:
        'Find files by glob pattern. Returns matching file paths relative to workspace. node_modules/.git/dist are excluded automatically. Examples: "**/*.ts", "src/**/*.test.ts", "*.md".',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern. ** matches any depth, * matches within one directory.',
          },
        },
        required: ['pattern'],
      },
    },
    executor: async (input) => {
      const pattern = input.pattern as string;
      if (!pattern) return 'Error: pattern is required';

      // 模式用正则匹配（pattern 自身不引用 workdir，不需要沙箱化）
      const re = globToRegex(pattern);
      const root = getWorkdir();
      const files = collectFiles(root);
      const matched = files.filter((f) => re.test(f));
      // 字典序，便于稳定输出
      matched.sort();
      return matched.join('\n');
    },
  };
}

/**
 * grep：按正则搜索文件内容
 *
 * 物理本质：拿着显形灯（regex）把每个文件每一行照一遍，
 * 哪行匹配就把"文件 + 行号 + 内容"报出来。
 */
export function createGrepTool(): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'grep',
      description:
        'Search file contents by regex. Returns matches as "path:line: matched-text". Searches the whole workspace by default, or scope to a sub-directory with path. node_modules/.git/dist are excluded automatically.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regular expression to search for.',
          },
          path: {
            type: 'string',
            description: 'Optional sub-directory to scope the search (relative to workspace).',
          },
        },
        required: ['pattern'],
      },
    },
    executor: async (input) => {
      const pattern = input.pattern as string;
      if (!pattern) return 'Error: pattern is required';

      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error: invalid regex: ${msg}`;
      }

      // path 限定搜索根（默认整个 workdir）；走沙箱防越界
      const scope = input.path as string | undefined;
      const root = scope ? safePath(scope) : getWorkdir();

      // 收集候选文件（相对 root）
      const files = collectFiles(root);
      const out: string[] = [];
      // 限制结果数量，避免一次返回过多
      const MAX_MATCHES = 200;
      const MAX_FILE_SIZE = 1024 * 1024; // 跳过 >1MB 的文件

      for (const relPath of files) {
        if (out.length >= MAX_MATCHES) {
          out.push('... (truncated, more than 200 matches)');
          break;
        }
        const abs = join(root, relPath);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.size > MAX_FILE_SIZE) continue;

        let content: string;
        try {
          content = readFileSync(abs, 'utf8');
        } catch {
          continue;
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            // 如果 root 是 workdir 子目录，relPath 已相对 root；
            // 输出时统一用相对于 workdir 的路径，便于和别处对齐
            const displayPath = scope
              ? `${scope.replace(/\\/g, '/').replace(/\/$/, '')}/${relPath}`
              : relPath;
            out.push(`${displayPath}:${i + 1}: ${lines[i]}`);
            if (out.length >= MAX_MATCHES) break;
          }
        }
      }

      return out.join('\n');
    },
  };
}
