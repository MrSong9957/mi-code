// 协商工具：shutdown_request、respond_request、submit_plan、approve_plan
import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { NegotiationManager } from './negotiation.js';
import type { TeammateManager } from './teammate-manager.js';

export function createShutdownRequestTool(
  negotiation: NegotiationManager,
  team: TeammateManager,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'shutdown_request',
      description: 'Request a teammate to shut down gracefully',
      parameters: {
        type: 'object',
        properties: {
          teammate: { type: 'string', description: 'Teammate name to shutdown' },
        },
        required: ['teammate'],
      },
    },
    executor: async (input) => {
      const reqId = negotiation.createRequest('shutdown', 'lead', input.teammate as string, 'Please shut down gracefully.');
      team.messageBus.send('lead', input.teammate as string, `Shutdown request: ${reqId}`, 'message');
      return `Shutdown request ${reqId} sent (status: pending)`;
    },
  };
}

export function createRespondRequestTool(
  negotiation: NegotiationManager,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'respond_request',
      description: 'Approve or reject a pending request',
      parameters: {
        type: 'object',
        properties: {
          request_id: { type: 'string', description: 'Request ID to respond to' },
          approve: { type: 'boolean', description: 'true to approve, false to reject' },
        },
        required: ['request_id', 'approve'],
      },
    },
    executor: async (input) => {
      const ok = negotiation.respond(input.request_id as string, input.approve as boolean);
      return ok ? `Request ${input.request_id} ${input.approve ? 'approved' : 'rejected'}` : 'Request not found or already resolved';
    },
  };
}

export function createSubmitPlanTool(
  negotiation: NegotiationManager,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'submit_plan',
      description: 'Submit a plan for approval',
      parameters: {
        type: 'object',
        properties: {
          plan: { type: 'string', description: 'Plan description' },
        },
        required: ['plan'],
      },
    },
    executor: async (input) => {
      const reqId = negotiation.createRequest('plan_approval', 'lead', 'system', input.plan as string);
      return `Plan submitted as ${reqId} (status: pending)`;
    },
  };
}

export function createApprovePlanTool(
  negotiation: NegotiationManager,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'approve_plan',
      description: 'Approve or reject a submitted plan',
      parameters: {
        type: 'object',
        properties: {
          request_id: { type: 'string', description: 'Plan request ID' },
          approve: { type: 'boolean', description: 'true to approve, false to reject' },
        },
        required: ['request_id', 'approve'],
      },
    },
    executor: async (input) => {
      const ok = negotiation.respond(input.request_id as string, input.approve as boolean);
      return ok ? `Plan ${input.request_id} ${input.approve ? 'approved' : 'rejected'}` : 'Plan not found or already resolved';
    },
  };
}
