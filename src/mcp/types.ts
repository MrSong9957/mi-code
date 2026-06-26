// MCP 类型定义
export interface MCPTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface MCPServerCfg {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface PluginManifest {
  name: string;
  version: string;
  mcpServers: Record<string, MCPServerCfg>;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<string> | string;
