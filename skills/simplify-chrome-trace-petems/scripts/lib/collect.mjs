// Event collector: consumes raw trace events one at a time (as they stream
// out of the tokenizer) and keeps compact records only. Everything that
// depends on CLI options (window, thread choice) happens later in analyze.

import { cleanText } from './format.mjs';

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
    this.network = []; // compact Resource* events, assembled in finish()
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
    const cat = ev.cat;
    const isUserTiming = typeof cat === 'string' && cat.includes('blink.user_timing');
    // A user performance.measure() is b/e (or X) in blink.user_timing. Even if
    // it is named like a vital (say `navigationStart`), it is not one: only
    // native instant marks count as vitals.
    const isUserMeasure = isUserTiming && (ev.ph === 'b' || ev.ph === 'e' || ev.ph === 'X');
    if (VITAL_NAMES.has(name) && !isUserMeasure) this._vital(ev);
    else if (NETWORK_NAMES.has(name)) this._network(ev);
    else if (name === 'TimeStamp') this._timeStamp(ev);
    else if (name === 'TracingStartedInBrowser') this._tracingStarted(ev);
    else if (FRAME_PROCESS_NAMES.has(name)) this._frameProcess(ev);
    else if (typeof name === 'string' && name.startsWith('WebSocket')) this._websocket(ev);

    // The native navigationStart mark is a vital, not user timing; a user
    // measure with that name is user timing.
    if (isUserTiming && (name !== 'navigationStart' || isUserMeasure)) {
      this._userTiming(ev);
    }
  }

  _metadataEvent(ev) {
    const n = ev.args && ev.args.name;
    if (ev.name === 'thread_name') {
      const th = this._thread(ev.pid, ev.tid);
      // Thread and process names come from the trace and end up in report
      // prose (headings, the summary), not only table cells, so clean them
      // once here.
      if (typeof n === 'string') th.name = cleanText(n);
    } else if (ev.name === 'process_name') {
      if (typeof n === 'string') this.processNames.set(ev.pid, cleanText(n));
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

  // Network events are buffered as compact records and assembled in finish(),
  // once thread names say which processes are renderers. Chrome request ids
  // are only unique per process, so two renderers (tabs) may reuse one; but a
  // single request can also span processes (the browser emits a navigation's
  // send, the renderer its response), so a bare pid|id key would split it.
  _network(ev) {
    const d = (ev.args && ev.args.data) || {};
    const id = d.requestId;
    if (id === undefined) return;
    const e = { pid: ev.pid, name: ev.name, ts: ev.ts, requestId: id, frame: typeof d.frame === 'string' ? d.frame : '' };
    switch (ev.name) {
      case 'ResourceSendRequest':
        e.url = d.url;
        e.method = d.requestMethod;
        e.priority = d.priority;
        break;
      case 'ResourceReceiveResponse':
        e.status = d.statusCode;
        e.mimeType = d.mimeType;
        e.fromCache = !!d.fromCache;
        e.fromServiceWorker = !!d.fromServiceWorker;
        break;
      case 'ResourceReceivedData':
      case 'ResourceFinish':
        e.bytes = d.encodedDataLength;
        e.didFail = !!d.didFail;
        break;
      default:
        break;
    }
    this.network.push(e);
  }

  /**
   * Assemble request records. Each renderer's events for a request id form
   * their own record. Events from other processes (browser, network service)
   * are first split into request instances (see nonRendererInstances), then
   * each instance joins the renderer record for that id whose frame matches,
   * else the only renderer record for that id when either side has no frame.
   * A renderer record takes at most one instance; every other instance is a
   * record of its own, so two requests' URL, method and timing never merge.
   */
  _buildNetwork(renderers) {
    const byId = new Map(); // requestId -> Map(renderer pid -> first frame)
    const others = new Map(); // requestId -> non-renderer events
    for (const e of this.network) {
      if (renderers.has(e.pid)) {
        let m = byId.get(e.requestId);
        if (m === undefined) byId.set(e.requestId, (m = new Map()));
        if (!m.get(e.pid)) m.set(e.pid, e.frame);
      } else {
        let list = others.get(e.requestId);
        if (list === undefined) others.set(e.requestId, (list = []));
        list.push(e);
      }
    }
    const ownerOf = new Map(); // non-renderer event -> { key, pid }
    for (const [id, events] of others) {
      const m = byId.get(id);
      const claimed = new Set();
      nonRendererInstances(events).forEach((inst, n) => {
        let owner = { key: JSON.stringify(['own', inst.events[0].pid, id, n]), pid: inst.events[0].pid };
        if (m && !inst.ambiguous) {
          const free = [...m].filter(([p]) => !claimed.has(p));
          let hit = inst.frame ? free.find(([, rf]) => rf === inst.frame) : undefined;
          if (!hit && m.size === 1 && free.length === 1 && (!inst.frame || !free[0][1])) hit = free[0];
          if (hit) {
            claimed.add(hit[0]);
            owner = { key: JSON.stringify(['renderer', hit[0], id]), pid: hit[0] };
          }
        }
        for (const e of inst.events) ownerOf.set(e, owner);
      });
    }
    const records = new Map();
    for (const e of this.network) {
      const owner = ownerOf.get(e) || { key: JSON.stringify(['renderer', e.pid, e.requestId]), pid: e.pid };
      const key = owner.key;
      let r = records.get(key);
      if (r === undefined) {
        r = {
          requestId: e.requestId,
          pid: owner.pid,
          frame: '',
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
        records.set(key, r);
      }
      if (!r.frame && e.frame) r.frame = e.frame;
      switch (e.name) {
        case 'ResourceSendRequest':
          if (r.sendTs === null) r.sendTs = e.ts;
          if (e.url) r.url = e.url;
          if (e.method) r.method = e.method;
          if (e.priority) r.priority = e.priority;
          break;
        case 'ResourceReceiveResponse':
          r.responseTs = e.ts;
          if (e.status !== undefined) r.status = e.status;
          if (e.mimeType) r.mimeType = e.mimeType;
          if (e.fromCache) r.fromCache = true;
          if (e.fromServiceWorker) r.fromServiceWorker = true;
          break;
        case 'ResourceReceivedData':
          if (typeof e.bytes === 'number') r.dataBytes += e.bytes;
          break;
        case 'ResourceFinish':
          r.finishTs = e.ts;
          if (typeof e.bytes === 'number') r.finishBytes = e.bytes;
          if (e.didFail) r.didFail = true;
          break;
        default:
          break;
      }
    }
    return [...records.values()];
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
      frame: typeof d.frame === 'string' ? d.frame : '',
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
      network: this._buildNetwork(new Set(this.threadList.filter((t) => t.name === 'CrRendererMain').map((t) => t.pid))),
      websocket: this.websocket,
      warnings,
    };
  }
}

/**
 * Split one request id's browser/service-process events into request
 * instances. Those processes carry every tab's traffic, an id can recur
 * (another frame, or a later request), and often only ResourceSendRequest
 * carries a `frame`. Events are taken in time order:
 *
 * - An event with a frame joins the open (unfinished) instance with that
 *   frame, else the latest instance with that frame unless it is a new send,
 *   else adopts the only open frameless instance, else starts an instance.
 *   A second send in an open instance is a redirect, so it stays.
 * - A frameless event joins the only open instance (or the only instance at
 *   all). A frameless send with several open instances starts its own; any
 *   other frameless event that could belong to several goes to a separate
 *   `ambiguous` instance that never joins a renderer record.
 * - ResourceFinish closes its instance, so a later send reusing the id in
 *   the same frame is a new request.
 *
 * @param {any[]} events
 * @returns {{frame:string, finished:boolean, ambiguous:boolean, events:any[]}[]}
 */
export function nonRendererInstances(events) {
  const insts = [];
  let ambiguous = null;
  const start = (frame) => {
    const inst = { frame, finished: false, ambiguous: false, events: [] };
    insts.push(inst);
    return inst;
  };
  const sorted = events.map((e, i) => [e, i]).sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1]).map(([e]) => e);
  for (const e of sorted) {
    const isSend = e.name === 'ResourceSendRequest';
    const open = insts.filter((x) => !x.finished);
    let inst;
    if (e.frame) {
      inst = open.findLast((x) => x.frame === e.frame);
      if (!inst && !isSend) inst = insts.findLast((x) => x.frame === e.frame);
      if (!inst) {
        const frameless = open.filter((x) => !x.frame);
        if (frameless.length === 1) (inst = frameless[0]).frame = e.frame;
      }
      if (!inst) inst = start(e.frame);
    } else if (open.length === 1) inst = open[0];
    else if (isSend) inst = start('');
    else if (open.length === 0 && insts.length <= 1) inst = insts[0] || start('');
    else {
      if (!ambiguous) ambiguous = { frame: '', finished: false, ambiguous: true, events: [] };
      inst = ambiguous;
    }
    inst.events.push(e);
    if (e.name === 'ResourceFinish' && !inst.ambiguous) inst.finished = true;
  }
  if (ambiguous) insts.push(ambiguous);
  return insts;
}

/** Collect an in-memory array of events (tests, small inputs). */
export function collectEvents(events) {
  const c = new TraceCollector();
  for (const ev of events) c.add(ev);
  return c.finish();
}
