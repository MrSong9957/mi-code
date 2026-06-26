// MCPClient：MCP 协议客户端（教学版内存模拟）
import type { MCPTool, ToolHandler } from './types.js';

export class MCPClient {
  readonly name: string;
  private toolsList: MCPTool[] = [];
  private handlers = new Map<string, ToolHandler>();

  constructor(name: string) {
    this.name = name;
  }

  /** 注册工具（模拟 tools/list） */
  registerTools(tools: MCPTool[], handlers: Record<string, ToolHandler>): void {
    this.toolsList = tools;
    for (const [name, handler] of Object.entries(handlers)) {
      this.handlers.set(name, handler);
    }
  }

  /** 列出工具定义 */
  listTools(): MCPTool[] {
    return [...this.toolsList];
  }

  /** 调用工具（模拟 tools/call） */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const handler = this.handlers.get(toolName);
    if (!handler) return `MCP error: unknown tool '${toolName}'`;
    try {
      return await handler(args);
    } catch (err) {
      return `MCP execution error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
