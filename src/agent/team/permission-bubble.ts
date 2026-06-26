// PermissionBubble：权限冒泡机制
//
// 物理本质：员工遇到需要老板签字的事情，
// 写一张申请单（permission_request）放到老板桌上（Lead 收件箱）。
// 老板批了（approve）或驳了（reject），
// 再把结果单（permission_response）扔回员工桌上。
// 员工看到批条后继续干活。

import { randomUUID } from 'crypto';
import type { MessageBus } from './message-bus.js';

export interface PermissionRequest {
  id: string;
  from: string;
  tool: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
}

export class PermissionBubble {
  private requests = new Map<string, PermissionRequest>();
  private bus: MessageBus;

  constructor(bus: MessageBus) {
    this.bus = bus;
  }

  /** 队友发起权限请求 */
  createRequest(from: string, tool: string, reason: string): string {
    const id = randomUUID().slice(0, 8);
    this.requests.set(id, {
      id,
      from,
      tool,
      reason,
      status: 'pending',
      createdAt: Date.now(),
    });

    // 向 Lead 发送 permission_request 消息
    this.bus.send(from, 'lead', `Permission needed: ${tool} - ${reason}`, 'permission_request', id);
    return id;
  }

  /** Lead 响应权限请求 */
  respond(requestId: string, approve: boolean): boolean {
    const req = this.requests.get(requestId);
    if (!req || req.status !== 'pending') return false;

    req.status = approve ? 'approved' : 'rejected';

    // 向队友发回 permission_response
    this.bus.send('lead', req.from, approve ? 'approved' : 'rejected', 'permission_response', requestId);
    return true;
  }

  /** 获取请求状态 */
  getStatus(requestId: string): PermissionRequest['status'] | undefined {
    return this.requests.get(requestId)?.status;
  }

  /** 获取请求详情 */
  getRequest(requestId: string): PermissionRequest | undefined {
    return this.requests.get(requestId);
  }

  /** 获取待处理请求 */
  getPendingRequests(): PermissionRequest[] {
    return Array.from(this.requests.values())
      .filter(r => r.status === 'pending');
  }
}
