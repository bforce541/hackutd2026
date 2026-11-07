// Checks that the shared keys decrypt and actually work. Prints names and status only, never values.
// Run from the repo root:  npx @dotenvx/dotenvx run -- node scripts/check-keys.mjs

import { readFileSync } from "node:fs";

const env = process.env;
const E164 = /^\+[1-9]\d{7,14}$/;

async function http(url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return `rejected (HTTP ${res.status})`;
    return `HTTP ${res.status}`;
  } catch (err) {
    return `unreachable (${err.name})`;
  }
}

const checks = [
  ["NVIDIA_API_KEY", () =>
    http(`${env.NVIDIA_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.NVIDIA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.NEMOTRON_NANO_MODEL, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
    })],
  ["OPENAI_API_KEY", () =>
    http("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } })],
  ["ANTHROPIC_API_KEY", () =>
    http("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    })],
  // The project secret only works through the spectrum-ts SDK, so this checks its shape, not a live call.
  ["SPECTRUM_PROJECT_ID", () => (/^[0-9a-f-]{36}$/.test(env.SPECTRUM_PROJECT_ID) ? "ok" : "not a project UUID")],
  ["SPECTRUM_PROJECT_SECRET", () => (env.SPECTRUM_PROJECT_SECRET.length >= 32 ? "set" : "too short")],
  ["PHOTON_IMESSAGE_NUMBER", "phone"],
  ["PHOTON_VOICE_NUMBER", "phone"],
  ["LIVEKIT_URL"],
  ["LIVEKIT_API_KEY"],
  ["LIVEKIT_API_SECRET"],
  ["LIVEKIT_SIP_OUTBOUND_TRUNK_ID"],
  ["DATABASE_URL"],
  ["JORDAN_PHONE", "phone"],
  ["LENDER_PHONE", "phone"],
  ["INBOUND_PIN", () => (/^\d{4}$/.test(env.INBOUND_PIN) ? "ok" : "should be 4 digits")],
];

// Values that must never sit in .env as plain text, because the repo is public.
const SECRETS = [
  "NVIDIA_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "SPECTRUM_PROJECT_ID", "SPECTRUM_PROJECT_SECRET",
  "PHOTON_IMESSAGE_NUMBER", "PHOTON_VOICE_NUMBER", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET",
  "DATABASE_URL", "JORDAN_PHONE", "LENDER_PHONE", "INBOUND_PIN",
];

let problems = 0;
for (const [name, test] of checks) {
  let status;
  if (!env[name]) status = "missing";
  else if (test === "phone") status = E164.test(env[name]) ? "ok" : "not E.164 (+1...)";
  else if (typeof test === "function") status = await test();
  else status = "set";
  if (status !== "ok" && status !== "set") problems++;
  console.log(`${status === "ok" || status === "set" ? "✓" : "✗"} ${name.padEnd(30)} ${status}`);
}

try {
  const raw = readFileSync(".env", "utf8");
  for (const name of SECRETS) {
    const line = raw.split("\n").find((l) => l.startsWith(`${name}=`));
    if (line && !/^[A-Z_]+="?encrypted:/.test(line)) {
      problems++;
      console.log(`✗ ${name.padEnd(30)} stored as PLAIN TEXT in .env. Fix: npx @dotenvx/dotenvx encrypt -k ${name}`);
    }
  }
} catch {
  console.log("✗ .env not found. Run this from the repo root.");
  problems++;
}

console.log(problems ? `\n${problems} item(s) need attention.` : "\nAll keys present and working.");
process.exit(problems ? 1 : 0);
