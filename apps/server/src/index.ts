/**
 * Boots the server: store, bus, models, messaging, tools, agent, watcher, HTTP on port 8787.
 * Implemented by: server-core.
 */
import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as engine from '@pacepay/engine';
import { DEMO_DAY0, type AgentEvent, type Household } from '@pacepay/shared';
import { createStore } from './store';
import { createBus } from './bus';
import { createModelClient } from './models';
import { createConsoleMessaging } from './messaging/console';
import { createPhotonMessaging } from './messaging/photon';
import type { MessagingPort } from './messaging/port';
import { routeIncoming } from './messaging/router';
import { dispatcher } from './voice/dispatch';
import { registerAllTools } from './tools';
import type { ToolContext } from './tools/registry';
import { createAgent, type AgentMode } from './agent';
import { createWatcher } from './agent/watcher';
import { createApp } from './app';
import type { ServerContext } from './context';
import { env, hasEnv, serverPort } from './env';
import { nowIso } from './ids';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The v2.md household from the engine fixture; an empty placeholder until the fixture exists. */
function loadHousehold(): Household {
  try {
    return structuredClone(engine.fixtures.household);
  } catch {
    return {
      id: 'placeholder',
      person: { name: 'Yoshua', phoneEnv: 'CUSTOMER_PHONE' },
      day0Date: DEMO_DAY0,
      grossAnnualIncome: 0,
      monthlyEssentials: [],
      accounts: [],
      scheduled: [],
      rules: { checkingFloor: 0, savingsFloor: 0, feeLimit: 0, offLimitsAccountIds: [] },
      counterparties: [],
    };
  }
}

function pickMessaging(): MessagingPort {
  const mode = env('PACEPAY_MESSAGING') ?? (hasEnv('PHOTON_API_KEY') ? 'photon' : 'console');
  if (mode !== 'photon') return createConsoleMessaging();
  return createPhotonMessaging({
    apiKey: env('PHOTON_API_KEY') ?? '',
    projectId: env('PHOTON_PROJECT_ID') ?? '',
    customerPhone: env('CUSTOMER_PHONE') ?? '',
    spaceId: env('PHOTON_CUSTOMER_SPACE_ID') ?? '',
    senderId: env('PHOTON_AGENT_SENDER_ID') ?? '',
  });
}

export function buildContext(): ServerContext {
  const household = loadHousehold();
  const store = createStore({ household, dataDir: env('PACEPAY_DATA_DIR') ?? resolve(repoRoot, 'data') });
  const bus = createBus({ onActivity: (e) => store.appendActivity(e), startSeq: store.get().lastSeq });
  const models = createModelClient({ bus });
  const messaging = pickMessaging();
  registerAllTools();

  // Events are handled one at a time, in arrival order.
  let chain: Promise<void> = Promise.resolve();
  const agentMode: AgentMode = env('PACEPAY_AGENT') === 'real' ? 'real' : 'stub';
  const ctx = {
    store,
    bus,
    engine,
    messaging,
    models,
    dispatch: dispatcher,
    clock: { today: () => store.day(), now: nowIso },
    enqueue(event: AgentEvent) {
      chain = chain.then(() => ctx.agent.handle(event)).catch((err) => {
        bus.emit({ type: 'step.failed', title: `Agent failed on ${event.type}: ${(err as Error).message}`, level: 'error', model: 'code' });
      });
    },
    agentMode,
    loadHousehold,
  } as Omit<ServerContext, 'agent' | 'watcher'> as ServerContext;
  ctx.agent = createAgent(ctx as ToolContext, { mode: agentMode });
  ctx.watcher = createWatcher(ctx);
  return ctx;
}

async function main(): Promise<void> {
  const ctx = buildContext();
  const app = createApp(ctx);
  const port = serverPort();
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[server] PacePay server on http://localhost:${info.port} (agent: ${ctx.agentMode}, models: ${ctx.models.provider()})`);
  });
  try {
    // The photon stream owns everything after this point (photon.ts and messaging/router.ts).
    await ctx.messaging.start(async (m) => {
      try {
        const image = m.imageRef
          ? { data: await ctx.messaging.fetchImage(m.imageRef), contentType: m.imageContentType ?? 'image/jpeg', name: m.imageRef }
          : undefined;
        await routeIncoming(ctx, { text: m.text, image, channel: 'imessage', externalId: m.id, at: m.at });
      } catch (err) {
        ctx.bus.emit({ type: 'message.in', title: `Could not route a message: ${(err as Error).message}`, model: 'code', level: 'warn', detail: { id: m.id } });
      }
    });
  } catch (err) {
    ctx.bus.emit({ type: 'step.failed', title: `Messaging did not start: ${(err as Error).message}`, level: 'warn', model: 'code' });
  }
  ctx.watcher.start();
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main();
