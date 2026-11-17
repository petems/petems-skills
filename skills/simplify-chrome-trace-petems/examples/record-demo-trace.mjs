#!/usr/bin/env node
// Record examples/demo-trace.json.gz (and a screen recording of the same
// session) from the local demo page.
//
// Launches a throwaway headless Chrome profile (no extensions, no history),
// serves examples/demo/ on 127.0.0.1, records a DevTools-style trace over the
// Chrome DevTools Protocol while clicking the demo buttons, then checks the
// trace for anything that should not be published before writing it.
//
// The video is captured in the same session as the trace with the CDP
// screencast (headless Chrome does not put filmstrip screenshots into the
// trace). Frames are encoded to demo-recording.mp4 / .gif with ffmpeg, so the
// video and the trace describe exactly the same run. The screencast adds a
// little browser-side overhead to the recording.
//
// Usage: node examples/record-demo-trace.mjs [--chrome PATH] [--out FILE] [--no-video]
// Needs Node 22+ (global WebSocket), a local Chrome or Chromium, and ffmpeg
// on PATH for the video.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir, hostname, userInfo } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const outFile = argValue('--out') || join(here, 'demo-trace.json.gz');
const chromePath = argValue('--chrome') || process.env.CHROME_PATH || findChrome();
const wantVideo = !args.includes('--no-video');
const VIEWPORT = { width: 720, height: 400 };

// Close to what the DevTools Performance panel records, minus screenshots.
const CATEGORIES = [
  '-*',
  'blink.console',
  'blink.user_timing',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-v8.cpu_profiler',
  'latencyInfo',
  'loading',
  'toplevel',
  'v8.execute',
  'v8',
];

function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((p) => existsSync(p));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serveDemo() {
  const types = { '.html': 'text/html', '.json': 'application/json' };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/slow.json') {
      await sleep(400); // a deliberately slow endpoint for the network section
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"slow": true}\n');
      return;
    }
    const file = join(here, 'demo', path === '/' ? 'index.html' : path.slice(1));
    if (!file.startsWith(join(here, 'demo')) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launchChrome(profileDir) {
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--window-size=1200,800',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start within 15s')), 15000);
    chrome.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    chrome.on('exit', (code) => reject(new Error(`Chrome exited early (code ${code})`)));
  });
  return { chrome, wsUrl };
}

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) || []) fn(msg.params, msg.sessionId);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return {
    ready,
    send(method, params = {}, sessionId) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    close: () => ws.close(),
  };
}

