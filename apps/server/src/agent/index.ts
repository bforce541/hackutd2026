/**
 * The agent's single entry point: agent.handle(event). Interface owned by server-core;
 * 'stub' is implemented by: agent-stub (stub.ts); 'real' by: agent-core (orchestrator.ts).
 *
 * handle() never throws to its caller: failures become 'error' activity events. Events are
 * handled one at a time, in order (ToolContext.enqueue serializes them).
 */
import type { AgentEvent } from '@pacepay/shared';
import type { ToolContext } from '../tools/registry';
import { createStubAgent } from './stub';
import { createRealAgent } from './orchestrator';

export interface Agent {
  handle(event: AgentEvent): Promise<void>;
}

export type AgentMode = 'stub' | 'real';

export function createAgent(ctx: ToolContext, opts: { mode: AgentMode }): Agent {
  return opts.mode === 'real' ? createRealAgent(ctx) : createStubAgent(ctx);
}
