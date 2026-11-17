// In-memory synthetic trace builder for tests. Times are µs unless noted.

import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PID = 100;
export const TID = 1;
export const BASE = 1_000_000; // trace origin in µs

export class TraceBuilder {
  constructor() {
    this.events = [];
    this.metadata = null;
    this.nextId = 1;
  }

  push(ev) {
    this.events.push(ev);
    return this;
  }

  threadName(pid, tid, name) {
    return this.push({ ph: 'M', name: 'thread_name', pid, tid, ts: 0, args: { name } });
  }

  processName(pid, name) {
    return this.push({ ph: 'M', name: 'process_name', pid, tid: 0, ts: 0, args: { name } });
  }

  /** Standard renderer main thread at PID/TID. */
  mainThread(pid = PID, tid = TID) {
    return this.threadName(pid, tid, 'CrRendererMain');
  }

  tracingStarted(frames, { pid = 1, tid = 1, ts = BASE } = {}) {
    return this.push({ ph: 'I', name: 'TracingStartedInBrowser', cat: 'disabled-by-default-devtools.timeline', pid, tid, ts, s: 't', args: { data: { frames } } });
  }

  x(name, ts, dur, { pid = PID, tid = TID, cat = 'devtools.timeline', args } = {}) {
    const ev = { ph: 'X', name, cat, pid, tid, ts, dur };
    if (args) ev.args = args;
    return this.push(ev);
  }

  begin(name, ts, { pid = PID, tid = TID, cat = 'devtools.timeline' } = {}) {
    return this.push({ ph: 'B', name, cat, pid, tid, ts });
  }

  end(ts, { pid = PID, tid = TID, name } = {}) {
    const ev = { ph: 'E', pid, tid, ts };
    if (name) ev.name = name;
    return this.push(ev);
  }

  instant(name, ts, { pid = PID, tid = TID, cat = 'devtools.timeline', args, ph = 'I' } = {}) {
    const ev = { ph, name, cat, pid, tid, ts, s: 't' };
    if (args) ev.args = args;
    return this.push(ev);
  }

  asyncBegin(name, ts, id, { pid = PID, tid = TID, cat = 'blink', args } = {}) {
    const ev = { ph: 'b', name, cat, pid, tid, ts, id };
    if (args) ev.args = args;
    return this.push(ev);
  }

  asyncEnd(name, ts, id, { pid = PID, tid = TID, cat = 'blink' } = {}) {
    return this.push({ ph: 'e', name, cat, pid, tid, ts, id });
  }

  /**
   * CPU profile. `nodes`: [{id, parent?, children?, functionName, url?, lineNumber?, columnNumber?}]
   * `samples` / `deltas` are split across `chunks` ProfileChunk events.
   * Nodes are declared in the chunk where they are first needed unless `nodesInFirstChunk`.
   */
  profile({ pid = PID, tid = TID, id = '0x1', startTime = BASE, nodes, samples, deltas, chunks = 1, deltasInCpuProfile = false, useChildren = false }) {
    this.push({ ph: 'P', name: 'Profile', cat: 'disabled-by-default-v8.cpu_profiler', pid, tid, ts: startTime, id, args: { data: { startTime } } });
    const toNode = (n) => {
      const out = {
        id: n.id,
        callFrame: {
          functionName: n.functionName ?? '',
          url: n.url ?? '',
          scriptId: n.scriptId ?? 0,
          codeType: n.codeType ?? (n.url ? 'JS' : 'other'),
        },
      };
      if (n.lineNumber !== undefined) out.callFrame.lineNumber = n.lineNumber;
      if (n.columnNumber !== undefined) out.callFrame.columnNumber = n.columnNumber;
      if (useChildren) {
        const kids = nodes.filter((k) => k.parent === n.id).map((k) => k.id);
        if (kids.length) out.children = kids;
      } else if (n.parent !== undefined) out.parent = n.parent;
      return out;
    };
    const per = Math.ceil(samples.length / chunks);
    const nodeChunks = [];
    for (let c = 0; c < chunks; c++) nodeChunks.push([]);
    // spread node declarations: first half in chunk 0, rest in last chunk (parents may precede)
    nodes.forEach((n, i) => nodeChunks[useChildren || chunks === 1 ? 0 : i < nodes.length / 2 ? 0 : chunks - 1].push(toNode(n)));
    for (let c = 0; c < chunks; c++) {
      const s = samples.slice(c * per, (c + 1) * per);
      const d = deltas.slice(c * per, (c + 1) * per);
      const cpuProfile = { nodes: nodeChunks[c], samples: s };
      const data = { cpuProfile };
      if (deltasInCpuProfile) cpuProfile.timeDeltas = d;
      else data.timeDeltas = d;
      this.push({ ph: 'P', name: 'ProfileChunk', cat: 'disabled-by-default-v8.cpu_profiler', pid, tid, ts: startTime + 1 + c, id, args: { data } });
    }
    return this;
  }