async function click(cdp, sessionId, selector) {
  const { result } = await cdp.send(
    'Runtime.evaluate',
    {
      expression: `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
      returnByValue: true,
    },
    sessionId,
  );
  const [x, y] = result.value;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
  }
}

// Browser-wide activity (other profiles' services, enterprise policy fetches,
// component extensions) must not end up in a public file. Keep the demo
// page's renderer process, plus the few browser-process events the
// summariser uses to find that renderer.
const BROWSER_ALLOWLIST = new Set(['TracingStartedInBrowser', 'FrameCommittedInBrowser', 'ProcessReadyInBrowser']);

function keepPageEvents(events, port) {
  // The renderer that committed the demo URL is the page's process. Over
  // CDP, TracingStartedInBrowser carries no frame list, so use CommitLoad
  // (renderer side) and FrameCommittedInBrowser (browser side) instead.
  const origin = `http://127.0.0.1:${port}/`;
  const pagePids = new Set();
  for (const e of events) {
    const d = e.args?.data || {};
    if (e.name === 'CommitLoad' && String(d.url || '').startsWith(origin)) pagePids.add(e.pid);
    if (e.name === 'FrameCommittedInBrowser' && String(d.url || '').startsWith(origin) && d.processId) {
      pagePids.add(d.processId);
    }
  }
  if (!pagePids.size) throw new Error('Could not find the demo page renderer process in the trace');
  const kept = [];
  for (const e of events) {
    if (pagePids.has(e.pid)) kept.push(e);
    else if (BROWSER_ALLOWLIST.has(e.name)) kept.push(scrubBrowserEvent(e, port));
  }
  return kept;
}

// TracingStartedInBrowser lists every frame in the browser; keep only ours.
function scrubBrowserEvent(e, port) {
  const frames = e.args?.data?.frames;
  if (!Array.isArray(frames)) return e;
  const ours = frames.filter((f) => String(f.url || '').startsWith(`http://127.0.0.1:${port}/`));
  return { ...e, args: { ...e.args, data: { ...e.args.data, frames: ours } } };
}

function reportDropped(events, kept) {
  const keptSet = new Set(kept);
  const byName = new Map();
  for (const e of events) {
    if (keptSet.has(e)) continue;
    byName.set(e.name, (byName.get(e.name) || 0) + 1);
  }
  const top = [...byName].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.error(`Dropped ${events.length - kept.length} browser-wide events. Top names: ${top.map(([n, c]) => `${n} ${c}`).join(', ')}`);
}

// Anything here in the output means the trace is not safe to publish.
function privacyProblems(text, port) {
  const problems = [];
  const needles = [
    ['home directory', homedir()],
    ['username', userInfo().username],
    ['hostname', hostname()],
    ['temp profile path', tmpdir()],
  ];
  for (const [label, value] of needles) {
    if (value && value.length >= 3 && text.includes(value)) problems.push(`${label} (${value})`);
  }
  if (/chrome-extension:\/\//.test(text)) problems.push('a chrome-extension:// URL');
  const urls = text.match(/\b(?:https?|wss?):\/\/[^\s"'\\)]+/g) || [];
  const origin = `http://127.0.0.1:${port}`;
  const foreign = [...new Set(urls)].filter((u) => u !== origin && !u.startsWith(`${origin}/`));
  if (foreign.length) problems.push(`non-demo URLs: ${foreign.slice(0, 5).join(', ')}`);
  return problems;
}

async function main() {
  if (!chromePath) throw new Error('No Chrome found. Pass --chrome PATH or set CHROME_PATH.');
  const server = await serveDemo();
  const port = server.address().port;
  const profileDir = mkdtempSync(join(tmpdir(), 'demo-trace-profile-'));
  const { chrome, wsUrl } = await launchChrome(profileDir);
  const cdp = cdpClient(wsUrl);
  try {
    await cdp.ready;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false }, sessionId);

    const events = [];
    cdp.on('Tracing.dataCollected', (p) => events.push(...p.value));
    const done = new Promise((resolve) => cdp.on('Tracing.tracingComplete', resolve));

    // Screencast frames arrive only after each one is acknowledged.
    const screenshots = [];
    cdp.on('Page.screencastFrame', (p, sid) => {
      screenshots.push({ ts: p.metadata.timestamp * 1e6, data: p.data });
      cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sid).catch(() => {});
    });
    if (wantVideo) {
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, ...{ maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height } }, sessionId);
    }

    const startTime = new Date().toISOString();
    await cdp.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordUntilFull', includedCategories: CATEGORIES },
    });
    await sleep(300);

    const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` }, sessionId);
    await loaded;
    // Pauses are long enough for a viewer to see smooth motion between the
    // freezes.
    await sleep(1800);
    await click(cdp, sessionId, '#thrash');
    await sleep(1800);
    await click(cdp, sessionId, '#crunch');
    await sleep(1500);
    await click(cdp, sessionId, '#thrash');
    await sleep(1800);

    if (wantVideo) await cdp.send('Page.stopScreencast', {}, sessionId);
    await cdp.send('Tracing.end');
    await done;

    const traceEvents = events;
    const kept = keepPageEvents(traceEvents, port);
    if (process.env.DEBUG_DROPPED) reportDropped(events, kept);
    const trace = { metadata: { source: 'record-demo-trace.mjs', startTime }, traceEvents: kept };
    const text = JSON.stringify(trace);
    const problems = privacyProblems(text, port);
    if (problems.length) throw new Error(`Refusing to write trace, it contains: ${problems.join('; ')}`);

    // Replace the random port so re-recordings diff cleanly.
    const portless = text.replaceAll(`127.0.0.1:${port}`, '127.0.0.1:8080');
    const gz = gzipSync(portless, { level: 9 });
    writeFileSync(outFile, gz);
    console.log(
      `Wrote ${outFile}: ${kept.length} of ${traceEvents.length} events kept, ${(portless.length / 1e6).toFixed(1)} MB raw, ${(gz.length / 1024).toFixed(0)} KB gzipped`,
    );
    if (wantVideo) writeVideo(screenshots, join(dirname(outFile), 'demo-recording'));
  } finally {
    cdp.close();
    chrome.kill();
    server.close();
    await sleep(300);
    rmSync(profileDir, { recursive: true, force: true });
  }
}

// Encode the screencast frames into an MP4 and a GIF. Frames are only
// captured when the screen changes, so each one is held until the next.
function writeVideo(screenshots, basePath) {
  if (!screenshots.length) throw new Error('The screencast captured no frames, so there is no video to write');
  const ffmpeg = spawnSync('ffmpeg', ['-version']);
  if (ffmpeg.status !== 0) throw new Error('ffmpeg not found on PATH (or pass --no-video)');
  const frames = screenshots.slice().sort((a, b) => a.ts - b.ts);
  const dir = mkdtempSync(join(tmpdir(), 'demo-frames-'));
  try {
    const list = [];
    frames.forEach((f, i) => {
      const name = `f${String(i).padStart(5, '0')}.jpg`;
      writeFileSync(join(dir, name), Buffer.from(f.data, 'base64'));
      const next = frames[i + 1];
      const secs = next ? (next.ts - f.ts) / 1e6 : 1;
      list.push(`file '${name}'`, `duration ${secs.toFixed(6)}`);
    });
    // The concat demuxer ignores the last duration unless the file repeats.
    list.push(`file 'f${String(frames.length - 1).padStart(5, '0')}.jpg'`);
    writeFileSync(join(dir, 'frames.txt'), list.join('\n') + '\n');
    const input = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt')];
    const run = (extra) => {
      const r = spawnSync('ffmpeg', [...input, ...extra], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
    };
    run(['-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', '-movflags', '+faststart', `${basePath}.mp4`]);
    run(['-vf', 'fps=15,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none', `${basePath}.gif`]);
    const kb = (p) => (readFileSync(p).length / 1024).toFixed(0);
    const secs = (frames[frames.length - 1].ts - frames[0].ts) / 1e6;
    console.log(`Wrote ${basePath}.mp4 (${kb(`${basePath}.mp4`)} KB) and .gif (${kb(`${basePath}.gif`)} KB): ${frames.length} frames, ${secs.toFixed(1)} s`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`record-demo-trace: ${err.message}`);
  process.exitCode = 1;
});
