/**
 * The scripted agent (SPEC §10.1): walks the repair case with UI.md's exact texts and no model
 * calls, so the dashboard and demo:e2e work before the real agent. Implemented by: agent-stub.
 * Uses the engine for numbers and the templates in @pacepay/shared for every text.
 * It keeps the same contracts as the real agent (see the orchestrator.ts header): states through
 * machine.ts, texts through the tools or messaging/outbox.ts, approvals through request_approval,
 * SSE `case` after every change, so the dashboard and demo:e2e cannot tell the two apart.
 */
import type { Agent } from './index';
import type { ToolContext } from '../tools/registry';

export function createStubAgent(ctx: ToolContext): Agent {
  return {
    async handle(event) {
      ctx.bus.emit({
        type: 'event.received',
        title: `Received ${event.type} (stub agent not implemented yet)`,
        model: 'code',
        level: 'warn',
        detail: event,
      });
    },
  };
}
