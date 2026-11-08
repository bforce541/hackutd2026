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

/** The photo's real type from its first bytes (Photon's port only hands back bytes). */
function sniffImageType(data: Uint8Array): string {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif';
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45) return 'image/webp';
  if (data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) return 'image/heic';
  return 'image/jpeg';
}

function pickMessaging(onWarn: (title: string, detail?: unknown) => void): MessagingPort {
  const mode = env('PACEPAY_MESSAGING') ?? (hasEnv('PHOTON_API_KEY') ? 'photon' : 'console');
  if (mode !== 'photon') return createConsoleMessaging();
  return createPhotonMessaging({
    apiKey: env('PHOTON_API_KEY') ?? '',
    projectId: env('PHOTON_PROJECT_ID') ?? '',
    customerPhone: env('CUSTOMER_PHONE') ?? '',
    spaceId: env('PHOTON_CUSTOMER_SPACE_ID') ?? '',
    senderId: env('PHOTON_AGENT_SENDER_ID') ?? '',
    onWarn,
  });
}

export function buildContext(): ServerContext {
  const household = loadHousehold();
  const store = createStore({ household, dataDir: env('PACEPAY_DATA_DIR') ?? resolve(repoRoot, 'data') });
  const bus = createBus({ onActivity: (e) => store.appendActivity(e), startSeq: store.get().lastSeq });
  const models = createModelClient({ bus });
  const messaging = pickMessaging((title, detail) =>
    bus.emit({ type: 'message.in', level: 'warn', model: 'code', title, detail }),
  );
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
  // Loopback only by default, so approvals cannot be answered from the network. Set HOST to widen it.
  const hostname = env('HOST') ?? '127.0.0.1';
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`[server] PacePay server on http://${hostname}:${info.port} (agent: ${ctx.agentMode}, models: ${ctx.models.provider()})`);
  });
  try {
    // The photon stream owns everything after this point (photon.ts and messaging/router.ts).
    await ctx.messaging.start(async (m) => {
      try {
        let image: { data: Buffer; contentType: string; name: string } | undefined;
        if (m.imageRef) {
          const data = await ctx.messaging.fetchImage(m.imageRef);
          image = { data, contentType: m.imageContentType ?? sniffImageType(data), name: m.imageRef };
        }
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
