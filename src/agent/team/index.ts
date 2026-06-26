// 团队模块导出
export type { TeamMember, TeamMemberStatus, TeamConfig } from './teammate-manager.js';
export { TeammateManager } from './teammate-manager.js';
export type { Message, MessageType } from './message-bus.js';
export { MessageBus } from './message-bus.js';
export { createSendMessageTool, createReadInboxTool, createSpawnTeammateTool } from './tools.js';
export type { PermissionRequest } from './permission-bubble.js';
export { PermissionBubble } from './permission-bubble.js';
export type { RequestType, RequestStatus, NegotiationRequest } from './negotiation.js';
export { NegotiationManager } from './negotiation.js';
export { createShutdownRequestTool, createRespondRequestTool, createSubmitPlanTool, createApprovePlanTool } from './negotiation-tools.js';
export { consumeLeadInbox } from './inbox-consumer.js';
export { runIdleLoop, type IdleLoopOptions, type IdleLoopResult } from './idle-loop.js';
export { runAutonomousAgent, type AutonomousAgentOptions, type AutonomousAgentResult } from './autonomous-agent.js';
