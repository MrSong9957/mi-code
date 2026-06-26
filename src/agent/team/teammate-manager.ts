// TeammateManager：管理团队名册和生命周期
//
// 物理本质：项目经理。
// 维护一份团队名单（config.json），
// 谁来了、谁在干活、谁闲着、谁走了，都记在上面。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { MessageBus } from './message-bus.js';

export type TeamMemberStatus = 'idle' | 'working' | 'shutdown';

export interface TeamMember {
  name: string;
  role: string;
  status: TeamMemberStatus;
}

export interface TeamConfig {
  members: TeamMember[];
}

export class TeammateManager {
  private configPath: string;
  private config: TeamConfig;
  public messageBus: MessageBus;

  constructor(teamDir: string) {
    mkdirSync(teamDir, { recursive: true });
    this.configPath = join(teamDir, 'config.json');
    this.config = this.loadConfig();
    this.messageBus = new MessageBus(teamDir);
  }

  private loadConfig(): TeamConfig {
    if (existsSync(this.configPath)) {
      try {
        return JSON.parse(readFileSync(this.configPath, 'utf8'));
      } catch {
        return { members: [] };
      }
    }
    return { members: [] };
  }

  private saveConfig(): void {
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
  }

  /** 获取团队成员列表 */
  list(): TeamMember[] {
    return [...this.config.members];
  }

  /** 获取空闲的队友 */
  getIdleMembers(): TeamMember[] {
    return this.config.members.filter(m => m.status === 'idle');
  }

  /** 注册一个新队友 */
  spawn(name: string, role: string, _prompt: string): void {
    if (this.config.members.find(m => m.name === name)) {
      throw new Error(`Teammate "${name}" already exists`);
    }
    const member: TeamMember = { name, role, status: 'working' };
    this.config.members.push(member);
    this.saveConfig();
  }

  /** 设置队友为空闲状态 */
  setIdle(name: string): void {
    const member = this.config.members.find(m => m.name === name);
    if (!member) throw new Error(`Teammate "${name}" not found`);
    member.status = 'idle';
    this.saveConfig();
  }

  /** 按名字查找队友 */
  getByName(name: string): TeamMember | null {
    return this.config.members.find(m => m.name === name) ?? null;
  }

  /** 生成团队状态描述 */
  describe(): string {
    if (this.config.members.length === 0) return 'No teammates.';

    const lines = ['Team:'];
    for (const m of this.config.members) {
      const icon = m.status === 'working' ? '⚙️' : m.status === 'idle' ? '💤' : '⏹️';
      lines.push(`  ${icon} ${m.name} (${m.role}) - ${m.status}`);
    }
    return lines.join('\n');
  }
}
