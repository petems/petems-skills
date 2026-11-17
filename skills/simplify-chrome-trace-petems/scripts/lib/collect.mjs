// Event collector: consumes raw trace events one at a time (as they stream
// out of the tokenizer) and keeps compact records only. Everything that
// depends on CLI options (window, thread choice) happens later in analyze.

const VITAL_NAMES = new Set([
  'navigationStart',
  'firstContentfulPaint',
  'largestContentfulPaint::Candidate',
  'LayoutShift',
  'MarkDOMContent',
  'MarkLoad',
]);

const NETWORK_NAMES = new Set([
  'ResourceSendRequest',
  'ResourceReceiveResponse',
  'ResourceReceivedData',
  'ResourceFinish',
]);

const FRAME_PROCESS_NAMES = new Set(['FrameCommittedInBrowser', 'ProcessReadyInBrowser']);

/** Async id: `id`, else `id2.local`, else `id2.global`. */
export function asyncId(ev) {
  if (ev.id !== undefined) return String(ev.id);
  const id2 = ev.id2;
  if (id2) {
    if (id2.local !== undefined) return 'l:' + id2.local;
    if (id2.global !== undefined) return 'g:' + id2.global;
  }
  return '';
}

export class TraceCollector {
  constructor() {
    this.eventCount = 0;
    this.origin = Infinity;
    this.maxEnd = -Infinity;
    this.tsBuf = new Float64Array(1 << 16);
    this.tsLen = 0;
    this.pids = new Map(); // pid -> Map(tid -> thread)
    this.threadList = [];
    this.processNames = new Map();
    this.strings = new Map();
    this.unmatchedE = 0;
    this.frames = []; // TracingStartedInBrowser frames
    this.frameProcesses = []; // {frame, processId}
    this.profiles = new Map(); // `${pid}|${id}` -> raw profile
    this.vitals = [];
    this.userTiming = [];
    this.timeStamps = [];
    this.eventTimings = [];
    this.network = new Map();
    this.websocket = [];
    this.nonObjects = 0;
  }

  _intern(s) {
    if (typeof s !== 'string') return '';
    const v = this.strings.get(s);
    if (v !== undefined) return v;
    this.strings.set(s, s);
    return s;
  }

  _thread(pid, tid) {
    let m = this.pids.get(pid);
    if (m === undefined) {
      m = new Map();
      this.pids.set(pid, m);
    }
    let th = m.get(tid);
    if (th === undefined) {
      th = { pid, tid, key: `${pid}:${tid}`, name: '', events: [], stack: [], durSum: 0 };
      m.set(tid, th);
      this.threadList.push(th);
    }
    return th;
  }

  _pushTs(ts) {
    if (this.tsLen === this.tsBuf.length) {
      const next = new Float64Array(this.tsBuf.length * 2);
      next.set(this.tsBuf);
      this.tsBuf = next;
    }
    this.tsBuf[this.tsLen++] = ts;
  }

  /** @param {any} ev */
  add(ev) {
    if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
      this.nonObjects++;
      return;
    }
    this.eventCount++;
    const ph = ev.ph;
    const name = ev.name;
    if (ph === 'M') {
      this._metadataEvent(ev);
      return;
    }
    const ts = ev.ts;
    if (typeof ts === 'number') {
      this._pushTs(ts);
      if (ts > 0 && ts < this.origin) this.origin = ts;
      const end = ph === 'X' && ev.dur > 0 ? ts + ev.dur : ts;
      if (end > this.maxEnd) this.maxEnd = end;
    }

    switch (ph) {
      case 'X': {
        if (typeof ts !== 'number') break;
        const dur = ev.dur > 0 ? ev.dur : 0;
        const th = this._thread(ev.pid, ev.tid);
        th.events.push({ name: this._intern(name), cat: this._intern(ev.cat), ts, dur });
        th.durSum += dur;
        break;
      }
      case 'B': {
        if (typeof ts !== 'number') break;
        const th = this._thread(ev.pid, ev.tid);
        th.stack.push({ name: this._intern(name), cat: this._intern(ev.cat), ts, dur: 0 });
        break;
      }
      case 'E': {
        if (typeof ts !== 'number') break;
        const th = this._thread(ev.pid, ev.tid);
        const open = th.stack.pop();
        if (open === undefined) {
          this.unmatchedE++;
          break;
        }
        open.dur = ts - open.ts > 0 ? ts - open.ts : 0;
        th.events.push(open);
        th.durSum += open.dur;
        break;
      }
      case 'P':
        if (name === 'Profile') this._profileHead(ev);
        else if (name === 'ProfileChunk') this._profileChunk(ev);
        break;
      default:
        break;
    }

