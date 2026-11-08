/**
 * The server's dependency bundle, built once in index.ts and passed to every router.
 * Implemented by: server-core.
 */
import type { Household } from '@pacepay/shared';
import type { Agent, AgentMode } from './agent';
import type { Watcher } from './agent/watcher';
import type { ToolContext } from './tools/registry';

export interface ServerContext extends ToolContext {
  agent: Agent;
  agentMode: AgentMode;
  watcher: Watcher;
  /** A fresh copy of the v2.md household (for reset). */
  loadHousehold(): Household;
}
