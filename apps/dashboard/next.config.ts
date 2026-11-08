import type { NextConfig } from 'next';
import { resolve } from 'node:path';

// The workspace root (two levels up from apps/dashboard), so Next traces files across packages.
const root = resolve(process.cwd(), '../..');

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@pacepay/shared', '@pacepay/engine'],
  // SPEC §1: the dashboard reads the server URL through next.config, no extra env var.
  env: { NEXT_PUBLIC_SERVER_URL: process.env.SERVER_URL ?? '' },
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default nextConfig;
