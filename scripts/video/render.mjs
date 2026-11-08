// Render a design/video page to video, frame by frame, by setting window.hold for each frame.
//
// CLI: node scripts/video/render.mjs <page.html> <seconds> <out.mp4|out.mov> [--fps 30] [--from 0] [--speed 1] [--alpha]
//   --alpha: transparent background, ProRes 4444 .mov (for overlays)
//
// playwright-core is resolved from the repo, or from $PLAYWRIGHT_CORE (a path to its package dir).
// It drives the system Chrome (channel 'chrome'), so no browser download is needed.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright-core'); } catch {}
  if (process.env.PLAYWRIGHT_CORE) return require(process.env.PLAYWRIGHT_CORE);
  throw new Error('playwright-core not found: pnpm add -Dw playwright-core, or set PLAYWRIGHT_CORE');
}

let browserP = null;
export async function browser() {
  if (!browserP) browserP = loadPlaywright().then((pw) => pw.chromium.launch({ channel: 'chrome' }));
  return browserP;
}
export async function closeBrowser() { if (browserP) (await browserP).close(); browserP = null; }

/** Open a page at 1920x1080 and wait for fonts. */
export async function openPage(url, { alpha = false } = {}) {
  const b = await browser();
  const page = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'networkidle' });
  if (alpha) await page.addStyleTag({ content: 'html,body{background:transparent!important}' });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/**
 * Render frames of an open page to a video file.
 * timeAt(i) gives the page time for frame i. beforeFrame(page, t) may set extra state.
 */
export async function renderFrames(page, { out, frames, fps = 30, timeAt, alpha = false, onProgress }) {
  const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-'];
  args.push(...(alpha
    ? ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le']
    : ['-c:v', 'libx264', '-crf', '15', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', String(fps)]), out);
  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c} for ${out}`)))));
  for (let i = 0; i < frames; i++) {
    const t = timeAt(i);
    await page.evaluate((t) => new Promise((r) => {
      window.hold = t;
      requestAnimationFrame(() => requestAnimationFrame(() => r()));
    }), t);
    // composite pages hold their layers until every iframe has drawn this frame
    await page.evaluate(() => (window.layersReady ? window.layersReady() : null));
    const img = await page.screenshot(alpha ? { type: 'png', omitBackground: true } : { type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(img)) await new Promise((r) => ff.stdin.once('drain', r));
    if (onProgress && i % fps === 0) onProgress(i / fps);
  }
  ff.stdin.end();
  await done;
}

// ---- CLI ----
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [html, secs, out, ...rest] = process.argv.slice(2);
  const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  const fps = Number(opt('--fps', 30)), from = Number(opt('--from', 0)), speed = Number(opt('--speed', 1));
  const alpha = rest.includes('--alpha');
  const url = /^https?:/.test(html) ? html : pathToFileURL(path.resolve(html)).href + (alpha ? '?bg=none' : '');
  const page = await openPage(url, { alpha });
  const frames = Math.round(Number(secs) * fps);
  await renderFrames(page, { out, frames, fps, alpha, timeAt: (i) => from + (i / fps) * speed,
    onProgress: (s) => process.stdout.write(`\r${s.toFixed(0)}s / ${secs}s`) });
  await closeBrowser();
  console.log(`\nwrote ${out} (${frames} frames)`);
}
