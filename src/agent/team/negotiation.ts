// NegotiationManager：请求-响应协商协议（带持久化）
//
// 物理本质：签合同。
// 甲方提出请求（request），乙方审批（approve/reject）。
// 每份合同有唯一编号（request_id），状态可追踪。
// 合同存档在 .team/requests/{id}.json，停电后能恢复。

import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

export type RequestType = 'shutdown' | 'plan_approval';
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface NegotiationRequest {
  id: string;
  type: RequestType;
  from: string;
  to: string;
  content: string;
  status: RequestStatus;
  createdAt: number;
}

/** 请求类型到响应类型的映射（类型安全校验用） */
const RESPONSE_TYPE_MAP: Record<RequestType, string> = {
  shutdown: 'shutdown_response',
  plan_approval: 'plan_approval_response',
};

export class NegotiationManager {
  private requests = new Map<string, NegotiationRequest>();
  private requestsDir: string;

  constructor(teamDir?: string) {
    this.requestsDir = teamDir ? join(teamDir, 'requests') : '';
    if (this.requestsDir) {
      mkdirSync(this.requestsDir, { recursive: true });
      this.loadFromDisk();
    }
  }

  /** 从磁盘加载所有请求 */
  private loadFromDisk(): void {
    if (!this.requestsDir || !existsSync(this.requestsDir)) return;
    try {
      const files = readdirSync(this.requestsDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = JSON.parse(readFileSync(join(this.requestsDir, file), 'utf8'));
          this.requests.set(data.id, data);
        } catch {
          // 跳过损坏的文件
        }
      }
    } catch {
      // 目录不存在，忽略
    }
  }

  /** 持久化单个请求到磁盘 */
  private persistRequest(req: NegotiationRequest): void {
    if (!this.requestsDir) return;
    const filePath = join(this.requestsDir, `${req.id}.json`);
    writeFileSync(filePath, JSON.stringify(req, null, 2), 'utf8');
  }

  /** 发起请求 */
  createRequest(type: RequestType, from: string, to: string, content: string): string {
    const id = randomUUID().slice(0, 8);
    const req: NegotiationRequest = {
      id,
      type,
      from,
      to,
      content,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.requests.set(id, req);
    this.persistRequest(req);
    return id;
  }

  /** 响应请求 */
  respond(requestId: string, approve: boolean): boolean {
    const req = this.requests.get(requestId);
    if (!req || req.status !== 'pending') return false;
    req.status = approve ? 'approved' : 'rejected';
    this.persistRequest(req);
    return true;
  }

  /** 过期 pending 请求 */
  expire(requestId: string): boolean {
    const req = this.requests.get(requestId);
    if (!req || req.status !== 'pending') return false;
    req.status = 'expired';
    this.persistRequest(req);
    return true;
  }

  /**
   * 类型安全的响应匹配
   *
   * 物理本质：核对合同编号和类型。
   * shutdown_response 只能关闭 shutdown 请求，不能误关 plan_approval 请求。
   */
  matchResponse(responseType: string, requestId: string, approve: boolean): boolean {
    const req = this.requests.get(requestId);
    if (!req || req.status !== 'pending') return false;

    // 类型安全校验
    const expectedType = RESPONSE_TYPE_MAP[req.type];
    if (responseType !== expectedType) return false;

    req.status = approve ? 'approved' : 'rejected';
    this.persistRequest(req);
    return true;
  }

  /** 获取请求状态 */
  getStatus(requestId: string): RequestStatus | undefined {
    return this.requests.get(requestId)?.status;
  }

  /** 获取请求详情 */
  getRequest(requestId: string): NegotiationRequest | undefined {
    return this.requests.get(requestId);
  }

  /** 获取待处理请求 */
  getPendingRequests(to: string): NegotiationRequest[] {
    return Array.from(this.requests.values())
      .filter(r => r.to === to && r.status === 'pending');
  }
}
