/**
 * The model client (SPEC §5.4). Interface owned by server-core; implemented by: models
 * (gateway.ts: OpenAI SDK on TRUEFOUNDRY_BASE_URL; nvidia.ts: build.nvidia.com with NVIDIA_API_KEY).
 *
 * Rules every implementation keeps:
 * - Provider is picked automatically: 'gateway' when TRUEFOUNDRY_API_KEY is set, else 'nvidia'.
 * - Every call (success, failure, timeout) emits one 'model.called' activity event with the
 *   ModelRole that actually ran, the duration in `ms`, and the request/response in `detail`.
 * - Claude calls send no temperature/top_p/top_k and never force tool_choice.
 * - `json`: ask for JSON, validate with the zod schema, retry once on a parse failure, then throw
 *   ModelOutputError.
 * - Timeouts default per job (SPEC §5.4 table) and throw ModelTimeoutError.
 * - Jobs a provider cannot serve (Claude, image, tts in NVIDIA mode) throw ModelUnavailableError;
 *   callers skip the step with a 'warn' activity event.
 */
import type OpenAI from 'openai';
import type { z } from 'zod';
import type { ModelJob, ModelProvider, ModelRole, ToolName } from '@pacepay/shared';
import type { Bus } from '../bus';
import { createGatewayClient } from './gateway';
import { createNvidiaClient } from './nvidia';

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

export interface ChatRequest<S extends z.ZodTypeAny | undefined = undefined> {
  role: ModelJob;
  messages: ChatMessage[];
  /** Tool names from @pacepay/shared (converted with toOpenAITool) or raw tool specs. */
  tools?: (ToolName | ChatTool)[];
  /** When set, the reply must be JSON matching this schema; result.json holds the parsed value. */
  json?: S;
  timeoutMs?: number;
  /** For the activity event. */
  caseId?: string;
  stepId?: string;
  /** One plain line for the feed, e.g. 'Nemotron 3 Ultra wrote the plan'. */
  title?: string;
  /** Extra fields merged into the activity event's detail (e.g. { callId } for a question asked on a call). */
  detail?: Record<string, unknown>;
  /** Image inputs for the vision job (bytes or URLs). */
  images?: { data: Buffer; contentType: string }[];
}

export interface ChatToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments (not yet validated; runTool validates). */
  arguments: unknown;
}

export interface ChatResult<T = unknown> {
  text: string;
  toolCalls: ChatToolCall[];
  json: T;
  /** The concrete model id used, e.g. 'aws-bedrock/nvidia.nemotron-super-3-120b'. */
  model: string;
  modelRole: ModelRole;
  provider: ModelProvider;
  ms: number;
  /** The assistant message to append when continuing a tool loop. */
  assistantMessage: ChatMessage;
}

export interface ModelClient {
  chat<S extends z.ZodTypeAny | undefined = undefined>(
    req: ChatRequest<S>,
  ): Promise<ChatResult<S extends z.ZodTypeAny ? z.infer<S> : undefined>>;
  embed(texts: string[], opts?: { caseId?: string }): Promise<number[][]>;
  image(prompt: string, opts?: { size?: '1024x1024' | '1536x1024' | '1024x1536' }): Promise<Buffer>;
  tts(text: string): Promise<Buffer>;
  provider(): ModelProvider;
  /** False when this provider cannot serve the job (e.g. 'claude' in NVIDIA mode). */
  available(role: ModelJob): boolean;
  /** The ModelRole label a job runs as on this provider (for plan steps and the feed). */
  roleFor(job: ModelJob): ModelRole;
}

export class ModelUnavailableError extends Error {
  readonly code = 'model_unavailable';
}
export class ModelTimeoutError extends Error {
  readonly code = 'model_timeout';
}
export class ModelOutputError extends Error {
  readonly code = 'model_output';
}

/** SPEC §5.4 default timeouts per job, in ms. */
export const DEFAULT_TIMEOUTS: Record<ModelJob, number> = {
  planner: 45_000,
  orchestrator: 20_000,
  decide: 4_000,
  vision: 20_000,
  claude: 30_000,
  embed: 10_000,
  image: 120_000,
  tts: 60_000,
};

/** Which ModelRole a job runs as, per provider (SPEC §5.4 tables). */
export function modelRoleFor(job: ModelJob, provider: ModelProvider): ModelRole {
  switch (job) {
    case 'planner':
      return 'nemotron-ultra';
    case 'orchestrator':
    case 'decide':
      return 'nemotron-super';
    case 'vision':
      return provider === 'gateway' ? 'nemotron-vision' : 'nemotron-super';
    case 'claude':
      return 'claude-opus';
    case 'embed':
    case 'image':
    case 'tts':
      return 'code';
  }
}

export interface ModelClientDeps {
  bus: Bus;
  env?: NodeJS.ProcessEnv;
}

/** Picks the provider by whether TRUEFOUNDRY_API_KEY is set (gateway) or not (NVIDIA mode). */
export function createModelClient(deps: ModelClientDeps): ModelClient {
  const env = deps.env ?? process.env;
  return env.TRUEFOUNDRY_API_KEY ? createGatewayClient(deps.bus, env) : createNvidiaClient(deps.bus, env);
}
