# HackUTD 2026

## Team

- Yoshua
- Ram

## Docs

- [v2.md](v2.md): what we're building and why
- [SPEC.md](SPEC.md): how we're building it
- [UI.md](UI.md): how it looks and behaves, based on research

## Deploy

Every push to `main` deploys to **https://pacepay.work** through Vercel (project `pacepay` on Yoshua's Vercel account, connected to this repo). Nobody needs to run a deploy command.

- Vercel builds `apps/dashboard` (Next.js) from the pnpm workspace. A push that changes nothing in `apps/dashboard` or the packages it uses (docs, for example) skips the build.
- `www.pacepay.work` serves the site, and `pacepay.work` redirects to it. DNS is at Porkbun: an A record for `@` and a CNAME for `www`, both pointing at Vercel.
- Builds fail with "root directory does not exist" until `apps/dashboard` lands. That's expected.
- The repo has to stay public: on Vercel's Hobby plan, pushes from anyone but Yoshua only deploy from a public repo.
- The deployed dashboard can't reach a server on `localhost`. To show live data on pacepay.work, give the server a public URL (for example a tunnel on `api.pacepay.work`) and set `SERVER_URL` in the Vercel project's environment variables. Otherwise demo the dashboard locally.

## Setup

This repo is public, so every key lives in `.env` **encrypted** with [dotenvx](https://dotenvx.com). You need one file to unlock it.

1. Get `.env.keys` from Ram over DM and save it in the repo root. It's gitignored. Never commit it or paste it anywhere public.
2. Check that your keys work:

   ```bash
   npx @dotenvx/dotenvx run --convention=nextjs -- node scripts/check-keys.mjs
   ```

3. Run anything with the keys loaded by putting `npx @dotenvx/dotenvx run --convention=nextjs --` in front of the command. That flag also loads a personal, gitignored `.env.local` if you have one.

Two keys are **not** in `.env`: the TrueFoundry gateway key and the OpenAI key. They stay on Ram's machine in `.env.local`. Without them, the server runs in NVIDIA mode, with every Nemotron role on the shared NVIDIA key ([SPEC.md › 5.4](SPEC.md#54-models-and-timeouts)). Real phone calls only work on Ram's machine. Who builds what is in [SPEC.md › 10](SPEC.md#10-workstreams-and-tasks).

To add or change a setting, run `npx @dotenvx/dotenvx set NAME value` (it encrypts automatically), then commit `.env`. Keep every value encrypted, even model names: a plain-text value makes git refuse the commit on machines that ran `dotenvx protect`. `.env.example` lists every setting and where to get it.

Before committing `.env`, run `npx @dotenvx/dotenvx protect`. It fails if any secret is in plain text. The key check above flags plain-text secrets too.
