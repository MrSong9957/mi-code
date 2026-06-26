// MCPRouter：统一路由器
import type { MCPClient } from './client.js';
import type { ToolDefinition } from '../agent/types.js';

function normalizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class MCPRouter {
  private servers = new Map<string, MCPClient>();

  registerServer(name: string, client: MCPClient): void {
    this.servers.set(name, client);
  }

  getToolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const [serverName, client] of this.servers) {
      const safeServer = normalizeName(serverName);
      for (const tool of client.listTools()) {
        const safeTool = normalizeName(tool.name);
        defs.push({
          name: `mcp__${safeServer}__${safeTool}`,
          description: tool.description,
          parameters: tool.parameters as unknown as ToolDefinition['parameters'],
        });
      }
    }
    return defs;
  }

  async execute(prefixedName: string, args: Record<string, unknown>): Promise<string> {
    const parsed = this.parseName(prefixedName);
    if (!parsed) return `MCP error: invalid tool name '${prefixedName}'`;
    const client = this.servers.get(parsed.server);
    if (!client) return `MCP error: server '${parsed.server}' not found`;
    return client.callTool(parsed.tool, args);
  }

  private parseName(name: string): { server: string; tool: string } | null {
    if (!name.startsWith('mcp__')) return null;
    const rest = name.slice(5);
    const idx = rest.indexOf('__');
    if (idx === -1) return null;
    return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
  }

  isMCPTool(name: string): boolean {
    return name.startsWith('mcp__');
  }

  get serverCount(): number {
    return this.servers.size;
  }
}
