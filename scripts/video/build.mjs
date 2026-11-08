// Build the demo video from design/video/timeline.json.
//
//   node scripts/video/build.mjs            render what changed, then assemble out/pacepay-demo.mp4
//   node scripts/video/build.mjs --force    re-render every clip
//   node scripts/video/build.mjs --only call   render just one part (desk|texts|call|rest|close)
//
// Recordings come from design/video/recordings/ (see docs/video-recording-sheet.md). Anything
// missing gets a labelled placeholder (a slate, or silence), so the whole cut can be watched
// before anything is recorded. Rendered clips are cached in design/video/out/clips/.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { openPage, renderFrames, browser, closeBrowser } from './render.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const DESIGN = path.join(ROOT, 'design');
const VIDEO = path.join(DESIGN, 'video');
const REC = path.join(VIDEO, 'recordings');
const OUT = path.join(VIDEO, 'out');
const CLIPS = path.join(OUT, 'clips');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

const TL = JSON.parse(await readFile(path.join(VIDEO, 'timeline.json'), 'utf8'));
const FPS = TL.fps;
const scene = (id) => TL.scenes.find((s) => s.id === id);
const log = (...a) => console.log('[video]', ...a);

// ---------- helpers ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.webp': 'image/webp' };
function serve(dir) {
  return new Promise((res) => {
    const srv = createServer(async (req, resp) => {
      const p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(dir)) { resp.writeHead(403).end(); return; }
      try { const body = await readFile(p); resp.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }).end(body); }
      catch { resp.writeHead(404).end(); }
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

async function findRecording(base) {
  if (!existsSync(REC)) return null;
  const f = (await readdir(REC)).find((n) => path.parse(n).name === base);
  return f ? path.join(REC, f) : null;
}

async function duration(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(stdout);
}
async function hasAudio(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]);
  return stdout.trim().length > 0;
}
const ff = (a) => run('ffmpeg', ['-y', '-loglevel', 'error', ...a], { maxBuffer: 1 << 26 });

