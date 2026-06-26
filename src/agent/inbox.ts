// InboxManager：代理间消息传递
//
// 物理本质：每人一个信箱。
// A 给 B 写信 → 投进 B 的信箱 → B 有空时来取。

export interface InboxMessage {
  from: string;
  to: string;
  content: string;
  timestamp: number;
}

export class InboxManager {
  private inboxes = new Map<string, InboxMessage[]>();

  /** 发送消息 */
  send(from: string, to: string, content: string): void {
    const list = this.inboxes.get(to) ?? [];
    list.push({ from, to, content, timestamp: Date.now() });
    this.inboxes.set(to, list);
  }

  /** 接收消息（取走并清空） */
  receive(agentName: string): InboxMessage[] {
    const messages = this.inboxes.get(agentName) ?? [];
    this.inboxes.set(agentName, []);
    return messages;
  }

  /** 检查是否有未读消息 */
  hasMessages(agentName: string): boolean {
    const list = this.inboxes.get(agentName);
    return !!list && list.length > 0;
  }
}