  request({ requestId, url, sendTs, responseTs, finishTs, status = 200, method = 'GET', finishBytes, dataChunks = [], didFail = false, pid = PID, tid = TID, mimeType = 'text/html' }) {
    this.instant('ResourceSendRequest', sendTs, { pid, tid, args: { data: { requestId, url, requestMethod: method, priority: 'High' } } });
    if (responseTs !== undefined) {
      this.instant('ResourceReceiveResponse', responseTs, { pid, tid, args: { data: { requestId, statusCode: status, mimeType, fromCache: false, fromServiceWorker: false } } });
    }
    let t = responseTs ?? sendTs;
    for (const bytes of dataChunks) this.instant('ResourceReceivedData', ++t, { pid, tid, args: { data: { requestId, encodedDataLength: bytes } } });
    if (finishTs !== undefined) {
      const data = { requestId, didFail };
      if (finishBytes !== undefined) data.encodedDataLength = finishBytes;
      this.instant('ResourceFinish', finishTs, { pid, tid, args: { data } });
    }
    return this;
  }

  /** EventTiming begin + end. Fields in ms (as Chrome emits them). */
  eventTiming(ts, { interactionId, type = 'pointerdown', duration, timeStamp = 0, processingStart, processingEnd, pid = PID, tid = TID }) {
    const id = `0x${(this.nextId++).toString(16)}`;
    this.asyncBegin('EventTiming', ts, id, {
      pid,
      tid,
      cat: 'devtools.timeline',
      args: { data: { interactionId, type, duration, timeStamp, processingStart, processingEnd, frame: 'F1', nodeId: 1 } },
    });
    return this.asyncEnd('EventTiming', ts + duration * 1000, id, { pid, tid, cat: 'devtools.timeline' });
  }

  mark(name, ts, { pid = PID, tid = TID } = {}) {
    return this.instant(name, ts, { pid, tid, ph: 'R', cat: 'blink.user_timing', args: { data: { startTime: (ts - BASE) / 1000 } } });
  }

  measure(name, ts, dur, { pid = PID, tid = TID } = {}) {
    const id = `0x${(this.nextId++).toString(16)}`;
    this.asyncBegin(name, ts, id, { pid, tid, cat: 'blink.user_timing', args: { startTime: (ts - BASE) / 1000 } });
    return this.asyncEnd(name, ts + dur, id, { pid, tid, cat: 'blink.user_timing' });
  }

  timeStamp(message, ts, { pid = PID, tid = TID } = {}) {
    return this.instant('TimeStamp', ts, { pid, tid, args: { data: { message } } });
  }

  websocket(identifier, url, events, { pid = PID, tid = TID } = {}) {
    for (const [name, ts] of events) {
      const data = { identifier };
      if (name === 'WebSocketCreate') data.url = url;
      this.instant(name, ts, { pid, tid, args: { data } });
    }
    return this;
  }

  setMetadata(m) {
    this.metadata = m;
    return this;
  }

  /** JSON text. shape: 'object' | 'metadata-last' | 'array' | 'truncated' */
  toJSON(shape = 'object') {
    if (shape === 'array') return JSON.stringify(this.events);
    if (shape === 'truncated') {
      const s = '[\n' + this.events.map((e) => JSON.stringify(e)).join(',\n');
      return s + ',\n';
    }
    const ev = '"traceEvents": [\n' + this.events.map((e) => JSON.stringify(e)).join(',\n') + '\n]';
    if (!this.metadata) return `{${ev}}`;
    const md = `"metadata": ${JSON.stringify(this.metadata, null, 2)}`;
    return shape === 'metadata-last' ? `{${ev},\n${md}}\n` : `{${md},\n${ev}}\n`;
  }
}

