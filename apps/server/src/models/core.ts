/**
 * Shared chat/embed/image/tts engine behind both providers (SPEC §5.4). gateway.ts and nvidia.ts
 * only say which model serves which job and how to reach it; the timeouts, the one retry, the
 * 'model.called' event per call and the JSON helper live here.
 */
import OpenAI from 'openai';
import type { z } from 'zod';
import { toOpenAITool } from '@pacepay/shared';
import type { ModelJob, ModelProvider, ModelRole } from '@pacepay/shared';
import type { Bus } from '../bus';
import {
  DEFAULT_TIMEOUTS,
  ModelOutputError,
  ModelTimeoutError,
  ModelUnavailableError,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ChatTool,
  type ModelClient,
} from './index';

/** One way to serve a job: the SDK client, the model id, and the label to report. */
export interface Route {
  client: OpenAI;
  model: string;
  role: ModelRole;
  /** Claude: no temperature/top_p/top_k, no forced tool_choice (we never send them anyway). */
  claude?: boolean;
}

export interface ProviderSpec {
  provider: ModelProvider;
  /** Routes to try in order for a job (first, then the one retry may use the next). Empty = unavailable. */
  routes(job: ModelJob): Route[];
  roleFor(job: ModelJob): ModelRole;
  /** Embeddings / images / speech (gateway only for the last two). */
  embedRoute(): Route | undefined;
  imageUrl?: string;
  imageModel?: string;
  imageKey?: string;
  ttsModel?: string;
}

const isTimeout = (e: unknown): boolean =>
  e instanceof ModelTimeoutError ||
  (e instanceof Error && (e.name === 'AbortError' || e.name === 'APIConnectionTimeoutError' || /timed? ?out/i.test(e.message)));

function brief(e: unknown): string {
  if (e instanceof OpenAI.APIError) return `${e.status ?? ''} ${e.message}`.trim().slice(0, 300);
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

/** Retry only what a second try can fix: timeouts, 429, 5xx, connection errors. */
function retryable(e: unknown): boolean {
  if (e instanceof ModelUnavailableError || e instanceof ModelOutputError) return false;
  if (isTimeout(e)) return true;
  if (e instanceof OpenAI.APIError) return e.status === undefined || e.status === 429 || e.status >= 500;
  return true;
}

function toChatTools(tools: ChatRequest['tools']): ChatTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => (typeof t === 'string' ? (toOpenAITool(t) as ChatTool) : t));
}

function withImages(messages: ChatMessage[], images: NonNullable<ChatRequest['images']>): ChatMessage[] {
  const parts = images.map((i) => ({
    type: 'image_url' as const,
    image_url: { url: `data:${i.contentType};base64,${i.data.toString('base64')}` },
  }));
  const out = [...messages];
  for (let k = out.length - 1; k >= 0; k--) {
    const m = out[k];
    if (m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : '';
      out[k] = { role: 'user', content: [{ type: 'text', text }, ...parts] };
      return out;
    }
  }
  out.push({ role: 'user', content: parts });
  return out;
}

/** Pull a JSON value out of a reply that may be fenced or have prose around it. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  const start = t.search(/[[{]/);
  if (start >= 0) {
    const open = t[start];
    const close = open === '{' ? '}' : ']';
    const end = t.lastIndexOf(close);
    if (end > start) return JSON.parse(t.slice(start, end + 1));
  }
  throw new Error('no JSON found in reply');
}

const ULTRA_GAP_MS = 4000;
const ULTRA_BACKOFF_MS = [1500, 3000, 5000];
let ultraSlot: Promise<void> = Promise.resolve();
let ultraLast = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Serialize Ultra calls through one queue that starts them at least ULTRA_GAP_MS apart. */
function ultraTurn(): Promise<void> {
  const mine = ultraSlot.then(async () => {
    const wait = ultraLast + ULTRA_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    ultraLast = Date.now();
  });
  ultraSlot = mine.catch(() => undefined);
  return mine;
}

function retryAfterMs(e: unknown): number | undefined {
  const h = (e as { headers?: unknown })?.headers as { get?: (k: string) => string | null } | Record<string, string> | undefined;
  const v = h ? (typeof (h as { get?: unknown }).get === 'function' ? (h as { get: (k: string) => string | null }).get('retry-after') : (h as Record<string, string>)['retry-after']) : undefined;
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(v);
  return Number.isNaN(d) ? undefined : Math.max(0, d - Date.now());
}

