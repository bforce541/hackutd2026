/**
 * NVIDIA mode (SPEC §5.4): everything on build.nvidia.com with NVIDIA_API_KEY. Ultra plans,
 * NEMOTRON_VL_MODEL runs orchestrator/decide/vision, NVIDIA_EMBED_MODEL embeds. Claude, image and
 * tts are unavailable (callers log a warn and skip).
 */
import OpenAI from 'openai';
import type { ModelJob, ModelRole } from '@pacepay/shared';
import type { Bus } from '../bus';
import { createEngine, type ProviderSpec, type Route } from './core';
import { modelRoleFor, type ModelClient } from './index';

export function createNvidiaClient(bus: Bus, env: NodeJS.ProcessEnv): ModelClient {
  const nv = new OpenAI({ apiKey: env.NVIDIA_API_KEY ?? 'missing', baseURL: env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1', maxRetries: 0 });
  const ultra: Route = { client: nv, model: env.NEMOTRON_ULTRA_MODEL!, role: 'nemotron-ultra' };
  const vl: Route = { client: nv, model: env.NEMOTRON_VL_MODEL!, role: 'nemotron-super' };

  const spec: ProviderSpec = {
    provider: 'nvidia',
    routes(job: ModelJob): Route[] {
      switch (job) {
        case 'planner':
          // The retry falls back to the VL model (Super and Nano 404 on build.nvidia.com).
          return [ultra, vl];
        case 'orchestrator':
        case 'decide':
        case 'vision':
          return [vl];
        default:
          return [];
      }
    },
    roleFor: (job: ModelJob): ModelRole => modelRoleFor(job, 'nvidia'),
    embedRoute: () => (env.NVIDIA_EMBED_MODEL ? { client: nv, model: env.NVIDIA_EMBED_MODEL, role: 'code' } : undefined),
  };
  return createEngine(spec, bus);
}
