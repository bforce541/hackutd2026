// Checks that the shared keys decrypt and actually work. Prints names and status only, never values.
// Run from the repo root:  npx @dotenvx/dotenvx run --convention=nextjs -- node scripts/check-keys.mjs

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
  ["TRUEFOUNDRY_API_KEY", () =>
    http(`${env.TRUEFOUNDRY_BASE_URL}/models`, { headers: { Authorization: `Bearer ${env.TRUEFOUNDRY_API_KEY}` } }),
    { missingNote: "only on Ram's machine, in .env.local" }],
  ["TRUEFOUNDRY_BASE_URL"],
  ["NVIDIA_API_KEY", () =>
    http(`${env.NVIDIA_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.NVIDIA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.NEMOTRON_ULTRA_MODEL, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
    }), { optional: true }],
  ["OPENAI_API_KEY", () =>
    http("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } })],
  ["PHOTON_API_KEY", () =>
    env.PHOTON_PROJECT_ID
      ? http(`https://api.photon.codes/v1/projects/${env.PHOTON_PROJECT_ID}`, {
          headers: { Authorization: `Bearer ${env.PHOTON_API_KEY}` },
        })
      : "set, but PHOTON_PROJECT_ID is missing"],
  ["PHOTON_PROJECT_ID", () => (/^pho_prj_[a-z0-9]+$/.test(env.PHOTON_PROJECT_ID) ? "ok" : "should start with pho_prj_")],
  ["PHOTON_IMESSAGE_NUMBER", "phone"],
  ["PHOTON_VOICE_NUMBER", "phone"],
  ["PHOTON_VOICE_PROFILE_ID"],
  ["PHOTON_CUSTOMER_SPACE_ID", () => (/^pho_spc_/.test(env.PHOTON_CUSTOMER_SPACE_ID) ? "ok" : "should start with pho_spc_")],
  ["PHOTON_AGENT_SENDER_ID", () => (/^pho_usr_/.test(env.PHOTON_AGENT_SENDER_ID) ? "ok" : "should start with pho_usr_")],
  ["LIVEKIT_URL"],
  ["LIVEKIT_API_KEY"],
  ["LIVEKIT_API_SECRET"],
  ["LIVEKIT_SIP_OUTBOUND_TRUNK_ID"],
  ["DATABASE_URL", "optional"],
  ["BREV_NEMOTRON_URL", "optional"],
  ["CUSTOMER_PHONE", "phone"],
  ["LENDER_PHONE", "phone"],
  ["INBOUND_PIN", () => (/^\d{4}$/.test(env.INBOUND_PIN) ? "ok" : "should be 4 digits")],
];

// Values that must never sit in .env as plain text, because the repo is public.
const SECRETS = [
  "TRUEFOUNDRY_API_KEY", "NVIDIA_API_KEY", "OPENAI_API_KEY", "PHOTON_API_KEY",
  "PHOTON_IMESSAGE_NUMBER", "PHOTON_VOICE_NUMBER", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET",
  "DATABASE_URL", "CUSTOMER_PHONE", "LENDER_PHONE", "INBOUND_PIN",
];

let problems = 0;
for (const [name, test, opts = {}] of checks) {
  let status;
  if (!env[name]) status = test === "optional" || opts.optional ? "optional, not set" : opts.missingNote ? `missing (${opts.missingNote})` : "missing";
  else if (test === "phone") status = E164.test(env[name]) ? "ok" : "not E.164 (+1...)";
  else if (typeof test === "function") status = await test();
  else status = "set";
  const fine = status === "ok" || status === "set" || status === "optional, not set";
  if (!fine) problems++;
  console.log(`${fine ? "✓" : "✗"} ${name.padEnd(30)} ${status}`);
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
