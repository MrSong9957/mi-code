// consumeLeadInbox：统一收件箱消费
//
// 物理本质：秘书先筛一遍老板的信箱。
// 普通信件直接放桌上，合同回复先登记到合同系统，再放桌上。
// 这样老板看到的都是已经处理好的信息。

import type { MessageBus } from './message-bus.js';
import type { NegotiationManager } from './negotiation.js';
import type { Message } from './message-bus.js';

/**
 * 消费 Lead 收件箱
 *
 * 先拦截协议响应消息（*_response），更新 NegotiationManager 状态。
 * 然后返回所有消息，供注入主循环。
 */
export function consumeLeadInbox(bus: MessageBus, negotiation: NegotiationManager): Message[] {
  const messages = bus.readInbox('lead');

  for (const msg of messages) {
    const requestId = msg.requestId;
    const msgType = msg.type;

    // 如果是协议响应消息，先拦截并更新状态
    if (requestId && msgType.endsWith('_response')) {
      const approve = msg.content.toLowerCase().includes('approved')
        || msg.content.toLowerCase().includes('shutting down');
      negotiation.matchResponse(msgType, requestId, approve);
    }
  }

  return messages;
}