/** Cache key: the spec plus the contents of every file it depends on. */
async function keyOf(spec, files) {
  const h = createHash('sha1').update(JSON.stringify(spec));
  for (const f of files) if (existsSync(f)) h.update(await readFile(f));
  return h.digest('hex');
}
async function cached(name, spec, files, make) {
  const out = path.join(CLIPS, name);
  const key = await keyOf(spec, files);
  const keyFile = out + '.key';
  if (!FORCE && existsSync(out) && existsSync(keyFile) && (await readFile(keyFile, 'utf8')) === key) { log(`${name}: cached`); return out; }
  log(`${name}: rendering`);
  const t0 = Date.now();
  await make(out);
  await writeFile(keyFile, key);
  log(`${name}: done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return out;
}
const pageFiles = (...names) => names.flatMap((n) => [path.join(VIDEO, n)]).concat(
  ['thread.js', 'call.js', 'call.json', 'call-cuts.json'].map((n) => path.join(VIDEO, n)));

/** A still PNG from inline HTML (slates and captions). */
async function still(html, out, { alpha = true } = {}) {
  const b = await browser();
  const page = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, omitBackground: alpha });
  await page.close();
}
const FONTS = `<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Instrument+Sans:wght@500;600&display=swap" rel="stylesheet">`;
const slateHtml = (title, sub) => `<!doctype html>${FONTS}<body style="margin:0;width:1920px;height:1080px;display:grid;place-items:center;background:#16181b;font-family:'Instrument Sans',sans-serif;color:#f5f4f0">
  <div style="text-align:center"><div style="font:400 26px 'DM Mono',monospace;letter-spacing:.14em;color:#9b988f;text-transform:uppercase">Placeholder</div>
  <div style="font-size:84px;font-weight:600;letter-spacing:-.02em;margin-top:18px">${title}</div>
  <div style="font:400 30px 'DM Mono',monospace;color:#9b988f;margin-top:22px">${sub}</div></div></body>`;
// captions: a light card in the brand style (warm off-white, ink text, soft shadow), bottom centre
const captionHtml = (text) => `<!doctype html>${FONTS}<body style="margin:0;width:1920px;height:1080px;background:transparent;position:relative">
  <div style="position:absolute;left:50%;bottom:72px;transform:translateX(-50%);max-width:1180px;width:max-content;padding:16px 30px 17px;border-radius:16px;
  background:rgba(250,249,245,.92);box-shadow:0 10px 34px rgba(20,19,15,.18),0 1px 0 rgba(255,255,255,.6) inset;border:1px solid rgba(20,19,15,.06);
  color:#14130f;font:500 38px/1.28 'Instrument Sans',sans-serif;letter-spacing:-.015em;text-align:center;text-wrap:balance">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div></body>`;

async function segmentsOf(base, page) {
  const p = await openPage(`${base}/video/${page}`);
  await p.waitForFunction(() => window.SEGMENTS && Object.keys(window.SEGMENTS).length, null, { timeout: 15000 }).catch(() => {});
  const segs = await p.evaluate(() => window.SEGMENTS || {});
  await p.close();
  return segs;
}

/** Map a page segment into a window: play at 1x, speeding up only if the segment is longer than the window. */
function fit(seg, dur) {
  const len = seg.end - seg.start;
  const speed = Math.max(1, len / dur);
  return { from: seg.start, speed, end: seg.end };
}

async function renderPageClip(base, page, out, { from, speed, end, dur }) {
  const p = await openPage(`${base}/video/${page}`);
  await renderFrames(p, { out, frames: Math.round(dur * FPS), fps: FPS, timeAt: (i) => Math.min(end ?? Infinity, from + (i / FPS) * speed) });
  await p.close();
}

async function renderCompose(base, spec, out, dur) {
  const p = await openPage(`${base}/video/compose.html`);
  await p.evaluate((s) => window.setSpec(s), spec);
  await renderFrames(p, { out, frames: Math.round(dur * FPS), fps: FPS, timeAt: (i) => i / FPS });
  await p.close();
}

async function readJs(name, globalName) {
  const f = path.join(VIDEO, name);
  if (!existsSync(f)) return null;
  const src = await readFile(f, 'utf8');
  const m = src.match(/=\s*([\s\S]*?);?\s*$/);
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
}

// ---------- the parts ----------
await mkdir(CLIPS, { recursive: true });
const srv = await serve(DESIGN);
const BASE = `http://127.0.0.1:${srv.address().port}`;
const parts = {};
const want = (k) => !ONLY || ONLY === k;

try {
  // 1. desk (10s + 0.5s handle for the push into the phone)
  const desk = scene('desk');
  const deskLen = desk.end - desk.start + 0.5;
  const deskRec = await findRecording('desk');
  if (want('desk') || want('texts')) {
    parts.desk = await cached('desk.mp4', { deskLen, deskRec }, deskRec ? [deskRec] : [], async (out) => {
      if (deskRec) {
        await ff(['-i', deskRec, '-t', String(deskLen), '-vf', `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${FPS},tpad=stop_mode=clone:stop_duration=${deskLen}`,
          '-an', '-c:v', 'libx264', '-crf', '15', '-pix_fmt', 'yuv420p', '-t', String(deskLen), out]);
      } else {
        const png = path.join(CLIPS, 'slate-desk.png');
        await still(slateHtml('Desk clip', 'recordings/desk.mov · 10s · Yoshua, the bill, phone up'), png, { alpha: false });
        await ff(['-loop', '1', '-i', png, '-t', String(deskLen), '-r', String(FPS), '-c:v', 'libx264', '-crf', '15', '-pix_fmt', 'yuv420p', out]);
      }
    });
  }

  // 2. texts: the iMessage screen up to "Calling your lender now"
  const texts = scene('texts');
  if (want('texts')) {
    const segs = await segmentsOf(BASE, 'imessage.html');
    const f = fit(segs.precall, texts.end - texts.start);
    parts.texts = await cached('texts.mp4', { f, dur: texts.end - texts.start }, pageFiles('imessage.html'), (out) =>
      renderPageClip(BASE, 'imessage.html', out, { ...f, dur: texts.end - texts.start }));
    // desk pushes into the phone
    parts.open = await cached('open.mp4', { a: parts.desk, b: parts.texts, v: 2, phone: TL.desk_phone_at }, [parts.desk, parts.texts], (out) =>
      // push in on the last 0.7s of the desk clip (toward where the phone is raised), then crossfade
      ff(['-i', parts.desk, '-i', parts.texts, '-filter_complex',
        `[0]zoompan=z='if(gte(on,${Math.round((deskLen - 0.7) * FPS)}),1+pow((on-${Math.round((deskLen - 0.7) * FPS)})/${Math.round(0.7 * FPS)},2)*0.8,1)':d=1:` +
        `x='iw*${TL.desk_phone_at?.[0] ?? 0.5}-(iw/zoom/2)':y='ih*${TL.desk_phone_at?.[1] ?? 0.5}-(ih/zoom/2)':s=1920x1080:fps=${FPS},settb=1/${FPS}[a];[1]settb=1/${FPS}[b];` +
        `[a][b]xfade=transition=fade:duration=0.5:offset=${deskLen - 0.5}[v]`,
        '-map', '[v]', '-c:v', 'libx264', '-crf', '15', '-pix_fmt', 'yuv420p', out]));
  }

  // 3. call: call thread + offer checker + the approval text inset
  const call = scene('call');
  const callLen = call.end - call.start;
  if (want('call')) {
    const segs = await segmentsOf(BASE, 'imessage.html');
    const ap = segs.approve;
    // the call card slides the lender cards left during the approval; the phone goes in the freed right side
    const cc = await openPage(`${BASE}/video/call-card.html`);
    await cc.waitForFunction(() => window.CALL_TIMES, null, { timeout: 15000 }).catch(() => {});
    const inset = await cc.evaluate(() => window.CALL_TIMES?.inset || null);
    await cc.close();
    const layers = [{ src: 'call-card.html', start: 0, end: callLen, map: [[0, callLen, 0, callLen]] }];
    if (existsSync(path.join(VIDEO, 'offer-checker.html'))) layers.push({ src: 'offer-checker.html', bg: 'none', start: 0, end: callLen, map: [[0, callLen, 0, callLen]] });
    if (ap && inset) {
      // where the phone sits on the iMessage stage, so it can be placed at the target rect
      const im = await openPage(`${BASE}/video/imessage.html?bg=none`);
      await im.evaluate((t) => new Promise((r) => { window.hold = t; requestAnimationFrame(() => requestAnimationFrame(r)); }), ap.start + 0.5);
      const ph = await im.evaluate(() => { const r = document.getElementById('phone').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      await im.close();
      const target = TL.call_inset_phone || { h: 528, right: 72 }; // about 244x528, right edge 72px in, centred vertically
      const s = target.h / ph.h;
      const px = 1920 - target.right - ph.w * s, py = (1080 - target.h) / 2;
      const box = [px - ph.x * s, py - ph.y * s, 1920 * s, 1080 * s];
      const a = inset.start, b = inset.end, len = ap.end - ap.start;
      layers.push({ src: 'imessage.html', bg: 'none', start: a, end: b, box,
        map: [[a, Math.min(b, a + len), ap.start, ap.start + Math.min(len, b - a)], [Math.min(b, a + len), b, ap.end, ap.end]],
        keys: [{ t: a, opacity: 0, y: 24 }, { t: a + 0.45, opacity: 1, y: 0 }, { t: b - 0.4, opacity: 1, y: 0 }, { t: b, opacity: 0, y: 0 }] });
    }
    parts.call = await cached('call.mp4', { layers, callLen }, pageFiles('call-card.html', 'offer-checker.html', 'imessage.html', 'compose.html'), (out) =>
      renderCompose(BASE, { bg: '#0b0b0c', layers }, out, callLen));
  }

  // 4. rest: the Done text, into the dashboard, through the Arena (62s to 112s)
  const doneS = scene('done'), restEnd = scene('arena').end, restLen = restEnd - doneS.start;
  if (want('rest')) {
    const msgSegs = await segmentsOf(BASE, 'imessage.html');
    const layers = [];
    const dashOk = existsSync(path.join(VIDEO, 'dash-scenes.html'));
    if (dashOk) {
      const ds = await segmentsOf(BASE, 'dash-scenes.html');
      const rel = (id) => [scene(id).start - doneS.start, scene(id).end - doneS.start];
      // a segment longer than its window plays faster to fit; a shorter one plays at 1x and holds its last frame
      const piece = (seg, [a, b]) => {
        const s = ds[seg];
        if (!s) return [];
        const len = s.end - s.start, win = b - a;
        if (len >= win) return [[a, b, s.start, s.end]];
        return [[a, a + len, s.start, s.end], [a + len, b, s.end, s.end]];
      };
      const greenAt = 2.0;
      const map = [piece('green', [greenAt, rel('done')[1]]), piece('home', rel('whatitis')), piece('health', rel('health')),
        piece('whatif', rel('whatif')), piece('activity', rel('activity')), piece('arena', rel('arena'))].flat();
      // the track tags land on the words that name them in Yoshua's line
      let dashSrc = 'dash-scenes.html';
      const wjf = path.join(CLIPS, 'whatitis.words.json');
      if (existsSync(wjf) && ds.home) {
        const ws = JSON.parse(await readFile(wjf, 'utf8')).transcription.map((x) => ({ w: x.text.trim().toLowerCase(), s: x.offsets.from / 1000 }));
        const find = (re) => ws.find((x) => re.test(x.w));
        const hits = [find(/^pnc/), find(/^nvidia/), find(/^photon/)];
        const built = find(/^built/);
        const pageAt = (x) => +(ds.home.start + 0.3 + x.s).toFixed(2);
        if (hits.every(Boolean)) dashSrc += `?tags=${hits.map(pageAt).join(',')}${built ? `&tagsfrom=${pageAt(built)}` : ''}`;
      }
      layers.push({ src: dashSrc, start: greenAt, end: restLen, map });
      // "eight accounts": the account row rises in under the health scores as the line starts
      if (existsSync(path.join(VIDEO, 'accounts.html'))) {
        const a = rel('health')[0] + (TL.accounts_at ?? 0.25);
        layers.push({ src: 'accounts.html', bg: 'none', start: a, end: a + 4.0, map: [[a, a + 4.0, 0, 4.0]] });
      }
    }
    if (msgSegs.done) {
      const d = msgSegs.done, len = 2.6;
      layers.push({ src: 'imessage.html', start: 0, end: len, map: [[0, len, d.start, Math.min(d.end, d.start + len)]],
        keys: [{ t: 0, opacity: 1, scale: 1 }, { t: 1.9, opacity: 1, scale: 1 }, { t: len, opacity: 0, scale: 1.18 }] });
    }
    parts.rest = await cached('rest.mp4', { layers, restLen }, pageFiles('imessage.html', 'dash-scenes.html', 'accounts.html', 'compose.html').concat(
      existsSync(path.join(VIDEO, 'media/dash')) ? (await readdir(path.join(VIDEO, 'media/dash'))).map((n) => path.join(VIDEO, 'media/dash', n)) : []), (out) =>
      renderCompose(BASE, { bg: '#f4f2ec', layers }, out, restLen));
  }

  // 5. close
  const close = scene('close');
  if (want('close')) {
    const len = close.end - close.start;
    parts.close = await cached('close.mp4', { len }, pageFiles('close.html'), async (out) => {
      if (existsSync(path.join(VIDEO, 'close.html'))) await renderPageClip(BASE, 'close.html', out, { from: 0, speed: 1, dur: len });
      else {
        const png = path.join(CLIPS, 'slate-close.png');
        await still(slateHtml('pacepay', 'close card'), png, { alpha: false });
        await ff(['-loop', '1', '-i', png, '-t', String(len), '-r', String(FPS), '-c:v', 'libx264', '-crf', '15', '-pix_fmt', 'yuv420p', out]);
      }
    });
  }

  if (ONLY) { log(`rendered ${ONLY}; run without --only to assemble`); process.exit(0); }

  // ---------- captions ----------
  const cues = [];
  if (desk.captions) cues.push(...desk.captions);
  else if (desk.caption) cues.push({ start: desk.caption_at?.[0] ?? 2.5, end: desk.caption_at?.[1] ?? 6, text: desk.caption });
  const voiceFiles = {};
  for (const s of TL.scenes.filter((s) => s.voice)) {
    const raw = await findRecording(path.parse(s.audio.replace('recordings/', '')).name);
    const start = s.start + 0.3;
    // break the line into short chunks at sentence or comma ends
    const chunks = [];
    for (const piece of s.voice.line.match(/[^.?!]+[.?!]?/g).map((x) => x.trim()).filter(Boolean)) {
      if (piece.length <= 64) { chunks.push(piece); continue; }
      let cur = '';
      for (const w of piece.split(/(?<=,)\s+/)) { if ((cur + ' ' + w).trim().length > 64 && cur) { chunks.push(cur.trim()); cur = w; } else cur = (cur + ' ' + w).trim(); }
      if (cur) chunks.push(cur);
    }
    if (!raw) {
      // no recording yet: time the chunks by length across the window
      const len = s.voice.max_seconds, total = chunks.reduce((n, c) => n + c.length, 0);
      let t = start;
      for (const c of chunks) { const d = (len * c.length) / total; cues.push({ start: +t.toFixed(2), end: +(t + d).toFixed(2), text: c }); t += d; }
      continue;
    }
    // trim the silence at both ends and clean it lightly, so speech starts right on the cue
    const vo = await cached(`${s.id}.vo.wav`, { v: 1 }, [raw], (out) => ff(['-i', raw, '-af',
      'silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.08,areverse,silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.15,areverse,highpass=f=80,afftdn=nf=-55:nr=10',
      '-ar', '48000', '-ac', '2', out]));
    voiceFiles[s.id] = vo;
    const len = Math.min(await duration(vo), s.end - start);
    if (len > s.end - start - 0.05) log(`${s.id}: recording runs past its window by ${(await duration(vo) - (s.end - start)).toFixed(2)}s, the end is cut`);
    // caption timing from the words actually spoken (whisper), else by length
    let words = null;
    try {
      const wj = await cached(`${s.id}.words.json`, { v: 1 }, [vo], async (out) => {
        const w16 = out + '.wav';
        await ff(['-i', vo, '-ar', '16000', '-ac', '1', w16]);
        const model = process.env.WHISPER_MODEL || path.join(process.env.HOME, 'Documents/ChatGPT/AP-animations/edit/dialogue/ggml-small.en.bin');
        await run('whisper-cli', ['-m', model, '-f', w16, '-ml', '1', '-sow', '-oj', '-of', out.replace(/\.json$/, '')], { maxBuffer: 1 << 24 });
      });
      const j = JSON.parse(await readFile(wj, 'utf8'));
      words = j.transcription.map((x) => ({ w: x.text.toLowerCase().replace(/[^a-z0-9]/g, ''), s: x.offsets.from / 1000, e: x.offsets.to / 1000 })).filter((x) => x.w);
    } catch { words = null; }
    const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    const total = chunks.reduce((n, c) => n + norm(c).length, 0);
    const wTot = words?.reduce((n, x) => n + x.w.length, 0) || 0;
    const timeAt = (frac) => {
      if (!words?.length) return frac * len;
      let acc = 0;
      for (const x of words) { const f0 = acc / wTot, f1 = (acc + x.w.length) / wTot; if (frac <= f1) return x.s + ((frac - f0) / (f1 - f0 || 1)) * (x.e - x.s); acc += x.w.length; }
      return words[words.length - 1].e;
    };
    let acc = 0;
    chunks.forEach((c, i) => {
      const a0 = timeAt(acc / total); acc += norm(c).length;
      const a1 = i === chunks.length - 1 ? Math.min(len, timeAt(1) + 0.4) : timeAt(acc / total);
      cues.push({ start: +(start + Math.max(0, a0 - 0.1)).toFixed(2), end: +(start + a1).toFixed(2), text: c });
    });
  }
  const capPngs = [];
  for (const [i, c] of cues.entries()) {
    const png = path.join(CLIPS, `cap-${i}.png`);
    await still(captionHtml(c.text), png);
    capPngs.push({ ...c, png });
  }

  // ---------- audio ----------
  const aIn = [], aFilt = [], voiceLabels = [], mainLabels = [];
  const addInput = (file) => { aIn.push('-i', file); return aIn.filter((x) => x === '-i').length; }; // 1-based after the video input
  if (deskRec && (await hasAudio(deskRec))) {
    const k = addInput(deskRec);
    aFilt.push(`[${k}:a]atrim=0:${desk.end - desk.start},asetpts=PTS-STARTPTS,volume=1.0[desk]`); voiceLabels.push('[desk]');
  }
  const callRec = await findRecording('call');
  if (callRec) {
    const k = addInput(callRec);
    const cutsFile = path.join(VIDEO, 'call-cuts.json');
    let cuts = existsSync(cutsFile) ? JSON.parse(await readFile(cutsFile, 'utf8')) : null;
    cuts = Array.isArray(cuts) ? cuts : cuts?.cuts;
    if (!cuts?.length) cuts = [{ in: 0, out: callLen }];
    // every piece gets a short fade in and out, so the joins don't click; then a light cleanup:
    // rumble cut, hiss reduction (noise floor measured at about -66 dB in the hold), presence kept
    const F = 0.025;
    cuts.forEach((c, j) => aFilt.push(`[${k}:a]atrim=${c.in}:${c.out},asetpts=PTS-STARTPTS,afade=t=in:d=${F},afade=t=out:st=${Math.max(0, c.out - c.in - F).toFixed(3)}:d=${F}[c${j}]`));
    aFilt.push(`${cuts.map((_, j) => `[c${j}]`).join('')}concat=n=${cuts.length}:v=0:a=1,atrim=0:${callLen},` +
      `highpass=f=85,afftdn=nf=-60:nr=14:nt=w,lowpass=f=9000,adelay=${call.start * 1000}:all=1,volume=${TL.audio_mix.call}[call]`);
    voiceLabels.push('[call]');
  }
  for (const s of TL.scenes.filter((s) => s.voice)) {
    const rec = voiceFiles[s.id];
    if (!rec) continue;
    const k = addInput(rec);
    aFilt.push(`[${k}:a]atrim=0:${s.end - s.start - 0.3},asetpts=PTS-STARTPTS,adelay=${Math.round((s.start + 0.3) * 1000)}:all=1,volume=${TL.audio_mix.voice}[v_${s.id}]`);
    voiceLabels.push(`[v_${s.id}]`);
  }
  const music = await findRecording('music');
  let audioOut = null;
  if (voiceLabels.length || music) {
    aFilt.push(`anullsrc=r=48000:cl=stereo,atrim=0:${TL.total}[sil]`);
    aFilt.push(`[sil]${voiceLabels.join('')}amix=inputs=${voiceLabels.length + 1}:normalize=0:duration=first[vraw]`);
    // voices are loudness-normalized on their own; the music then sits under them at a fixed level
    aFilt.push(`[vraw]loudnorm=I=${TL.audio_mix.loudness_lufs}:TP=-2:LRA=11,aresample=48000[voices]`);
    if (music) {
      // the music follows a level curve (timeline music.levels), not a fixed level:
      // silent under the desk clip and the call, present on the texts, faint under every voiceover,
      // up a little in the gaps between lines and into the dashboard, loud on the logo
      const lv = { texts: 0.38, transition: 0.34, under_voice: 0.09, close: 0.7, ramp: 0.4, ...(TL.music?.levels || {}) };
      const speech = [];
      for (const s of TL.scenes.filter((s) => s.voice && voiceFiles[s.id])) {
        const a = s.start + 0.3; speech.push([a, a + Math.min(await duration(voiceFiles[s.id]), s.end - 0.3 - s.start)]);
      }
      const texts = scene('texts'), callS = scene('call'), closeS = scene('close');
      const pts = [[0, 0], [texts.start - 0.4, 0], [texts.start + 0.4, lv.texts], [callS.start - 1.0, lv.texts], [callS.start - 0.1, 0],
        [callS.end, 0], [callS.end + 0.6, lv.transition]];
      for (const [a, b] of speech) pts.push([a - lv.ramp, lv.transition], [a, lv.under_voice], [b, lv.under_voice], [b + lv.ramp, lv.transition]);
      pts.push([closeS.start - 0.2, lv.transition], [closeS.start + 0.4, lv.close], [TL.total - 2.5, lv.close], [TL.total, 0]);
      pts.sort((p, q) => p[0] - q[0]);
      // keep the louder of overlapping ramps from being re-raised inside a speech interval
      const inSpeech = (t) => speech.some(([a, b]) => t >= a && t <= b);
      const gainAt = (t) => {
        if (inSpeech(t)) return lv.under_voice;
        let i = 0; while (i + 1 < pts.length && pts[i + 1][0] <= t) i++;
        const [t0, g0] = pts[i], [t1, g1] = pts[Math.min(i + 1, pts.length - 1)];
        return t1 > t0 ? g0 + ((t - t0) / (t1 - t0)) * (g1 - g0) : g0;
      };
      const SRe = 48000, n = Math.round(TL.total * SRe), env = Buffer.alloc(44 + n * 4);
      env.write('RIFF', 0); env.writeUInt32LE(36 + n * 4, 4); env.write('WAVEfmt ', 8); env.writeUInt32LE(16, 16); env.writeUInt16LE(1, 20);
      env.writeUInt16LE(2, 22); env.writeUInt32LE(SRe, 24); env.writeUInt32LE(SRe * 4, 28); env.writeUInt16LE(4, 32); env.writeUInt16LE(16, 34);
      env.write('data', 36); env.writeUInt32LE(n * 4, 40);
      for (let i = 0; i < n; i++) { const v = Math.round(Math.min(1, gainAt(i / SRe)) * 32767); env.writeInt16LE(v, 44 + i * 4); env.writeInt16LE(v, 46 + i * 4); }
      const envFile = path.join(CLIPS, 'music-envelope.wav');
      await writeFile(envFile, env);
      const k = addInput(music), ke = addInput(envFile);
      aFilt.push(`[${k}:a]atrim=0:${TL.total},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[mraw]`);
      aFilt.push(`[${ke}:a]aformat=sample_fmts=fltp:channel_layouts=stereo[menv]`);
      aFilt.push(`[mraw][menv]amultiply[mus]`);
      aFilt.push(`[voices][mus]amix=inputs=2:normalize=0:duration=first[mix]`);
    } else aFilt.push(`[voices]anull[mix]`);
    aFilt.push(`[mix]alimiter=limit=0.89:level=false,aresample=48000[aout]`);
    audioOut = '[aout]';
  }

  // ---------- assemble ----------
  const seq = [parts.open, parts.call, parts.rest, parts.close];
  const vIn = seq.flatMap((f) => ['-i', f]);
  const capIn = capPngs.flatMap((c) => ['-loop', '1', '-t', String(TL.total), '-i', c.png]);
  const nV = seq.length, nCap = capPngs.length;
  const vf = [`${seq.map((_, i) => `[${i}:v]`).join('')}concat=n=${nV}:v=1:a=0,fps=${FPS},format=yuv420p[base0]`];
  capPngs.forEach((c, j) => {
    vf.push(`[${nV + j}:v]format=rgba,fade=t=in:st=${c.start}:d=0.18:alpha=1,fade=t=out:st=${(c.end - 0.18).toFixed(2)}:d=0.18:alpha=1[cap${j}]`);
    vf.push(`[base${j}][cap${j}]overlay=0:0:enable='between(t,${c.start},${c.end})'[base${j + 1}]`);
  });
  // audio inputs come after video + caption inputs: renumber
  const offset = nV + nCap - 1;
  const aFix = aFilt.map((f) => f.replace(/\[(\d+):a\]/g, (_, k) => `[${Number(k) + offset}:a]`));
  const out = path.join(OUT, 'pacepay-demo.mp4');
  const filter = [...vf, ...aFix].join(';');
  await ff([...vIn, ...capIn, ...aIn, '-filter_complex', filter, '-map', `[base${nCap}]`, ...(audioOut ? ['-map', audioOut] : []),
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', ...(audioOut ? ['-c:a', 'aac', '-b:a', '192k'] : []),
    '-t', String(TL.total), '-movflags', '+faststart', out]);
  const d = await duration(out);
  log(`wrote ${path.relative(ROOT, out)} (${d.toFixed(2)}s${d > 120 ? ' — OVER 2:00' : ''})`);
  const missing = ['desk', 'call', 'yoshua-vo', 'ram-health', 'ram-whatif', 'ram-activity', 'ram-arena'];
  const have = await Promise.all(missing.map(findRecording));
  const still_missing = missing.filter((_, i) => !have[i]);
  if (still_missing.length) log(`placeholders used for: ${still_missing.join(', ')}`);
} finally {
  await closeBrowser();
  srv.close();
}