/** Write text to a fresh temp dir; returns the path. */
export function writeTemp(name, content, { gzip = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'simplify-chrome-trace-test-'));
  const path = join(dir, name);
  writeFileSync(path, gzip ? gzipSync(Buffer.from(content)) : content);
  return path;
}

/** A small but rich trace that exercises most sections. */
export function richTrace() {
  const b = new TraceBuilder();
  b.processName(PID, 'Renderer');
  b.mainThread();
  b.threadName(PID, 2, 'DedicatedWorker thread');
  b.threadName(1, 1, 'CrBrowserMain');
  b.tracingStarted([{ frame: 'F1', processId: PID, isOutermostMainFrame: true, isInPrimaryMainFrame: true, url: 'https://example.com/' }]);
  b.instant('navigationStart', BASE + 1000, { cat: 'blink.user_timing', args: { frame: 'F1', data: { documentLoaderURL: 'https://example.com/', isLoadingMainFrame: true } } });
  // long task 0..120ms with children
  b.x('RunTask', BASE + 10_000, 120_000);
  b.x('FunctionCall', BASE + 11_000, 80_000);
  b.x('UpdateLayoutTree', BASE + 95_000, 30_000);
  // short task
  b.x('RunTask', BASE + 200_000, 10_000);
  b.x('ParseHTML', BASE + 201_000, 5_000);
  // profiler artifact task
  b.x('RunTask', BASE + 300_000, 600_000);
  b.x('CpuProfiler::StartProfiling', BASE + 300_000, 590_000);
  // worker activity
  b.x('RunTask', BASE + 50_000, 70_000, { tid: 2 });
  b.instant('firstContentfulPaint', BASE + 150_000, { cat: 'loading', args: { frame: 'F1' } });
  b.instant('largestContentfulPaint::Candidate', BASE + 160_000, { cat: 'loading', args: { frame: 'F1', data: { size: 5000, type: 'image', nodeId: 7 } } });
  b.instant('LayoutShift', BASE + 170_000, { args: { frame: 'F1', data: { score: 0.05, had_recent_input: false } } });
  b.instant('MarkDOMContent', BASE + 180_000, { args: { frame: 'F1', data: {} } });
  b.instant('MarkLoad', BASE + 190_000, { args: { frame: 'F1', data: {} } });
  b.eventTiming(BASE + 400_000, { interactionId: 5, type: 'pointerdown', duration: 40, timeStamp: 400, processingStart: 410, processingEnd: 420 });
  b.eventTiming(BASE + 400_500, { interactionId: 5, type: 'click', duration: 120, timeStamp: 400, processingStart: 430, processingEnd: 500 });
  b.mark('app:start', BASE + 5_000);
  b.measure('app:boot', BASE + 5_000, 50_000);
  b.timeStamp('hello', BASE + 6_000);
  b.request({ requestId: 'r1', url: 'https://example.com/app.js?v=1', sendTs: BASE + 2_000, responseTs: BASE + 22_000, finishTs: BASE + 42_000, finishBytes: 2048 });
  b.websocket(1, 'wss://example.com/socket', [['WebSocketCreate', BASE + 3_000], ['WebSocketSendHandshakeRequest', BASE + 3_500], ['WebSocketReceiveHandshakeResponse', BASE + 4_500]]);
  b.profile({
    startTime: BASE + 10_000,
    nodes: [
      { id: 1, functionName: '(root)' },
      { id: 2, parent: 1, functionName: '(program)' },
      { id: 3, parent: 1, functionName: '(idle)' },
      { id: 4, parent: 1, functionName: 'main', url: 'https://example.com/app.js?v=1', lineNumber: 9, columnNumber: 4 },
      { id: 5, parent: 4, functionName: 'heavy', url: 'https://example.com/app.js?v=1', lineNumber: 19, columnNumber: 0 },
      { id: 6, parent: 1, functionName: '(garbage collector)' },
    ],
    samples: [5, 5, 5, 4, 2, 6, 3, 3],
    deltas: [0, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000],
  });
  b.setMetadata({ source: 'DevTools', startTime: '2025-01-02T03:04:05.000Z', modifications: { initialBreadcrumb: { window: { min: BASE, max: BASE + 250_000, range: 250_000 } } } });
  return b;
}
