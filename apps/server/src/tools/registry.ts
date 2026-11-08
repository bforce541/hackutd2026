/**
 * The tool registry (SPEC §5.6). Implemented by: server-core.
 *
 * Every tool is a file in this folder that calls defineTool(name, input, output, impl) with the
 * schemas from @pacepay/shared (TOOLS[name].input / .output) and is registered in tools/index.ts.
 * runTool validates input and output with zod and emits 'tool.called' and 'tool.result'
 * (or a 'tool.result' with level 'error' on failure, then rethrows).
 */
import type { z } from 'zod';
import type * as engine from '@pacepay/engine';
import type { Day, ModelRole, ToolCaller, ToolInput, ToolName, ToolOutput } from '@pacepay/shared';
import { TOOLS } from '@pacepay/shared';
import type { Bus } from '../bus';
import type { Store } from '../store';
import type { MessagingPort } from '../messaging/port';
import type { ModelClient } from '../models';
import type { CallDispatcher } from '../voice/dispatch';
import type { AgentEvent } from '@pacepay/shared';

export type Engine = typeof engine;

/** The demo clock. today() is the demo day (store.day()); now() is real wall time (ISO). */
export interface Clock {
  today(): Day;
  now(): string;
}

/** Everything a tool (or the agent) may touch. Built once in index.ts. */
export interface ToolContext {
  store: Store;
  bus: Bus;
  engine: Engine;
  messaging: MessagingPort;
  models: ModelClient;
  dispatch: CallDispatcher;
  clock: Clock;
  /**
   * Hand an event to the agent (e.g. place_call's SIP failure -> CALL_FAILED, a timer -> APPROVAL_TIMEOUT).
   * Set after the agent is created; queues events so they are handled one at a time.
   */
  enqueue(event: AgentEvent): void;
}

/** Per-call scope, for activity events. */
export interface ToolScope {
  caseId?: string;
  planId?: string;
  stepId?: string;
  caller?: ToolCaller;
  /** Label on the feed row; defaults to 'code'. */
  model?: ModelRole;
  /**
   * True when PacePay starts the text on its own (the watcher's CD alert, shortfall alert,
   * reminders). Texting tools pass it to messaging/outbox.ts, which holds such texts during quiet
   * hours or while paused. Never set for replies or mid-call approvals.
   */
  unprompted?: boolean;
}

export type ToolImpl<N extends ToolName> = (input: ToolInput<N>, ctx: ToolContext, scope: ToolScope) => Promise<ToolOutput<N>>;

export interface RegisteredTool<N extends ToolName = ToolName> {
  name: N;
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
  impl: ToolImpl<N>;
}

export class ToolNotImplementedError extends Error {
  readonly code = 'not_implemented';
}

export function defineTool<N extends ToolName>(
  name: N,
  inputSchema: (typeof TOOLS)[N]['input'],
  outputSchema: (typeof TOOLS)[N]['output'],
  impl: ToolImpl<N>,
): RegisteredTool<N> {
  return { name, input: inputSchema, output: outputSchema, impl };
}

/** A placeholder registration so the registry is complete before a tool is written. */
export function notImplementedTool<N extends ToolName>(name: N): RegisteredTool<N> {
  return defineTool(name, TOOLS[name].input, TOOLS[name].output, async () => {
    throw new ToolNotImplementedError(`tools.${name}: not implemented yet`);
  });
}

const registry = new Map<ToolName, RegisteredTool>();

export function registerTool(tool: RegisteredTool): void {
  registry.set(tool.name, tool);
}

export function getTool(name: ToolName): RegisteredTool | undefined {
  return registry.get(name);
}

export async function runTool<N extends ToolName>(
  name: N,
  input: unknown,
  ctx: ToolContext,
  scope: ToolScope = {},
): Promise<ToolOutput<N>> {
  const tool = registry.get(name) as RegisteredTool<N> | undefined;
  if (!tool) throw new ToolNotImplementedError(`tools.${name}: not registered`);
  const base = { tool: name, caseId: scope.caseId, planId: scope.planId, stepId: scope.stepId, model: scope.model ?? 'code' } as const;
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) {
    ctx.bus.emit({ ...base, type: 'tool.result', title: `${name}: invalid input`, level: 'error', detail: { input, issues: parsed.error.issues } });
    throw new Error(`tools.${name}: invalid input: ${parsed.error.message}`);
  }
  ctx.bus.emit({ ...base, type: 'tool.called', title: `Called ${name}`, detail: { input: parsed.data } });
  const started = Date.now();
  try {
    const out = await tool.impl(parsed.data as ToolInput<N>, ctx, scope);
    const checked = tool.output.parse(out) as ToolOutput<N>;
    ctx.bus.emit({ ...base, type: 'tool.result', title: `${name} returned`, ms: Date.now() - started, detail: { output: checked } });
    return checked;
  } catch (err) {
    ctx.bus.emit({
      ...base,
      type: 'tool.result',
      title: `${name} failed: ${(err as Error).message}`,
      level: 'error',
      ms: Date.now() - started,
    });
    throw err;
  }
}
