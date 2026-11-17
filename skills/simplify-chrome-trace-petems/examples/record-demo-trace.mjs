#!/usr/bin/env node
// Record examples/demo-trace.json.gz from the local demo page.
//
// Launches a throwaway headless Chrome profile (no extensions, no history),
// serves examples/demo/ on 127.0.0.1, records a DevTools-style trace over the
// Chrome DevTools Protocol while clicking the demo buttons, then checks the
// trace for anything that should not be published before writing it.
//
// Usage: node examples/record-demo-trace.mjs [--chrome PATH] [--out FILE]
// Needs Node 22+ (global WebSocket) and a local Chrome or Chromium.

import { spawn } from 'node:child_process';
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

// Close to what the DevTools Performance panel records, minus screenshots
// (they would bloat the file without helping the summariser).
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

    const events = [];
    cdp.on('Tracing.dataCollected', (p) => events.push(...p.value));
    const done = new Promise((resolve) => cdp.on('Tracing.tracingComplete', resolve));

    const startTime = new Date().toISOString();
    await cdp.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordUntilFull', includedCategories: CATEGORIES },
    });
    await sleep(300);

    const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` }, sessionId);
    await loaded;
    await sleep(800);
    await click(cdp, sessionId, '#thrash');
    await sleep(600);
    await click(cdp, sessionId, '#crunch');
    await sleep(600);
    await click(cdp, sessionId, '#thrash');
    await sleep(800);

    await cdp.send('Tracing.end');
    await done;

    const kept = keepPageEvents(events, port);
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
      `Wrote ${outFile}: ${kept.length} of ${events.length} events kept, ${(portless.length / 1e6).toFixed(1)} MB raw, ${(gz.length / 1024).toFixed(0)} KB gzipped`,
    );
  } finally {
    cdp.close();
    chrome.kill();
    server.close();
    await sleep(300);
    rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`record-demo-trace: ${err.message}`);
  process.exitCode = 1;
});
