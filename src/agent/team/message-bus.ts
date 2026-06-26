// MessageBus：append-only JSONL 收件箱通信
//
// 物理本质：每个人的信箱。
// 写信 = 追加一行到对方的信箱文件
// 读信 = 读取全部并清空

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export type MessageType =
  | 'message'
  | 'broadcast'
  | 'idle_notification'
  | 'permission_request'
  | 'permission_response'
  | 'shutdown_request'
  | 'shutdown_response'
  | 'plan_approval_response'
  | 'result';

export interface Message {
  type: MessageType;
  from: string;
  content: string;
  timestamp: number;
  /** 权限请求/响应的关联 ID */
  requestId?: string;
}

export class MessageBus {
  private inboxDir: string;

  constructor(teamDir: string) {
    this.inboxDir = join(teamDir, 'inbox');
    mkdirSync(this.inboxDir, { recursive: true });
  }

  /** 发送消息 */
  send(sender: string, to: string, content: string, type: MessageType = 'message', requestId?: string): void {
    const msg: Message = {
      type,
      from: sender,
      content,
      timestamp: Date.now(),
      ...(requestId ? { requestId } : {}),
    };

    const filepath = join(this.inboxDir, `${to}.jsonl`);
    const line = JSON.stringify(msg) + '\n';

    // 追加写入（同步，避免并发问题）
    writeFileSync(filepath, line, { flag: 'a' });
  }

  /** 广播消息给所有人 */
  broadcast(sender: string, recipients: string[], content: string): void {
    for (const recipient of recipients) {
      this.send(sender, recipient, content, 'broadcast');
    }
  }

  /** 读取收件箱（读取后清空） */
  readInbox(name: string): Message[] {
    const filepath = join(this.inboxDir, `${name}.jsonl`);

    if (!existsSync(filepath)) {
      return [];
    }

    const content = readFileSync(filepath, 'utf8').trim();
    if (!content) {
      return [];
    }

    const messages = content.split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as Message);

    // 清空收件箱
    writeFileSync(filepath, '', 'utf8');

    return messages;
  }
}