export function createEngine(spec: ProviderSpec, bus: Bus): ModelClient {
  const available = (job: ModelJob) => spec.routes(job).length > 0;

  function emit(role: ModelRole, ms: number, req: { caseId?: string; stepId?: string; detail?: Record<string, unknown> }, title: string, level: 'info' | 'warn' | 'error', detail: unknown) {
    const merged = req.detail ? { ...req.detail, ...(detail && typeof detail === 'object' ? detail : {}) } : detail;
    bus.emit({ type: 'model.called', model: role, caseId: req.caseId, stepId: req.stepId, title, level, ms, detail: merged });
  }

  async function once(route: Route, req: ChatRequest<z.ZodTypeAny | undefined>, messages: ChatMessage[], timeoutMs: number) {
    const tools = toChatTools(req.tools);
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: route.model,
      messages: req.images?.length ? withImages(messages, req.images) : messages,
      ...(tools ? { tools } : {}),
    };
    let res: OpenAI.Chat.Completions.ChatCompletion;
    if (route.role !== 'nemotron-ultra') {
      res = await route.client.chat.completions.create(params, { timeout: timeoutMs, maxRetries: 0 });
    } else {
      // Ultra on build.nvidia.com rate-limits hard: queue, and on 429 back off and retry Ultra
      // (inside this step's timeout) before the caller falls back to Super.
      const deadline = Date.now() + timeoutMs;
      for (let n = 0; ; n++) {
        await ultraTurn();
        const left = deadline - Date.now();
        if (left <= 0) throw new ModelTimeoutError(`timed out waiting for ${route.model}`);
        try {
          res = await route.client.chat.completions.create(params, { timeout: left, maxRetries: 0 });
          break;
        } catch (e) {
          if (!(e instanceof OpenAI.APIError) || e.status !== 429 || n >= ULTRA_BACKOFF_MS.length) throw e;
          const wait = retryAfterMs(e) ?? ULTRA_BACKOFF_MS[n] * (0.8 + Math.random() * 0.4);
          if (Date.now() + wait + 1000 >= deadline) throw e;
          await sleep(wait);
        }
      }
    }
    const msg = res.choices[0]?.message;
    if (!msg) throw new Error('empty completion');
    return msg;
  }

  async function chat<S extends z.ZodTypeAny | undefined>(req: ChatRequest<S>) {
    const routes = spec.routes(req.role);
    if (!routes.length) {
      emit(spec.roleFor(req.role), 0, req, req.title ?? `Model call (${req.role}) skipped: not available in ${spec.provider} mode`, 'warn', { job: req.role });
      throw new ModelUnavailableError(`models.${req.role}: not available in ${spec.provider} mode`);
    }
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUTS[req.role];
    let messages = req.messages;
    if (req.json) {
      messages = [
        ...messages,
        { role: 'user', content: 'Reply with a single JSON value only: no prose, no code fences.' },
      ];
    }
    const started = Date.now();
    let attempt = 0;
    let parseRetried = false;
    let lastErr: unknown;
    // attempt 0 on the first route; the one retry uses the next route if there is one (planner: Ultra -> Super).
    while (attempt < 2) {
      const route = routes[Math.min(attempt, routes.length - 1)];
      const t0 = Date.now();
      try {
        const msg = await once(route, req, messages, timeoutMs);
        const text = typeof msg.content === 'string' ? msg.content : '';
        const toolCalls = (msg.tool_calls ?? []).flatMap((c) => {
          if (c.type !== 'function') return [];
          let args: unknown = {};
          try {
            args = c.function.arguments ? JSON.parse(c.function.arguments) : {};
          } catch {
            args = { _raw: c.function.arguments };
          }
          return [{ id: c.id, name: c.function.name, arguments: args }];
        });
        let json: unknown = undefined;
        if (req.json) {
          try {
            json = req.json.parse(extractJson(text));
          } catch (pe) {
            if (parseRetried) throw new ModelOutputError(`models.${req.role}: reply was not valid JSON for the schema: ${brief(pe)}`);
            parseRetried = true;
            messages = [
              ...messages,
              { role: 'assistant', content: text },
              { role: 'user', content: `That was not valid. ${brief(pe)}\nReply again with only the corrected JSON.` },
            ];
            emit(route.role, Date.now() - t0, req, `${req.title ?? req.role}: reply was not valid JSON, asking once more`, 'warn', { error: brief(pe) });
            continue;
          }
        }
        const ms = Date.now() - started;
        emit(route.role, ms, req, req.title ?? `${route.role} answered (${req.role})`, 'info', {
          model: route.model,
          provider: spec.provider,
          request: { messages: req.messages.slice(-3), tools: req.tools?.map((t) => (typeof t === 'string' ? t : 'function' in t ? t.function.name : 'custom')) },
          response: { text: text.slice(0, 2000), toolCalls },
        });
        return {
          text,
          toolCalls,
          json,
          model: route.model,
          modelRole: route.role,
          provider: spec.provider,
          ms,
          assistantMessage: { role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) } as ChatMessage,
        } as ChatResult<never>;
      } catch (e) {
        if (e instanceof ModelOutputError) {
          emit(route.role, Date.now() - started, req, `${req.title ?? req.role} failed: ${e.message}`, 'error', { error: e.message });
          throw e;
        }
        lastErr = e;
        const timedOut = isTimeout(e);
        attempt++;
        if (attempt >= 2 || !retryable(e)) {
          const err = timedOut ? new ModelTimeoutError(`models.${req.role}: timed out after ${timeoutMs} ms`) : e;
          emit(route.role, Date.now() - started, req, `${req.title ?? req.role} ${timedOut ? 'timed out' : 'failed'}: ${brief(e)}`, 'error', { error: brief(e), timedOut });
          throw err;
        }
        emit(route.role, Date.now() - t0, req, `${req.title ?? req.role} ${timedOut ? 'timed out' : 'failed'}, retrying once`, 'warn', { error: brief(e) });
      }
    }
    throw lastErr;
  }

  async function embed(texts: string[], opts?: { caseId?: string }): Promise<number[][]> {
    const route = spec.embedRoute();
    const t0 = Date.now();
    if (!route) {
      emit('code', 0, { caseId: opts?.caseId }, 'Embedding skipped: no embedding model', 'warn', {});
      throw new ModelUnavailableError('models.embed: not available');
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await route.client.embeddings.create(
          { model: route.model, input: texts, ...(spec.provider === 'nvidia' ? ({ input_type: 'passage' } as object) : {}) } as OpenAI.EmbeddingCreateParams,
          { timeout: DEFAULT_TIMEOUTS.embed, maxRetries: 0 },
        );
        const out = res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
        emit('code', Date.now() - t0, { caseId: opts?.caseId }, `Embedded ${texts.length} passage${texts.length === 1 ? '' : 's'}`, 'info', { model: route.model, dims: out[0]?.length });
        return out;
      } catch (e) {
        if (attempt === 0 && retryable(e)) continue;
        const timedOut = isTimeout(e);
        emit('code', Date.now() - t0, { caseId: opts?.caseId }, `Embedding ${timedOut ? 'timed out' : 'failed'}: ${brief(e)}`, 'error', { error: brief(e) });
        throw timedOut ? new ModelTimeoutError('models.embed: timed out') : e;
      }
    }
  }

  /** Raw POST to a gateway endpoint outside the SDK's typed surface. */
  async function post(url: string, key: string, body: unknown, timeout: number): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      if (ctl.signal.aborted) throw new ModelTimeoutError(`timed out after ${timeout} ms`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function binaryJob(job: 'image' | 'tts', label: string, run: () => Promise<Buffer>): Promise<Buffer> {
    const t0 = Date.now();
    if (!spec.imageUrl) {
      emit('code', 0, {}, `${label} skipped: not available in ${spec.provider} mode`, 'warn', {});
      throw new ModelUnavailableError(`models.${job}: not available in ${spec.provider} mode`);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const buf = await run();
        emit('code', Date.now() - t0, {}, `${label} done`, 'info', { bytes: buf.length });
        return buf;
      } catch (e) {
        if (attempt === 0 && retryable(e)) continue;
        emit('code', Date.now() - t0, {}, `${label} failed: ${brief(e)}`, 'error', { error: brief(e) });
        throw e;
      }
    }
  }

  return {
    chat: chat as ModelClient['chat'],
    embed,
    image: (prompt, opts) =>
      binaryJob('image', 'Image generation', async () => {
        const res = await post(`${spec.imageUrl}/images/generations`, spec.imageKey!, { model: spec.imageModel, prompt, size: opts?.size ?? '1536x1024', n: 1 }, DEFAULT_TIMEOUTS.image);
        if (!res.ok) throw Object.assign(new Error(`image ${res.status}: ${(await res.text()).slice(0, 200)}`), { status: res.status });
        const j = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
        const d = j.data?.[0];
        if (d?.b64_json) return Buffer.from(d.b64_json, 'base64');
        if (d?.url) return Buffer.from(await (await fetch(d.url)).arrayBuffer());
        throw new Error('image response had no data');
      }),
    tts: (text) =>
      binaryJob('tts', 'Text to speech', async () => {
        const res = await post(`${spec.imageUrl}/audio/speech`, spec.imageKey!, { model: spec.ttsModel, input: text, voice: 'alloy', response_format: 'mp3' }, DEFAULT_TIMEOUTS.tts);
        if (!res.ok) {
          const body = (await res.text()).slice(0, 300);
          // The gateway answers 400 'createSpeech is not supported' for ElevenLabs models: not retryable.
          if (res.status === 400 && /not supported/i.test(body)) throw new ModelUnavailableError(`models.tts: gateway does not support speech for ${spec.ttsModel}`);
          throw Object.assign(new Error(`tts ${res.status}: ${body}`), { status: res.status });
        }
        return Buffer.from(await res.arrayBuffer());
      }),
    provider: () => spec.provider,
    available,
    roleFor: spec.roleFor,
  };
}