    if (name === 'EventTiming') {
      if (ph === 'b') this._eventTiming(ev);
      return;
    }
    if (VITAL_NAMES.has(name)) this._vital(ev);
    else if (NETWORK_NAMES.has(name)) this._network(ev);
    else if (name === 'TimeStamp') this._timeStamp(ev);
    else if (name === 'TracingStartedInBrowser') this._tracingStarted(ev);
    else if (FRAME_PROCESS_NAMES.has(name)) this._frameProcess(ev);
    else if (typeof name === 'string' && name.startsWith('WebSocket')) this._websocket(ev);

    const cat = ev.cat;
    if (typeof cat === 'string' && cat.includes('blink.user_timing') && name !== 'navigationStart') {
      this._userTiming(ev);
    }
  }

  _metadataEvent(ev) {
    const n = ev.args && ev.args.name;
    if (ev.name === 'thread_name') {
      const th = this._thread(ev.pid, ev.tid);
      if (typeof n === 'string') th.name = n;
    } else if (ev.name === 'process_name') {
      if (typeof n === 'string') this.processNames.set(ev.pid, n);
    }
  }

  _rawProfile(pid, id, tid) {
    const key = `${pid}|${id}`;
    let p = this.profiles.get(key);
    if (p === undefined) {
      p = { pid, tid, id, startTime: null, nodes: new Map(), childParent: new Map(), samples: [], deltas: [] };
      this.profiles.set(key, p);
    }
    return p;
  }

  _profileHead(ev) {
    const p = this._rawProfile(ev.pid, asyncId(ev), ev.tid);
    p.tid = ev.tid;
    const data = ev.args && ev.args.data;
    if (data && typeof data.startTime === 'number') p.startTime = data.startTime;
    else if (p.startTime === null && typeof ev.ts === 'number') p.startTime = ev.ts;
  }

  _profileChunk(ev) {
    const p = this._rawProfile(ev.pid, asyncId(ev), ev.tid);
    const data = ev.args && ev.args.data;
    if (!data) return;
    const cp = data.cpuProfile || {};
    const nodes = cp.nodes;
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        if (!node || node.id === undefined) continue;
        const cf = node.callFrame || {};
        p.nodes.set(node.id, {
          functionName: typeof cf.functionName === 'string' ? cf.functionName : '',
          url: typeof cf.url === 'string' ? cf.url : '',
          lineNumber: typeof cf.lineNumber === 'number' ? cf.lineNumber : -1,
          columnNumber: typeof cf.columnNumber === 'number' ? cf.columnNumber : -1,
          codeType: typeof cf.codeType === 'string' ? cf.codeType : '',
          parent: node.parent !== undefined ? node.parent : null,
        });
        if (Array.isArray(node.children)) {
          for (const c of node.children) p.childParent.set(c, node.id);
        }
      }
    }
    const samples = cp.samples;
    const deltas = Array.isArray(data.timeDeltas) ? data.timeDeltas : cp.timeDeltas;
    if (Array.isArray(samples) && Array.isArray(deltas)) {
      const n = Math.min(samples.length, deltas.length);
      for (let i = 0; i < n; i++) {
        p.samples.push(samples[i]);
        p.deltas.push(typeof deltas[i] === 'number' ? deltas[i] : 0);
      }
    }
  }

  _eventTiming(ev) {
    const d = ev.args && ev.args.data;
    if (!d || !(d.interactionId > 0)) return;
    this.eventTimings.push({
      pid: ev.pid,
      ts: ev.ts,
      interactionId: d.interactionId,
      type: typeof d.type === 'string' ? d.type : '',
      duration: +d.duration || 0,
      timeStamp: +d.timeStamp || 0,
      processingStart: +d.processingStart || 0,
      processingEnd: +d.processingEnd || 0,
    });
  }

  _vital(ev) {
    const args = ev.args || {};
    const d = args.data || {};
    const rec = {
      name: ev.name,
      pid: ev.pid,
      tid: ev.tid,
      ts: ev.ts,
      frame: args.frame || d.frame || '',
    };
    if (ev.name === 'LayoutShift') {
      rec.score = +d.score || 0;
      rec.hadRecentInput = !!d.had_recent_input;
    } else if (ev.name === 'largestContentfulPaint::Candidate') {
      rec.size = d.size;
      rec.type = d.type;
      rec.nodeId = d.nodeId;
    } else if (ev.name === 'navigationStart') {
      rec.url = d.documentLoaderURL || '';
    }
    this.vitals.push(rec);
  }

  _network(ev) {
    const d = (ev.args && ev.args.data) || {};
    const id = d.requestId;
    if (id === undefined) return;
    let r = this.network.get(id);
    if (r === undefined) {
      r = {
        requestId: id,
        pid: ev.pid,
        url: '',
        method: '',
        priority: '',
        sendTs: null,
        responseTs: null,
        finishTs: null,
        status: null,
        mimeType: '',
        fromCache: false,
        fromServiceWorker: false,
        didFail: false,
        finishBytes: null,
        dataBytes: 0,
      };
      this.network.set(id, r);
    }
    switch (ev.name) {
      case 'ResourceSendRequest':
        if (r.sendTs === null) r.sendTs = ev.ts;
        if (d.url) r.url = d.url;
        if (d.requestMethod) r.method = d.requestMethod;
        if (d.priority) r.priority = d.priority;
        break;
      case 'ResourceReceiveResponse':
        r.responseTs = ev.ts;
        if (d.statusCode !== undefined) r.status = d.statusCode;
        if (d.mimeType) r.mimeType = d.mimeType;
        if (d.fromCache) r.fromCache = true;
        if (d.fromServiceWorker) r.fromServiceWorker = true;
        break;
      case 'ResourceReceivedData':
        if (typeof d.encodedDataLength === 'number') r.dataBytes += d.encodedDataLength;
        break;
      case 'ResourceFinish':
        r.finishTs = ev.ts;
        if (typeof d.encodedDataLength === 'number') r.finishBytes = d.encodedDataLength;
        if (d.didFail) r.didFail = true;
        break;
      default:
        break;
    }
  }

  _timeStamp(ev) {
    const d = (ev.args && ev.args.data) || {};
    this.timeStamps.push({
      pid: ev.pid,
      tid: ev.tid,
      ts: ev.ts,
      message: typeof d.message === 'string' ? d.message : String(d.message ?? ''),
    });
  }

  _tracingStarted(ev) {
    const frames = ev.args && ev.args.data && ev.args.data.frames;
    if (!Array.isArray(frames)) return;
    for (const f of frames) {
      if (!f) continue;
      this.frames.push({
        frame: f.frame,
        processId: f.processId,
        parent: f.parent,
        isOutermostMainFrame: !!f.isOutermostMainFrame,
        isInPrimaryMainFrame: !!f.isInPrimaryMainFrame,
        url: f.url || '',
      });
    }
  }

  _frameProcess(ev) {
    const d = ev.args && ev.args.data;
    if (!d || d.frame === undefined || d.processId === undefined) return;
    this.frameProcesses.push({ frame: d.frame, processId: d.processId });
  }

  _websocket(ev) {
    const d = (ev.args && ev.args.data) || {};
    this.websocket.push({
      name: ev.name,
      pid: ev.pid,
      ts: ev.ts,
      identifier: d.identifier,
      url: typeof d.url === 'string' ? d.url : '',
    });
  }

  _userTiming(ev) {
    const ph = ev.ph;
    const d = (ev.args && ev.args.data) || {};
    this.userTiming.push({
      ph,
      name: typeof ev.name === 'string' ? ev.name : '',
      cat: ev.cat,
      pid: ev.pid,
      tid: ev.tid,
      ts: ev.ts,
      dur: ph === 'X' && ev.dur > 0 ? ev.dur : 0,
      id: ph === 'b' || ph === 'e' || ph === 'n' ? asyncId(ev) : '',
      hasStartTime: d.startTime !== undefined,
    });
  }

  /** Finalise into an immutable-ish model. */
  finish() {
    let unclosed = 0;
    const threads = [];
    for (const th of this.threadList) {
      unclosed += th.stack.length;
      threads.push({
        pid: th.pid,
        tid: th.tid,
        key: th.key,
        name: th.name,
        processName: this.processNames.get(th.pid) || '',
        events: th.events,
        durSum: th.durSum,
      });
      th.stack = [];
    }
    const warnings = [];
    if (unclosed > 0) warnings.push(`${unclosed} unclosed B event(s) at end of trace were dropped`);
    if (this.unmatchedE > 0) warnings.push(`${this.unmatchedE} E event(s) without a matching B were ignored`);
    if (this.nonObjects > 0) warnings.push(`${this.nonObjects} non-object entries in traceEvents were ignored`);
    const origin = Number.isFinite(this.origin) ? this.origin : 0;
    return {
      eventCount: this.eventCount,
      origin,
      maxEnd: Number.isFinite(this.maxEnd) ? Math.max(this.maxEnd, origin) : origin,
      ts: this.tsBuf.subarray(0, this.tsLen),
      threads,
      frames: this.frames,
      frameProcesses: this.frameProcesses,
      profiles: [...this.profiles.values()],
      vitals: this.vitals,
      userTiming: this.userTiming,
      timeStamps: this.timeStamps,
      eventTimings: this.eventTimings,
      network: [...this.network.values()],
      websocket: this.websocket,
      warnings,
    };
  }
}

/** Collect an in-memory array of events (tests, small inputs). */
export function collectEvents(events) {
  const c = new TraceCollector();
  for (const ev of events) c.add(ev);
  return c.finish();
}
