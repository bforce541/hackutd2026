/**
 * The negotiation arena (SPEC §11): N text-mode runs against simulated lenders (Ultra or Super,
 * personas from ARENA_PERSONA_MIX), graded by Claude, results to data/arena.json and the store,
 * progress over SSE 'arena'. Implemented by: arena.
 *
 * Isolation: each run gets its own ToolContext, never the live one, so arena runs cannot touch
 * the demo case, text Yoshua or flood the feed: a scratch store (createStore with restore: false,
 * snapshotDelayMs: 0, a temp dataDir, and a Case/Negotiation of its own), a private bus (only
 * the 'arena' progress and 'arena.progress' / 'arena.completed' go to the live bus),
 * createConsoleMessaging with a silent logger, and deal approvals answered 'yes' by the harness
 * (so approval_before_accepting can be graded). The engine and models are shared.
 */
import type { ArenaResults } from '@pacepay/shared';
import type { ToolContext } from '../tools/registry';

export interface ArenaOptions {
  count: number;
  concurrency?: number;
  live?: boolean;
}

/** Starts a run in the background and returns its id at once. */
export function startArenaRun(_ctx: ToolContext, _opts: ArenaOptions): { runId: string; done: Promise<ArenaResults> } {
  throw new Error('agent.startArenaRun: not implemented yet');
}
