/**
 * Gateway provider (SPEC §5.4): the OpenAI SDK on TRUEFOUNDRY_BASE_URL for chat, tools, vision,
 * Claude and embeddings. Images and speech sit on the gateway host, NOT under /v1 for images.
 * Planner/plan_call use Nemotron 3 Ultra on build.nvidia.com when NVIDIA_API_KEY is set, with the
 * one retry going to Super; otherwise Super.
 */
import OpenAI from 'openai';
import type { ModelJob, ModelRole } from '@pacepay/shared';
import type { Bus } from '../bus';
import { createEngine, type ProviderSpec, type Route } from './core';
import type { ModelClient } from './index';

export function createGatewayClient(bus: Bus, env: NodeJS.ProcessEnv): ModelClient {
  const baseURL = env.TRUEFOUNDRY_BASE_URL!;
  const apiKey = env.TRUEFOUNDRY_API_KEY!;
  const gw = new OpenAI({ apiKey, baseURL, maxRetries: 0 });
  const host = new URL(baseURL).origin;
  const nv = env.NVIDIA_API_KEY
    ? new OpenAI({ apiKey: env.NVIDIA_API_KEY, baseURL: env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1', maxRetries: 0 })
    : undefined;

  const superR: Route = { client: gw, model: env.NEMOTRON_SUPER_MODEL!, role: 'nemotron-super' };
  const ultraR: Route | undefined = nv && env.NEMOTRON_ULTRA_MODEL ? { client: nv, model: env.NEMOTRON_ULTRA_MODEL, role: 'nemotron-ultra' } : undefined;
  const visionR: Route = { client: gw, model: env.NEMOTRON_VISION_MODEL!, role: 'nemotron-vision' };
  const claudeR: Route = { client: gw, model: env.ANTHROPIC_MODEL!, role: 'claude-opus', claude: true };

  const spec: ProviderSpec = {
    provider: 'gateway',
    routes(job: ModelJob): Route[] {
      switch (job) {
        case 'planner':
          return ultraR ? [ultraR, superR] : [superR];
        case 'orchestrator':
        case 'decide':
          return [superR];
        case 'vision':
          return [visionR];
        case 'claude':
          return [claudeR];
        default:
          return [];
      }
    },
    roleFor(job: ModelJob): ModelRole {
      if (job === 'planner') return ultraR ? 'nemotron-ultra' : 'nemotron-super';
      if (job === 'embed' || job === 'image' || job === 'tts') return 'code';
      return spec.routes(job)[0].role;
    },
    embedRoute: () => (env.EMBED_MODEL ? { client: gw, model: env.EMBED_MODEL, role: 'code' } : undefined),
    imageUrl: host,
    imageModel: env.IMAGE_MODEL,
    imageKey: apiKey,
    ttsModel: env.TTS_MODEL,
  };
  return createEngine(spec, bus);
}
