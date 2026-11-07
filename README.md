# HackUTD 2026

## Team

- Yoshua
- Ram
- Shravan

## Docs

- [v2.md](v2.md): what we're building and why
- [SPEC.md](SPEC.md): how we're building it

## Setup

This repo is public, so every key lives in `.env` **encrypted** with [dotenvx](https://dotenvx.com). You need one file to unlock it.

1. Get `.env.keys` from Ram over DM and save it in the repo root. It's gitignored. Never commit it or paste it anywhere public.
2. Check that your keys work:

   ```bash
   npx @dotenvx/dotenvx run --convention=nextjs -- node scripts/check-keys.mjs
   ```

3. Run anything with the keys loaded by putting `npx @dotenvx/dotenvx run --convention=nextjs --` in front of the command. That flag also loads a personal, gitignored `.env.local` if you have one.

The TrueFoundry gateway key is **not** in `.env`. It stays on Ram's machine in `.env.local`, so model calls through the gateway only work there.

To add or change a setting, run `npx @dotenvx/dotenvx set NAME value` (it encrypts automatically), then commit `.env`. Keep every value encrypted, even model names: a plain-text value makes git refuse the commit on machines that ran `dotenvx protect`. `.env.example` lists every setting and where to get it.

Before committing `.env`, run `npx @dotenvx/dotenvx protect`. It fails if any secret is in plain text. The key check above flags plain-text secrets too.
