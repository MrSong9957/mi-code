import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, isAbsolute, resolve } from 'path';
import { randomBytes } from 'crypto';

export interface PlanContext {
  sessionId: string;
  turnId: string;
}

export interface PlanEntry {
  filePath: string;
  content: string;
  createdAt: string;
  sessionId: string;
  turnId: string | null;
  status: 'pending' | 'approved' | 'rejected';
}

export class PlanStore {
  private static readonly CLEANUP_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  private plansDir: string;
  private begunContext: PlanContext | null = null;
  private activePlan: PlanEntry | null = null;

  constructor(baseDir: string, plansDirOverride?: string) {
    this.plansDir = plansDirOverride
      ? (isAbsolute(plansDirOverride) ? plansDirOverride : resolve(process.cwd(), plansDirOverride))
      : join(baseDir, 'plans');
    mkdirSync(this.plansDir, { recursive: true });
  }

  getPlansDir(): string {
    return this.plansDir;
  }

  beginTurn(context: PlanContext): void {
    this.begunContext = { ...context };
    this.activePlan = null;
  }

  write(context: PlanContext, content: string): string {
    if (!this.contextMatches(this.begunContext, context)) {
      throw new Error('Plan can only be written for the current turn.');
    }

    const createdAt = new Date().toISOString();
    const fileName = `${context.sessionId}-${randomBytes(3).toString('hex')}.md`;
    const filePath = join(this.plansDir, fileName);
    const body = `---\nsession: ${context.sessionId}\nturn: ${context.turnId}\ncreated: ${createdAt}\nstatus: pending\n---\n\n${content}\n`;
    writeFileSync(filePath, body, 'utf8');
    this.activePlan = {
      filePath,
      content: body,
      createdAt,
      sessionId: context.sessionId,
      turnId: context.turnId,
      status: 'pending',
    };
    this.cleanupOldPlans();
    return filePath;
  }

  getActive(context: PlanContext): PlanEntry | null {
    if (!this.contextMatches(this.begunContext, context)
      || !this.activePlan
      || !this.contextMatches(this.activePlan, context)
      || this.activePlan.status !== 'pending') {
      return null;
    }
    return this.activePlan;
  }

  recoverLatestForSession(sessionId: string): PlanEntry | null {
    try {
      let latest: PlanEntry | null = null;
      for (const fileName of readdirSync(this.plansDir).filter(file => file.endsWith('.md'))) {
        const entry = this.readPlanFile(join(this.plansDir, fileName));
        if (!entry || entry.sessionId !== sessionId) continue;
        if (!latest || entry.createdAt > latest.createdAt) latest = entry;
      }
      return latest;
    } catch {
      return null;
    }
  }

  setStatus(context: PlanContext, status: 'approved' | 'rejected'): boolean {
    const activePlan = this.getActive(context);
    if (!activePlan || !existsSync(activePlan.filePath)) return false;
    const content = readFileSync(activePlan.filePath, 'utf8');
    const updated = content.replace(/^(status:\s*)\w+/m, `$1${status}`);
    writeFileSync(activePlan.filePath, updated, 'utf8');
    this.activePlan = null;
    return true;
  }

  private contextMatches(a: PlanEntry | PlanContext | null, b: PlanContext): boolean {
    return a?.sessionId === b.sessionId && a.turnId === b.turnId;
  }

  private cleanupOldPlans(): void {
    try {
      const cutoff = Date.now() - PlanStore.CLEANUP_AGE_MS;
      for (const fileName of readdirSync(this.plansDir).filter(file => file.endsWith('.md'))) {
        const filePath = join(this.plansDir, fileName);
        if (statSync(filePath).mtimeMs < cutoff) unlinkSync(filePath);
      }
    } catch { /* Ignore cleanup failures. */ }
  }

  private readPlanFile(filePath: string): PlanEntry | null {
    const content = readFileSync(filePath, 'utf8');
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) return null;
    const field = (name: string) => frontmatter[1].match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim();
    const sessionId = field('session');
    const turnId = field('turn');
    const createdAt = field('created');
    const status = field('status');
    if (!sessionId || !createdAt || (status !== 'pending' && status !== 'approved' && status !== 'rejected')) {
      return null;
    }
    return { filePath, content, sessionId, turnId: turnId ?? null, createdAt, status };
  }
}
