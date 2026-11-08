/**
 * Typed access to process.env. Implemented by: server-core.
 * Values are loaded by dotenvx (`npx @dotenvx/dotenvx run --convention=nextjs -- ...`).
 * Never log a value from here; log only whether it is set.
 */
import { DEFAULT_DASHBOARD_URL, DEFAULT_SERVER_URL, SERVER_PORT } from '@pacepay/shared';

export type EnvName =
  | 'TRUEFOUNDRY_API_KEY'
  | 'TRUEFOUNDRY_BASE_URL'
  | 'NEMOTRON_SUPER_MODEL'
  | 'NEMOTRON_NANO_MODEL'
  | 'NEMOTRON_VISION_MODEL'
  | 'ANTHROPIC_MODEL'
  | 'EMBED_MODEL'
  | 'IMAGE_MODEL'
  | 'TTS_MODEL'
  | 'NVIDIA_API_KEY'
  | 'NVIDIA_BASE_URL'
  | 'NEMOTRON_ULTRA_MODEL'
  | 'NEMOTRON_VL_MODEL'
  | 'NVIDIA_EMBED_MODEL'
  | 'BREV_NEMOTRON_URL'
  | 'OPENAI_API_KEY'
  | 'OPENAI_REALTIME_MODEL'
  | 'PHOTON_API_KEY'
  | 'PHOTON_PROJECT_ID'
  | 'PHOTON_IMESSAGE_NUMBER'
  | 'PHOTON_VOICE_NUMBER'
  | 'PHOTON_VOICE_PROFILE_ID'
  | 'PHOTON_CUSTOMER_SPACE_ID'
  | 'PHOTON_AGENT_SENDER_ID'
  | 'LIVEKIT_URL'
  | 'LIVEKIT_API_KEY'
  | 'LIVEKIT_API_SECRET'
  | 'LIVEKIT_SIP_OUTBOUND_TRUNK_ID'
  | 'LIVEKIT_SIP_INBOUND_TRUNK_ID'
  | 'LIVEKIT_SIP_DISPATCH_RULE_ID'
  | 'DATABASE_URL'
  | 'CUSTOMER_PHONE'
  | 'LENDER_PHONE'
  | 'INBOUND_PIN'
  | 'SERVER_URL'
  | 'DASHBOARD_URL'
  // Server-only switches (not secrets):
  | 'PACEPAY_AGENT' // 'stub' | 'real' (default 'stub' until agent-core lands)
  | 'PACEPAY_MESSAGING' // 'photon' | 'console' (default 'console' unless PHOTON_API_KEY is set)
  | 'PACEPAY_DATA_DIR' // default <repo>/data
  | 'PACEPAY_IGNORE_QUIET_HOURS' // '1' turns off the quiet-hours hold (night rehearsals)
  | 'PORT';

export function env(name: EnvName): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

export function requireEnv(name: EnvName): string {
  const v = env(name);
  if (v === undefined) throw new Error(`Missing env ${name}. Run through dotenvx (see README > Setup).`);
  return v;
}

export function hasEnv(name: EnvName): boolean {
  return env(name) !== undefined;
}

export const serverUrl = (): string => env('SERVER_URL') ?? DEFAULT_SERVER_URL;
export const dashboardUrl = (): string => env('DASHBOARD_URL') ?? DEFAULT_DASHBOARD_URL;
export const serverPort = (): number => Number(env('PORT') ?? SERVER_PORT);
