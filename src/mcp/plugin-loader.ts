// PluginLoader：从 manifest 发现并注册 MCP server
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { PluginManifest } from './types.js';
import { MCPClient } from './client.js';
import type { MCPRouter } from './router.js';

export function loadPlugins(pluginDir: string, router: MCPRouter): number {
  const manifestPath = join(pluginDir, 'manifest.json');
  if (!existsSync(manifestPath)) return 0;
  let manifest: PluginManifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return 0; }
  let count = 0;
  for (const [serverName] of Object.entries(manifest.mcpServers || {})) {
    router.registerServer(serverName, new MCPClient(serverName));
    count++;
  }
  return count;
}
