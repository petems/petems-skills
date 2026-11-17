// CPU profile reconstruction from Profile / ProfileChunk events.

export const KIND_NORMAL = 0;
export const KIND_IDLE = 1;
export const KIND_PROGRAM = 2;
export const KIND_GC = 3;
export const KIND_ROOT = 4;

const SYNTHETIC = new Map([
  ['(root)', KIND_ROOT],
  ['(idle)', KIND_IDLE],
  ['(program)', KIND_PROGRAM],
  ['(garbage collector)', KIND_GC],
]);

/** Median of a numeric array (0 when empty). */
export function median(values) {
  if (values.length === 0) return 0;
  const a = Float64Array.from(values).sort();
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * Sample timestamps and durations.
 * t[0] = startTime + deltas[0]; t[i] = t[i-1] + deltas[i].
 * dur[i] = t[i+1] - t[i] (clamped at 0); last = median interval.
 */
export function sampleTimes(startTime, deltas) {
  const n = deltas.length;
  const times = new Float64Array(n);
  const durs = new Float64Array(n);
  let t = startTime;
  for (let i = 0; i < n; i++) {
    t += deltas[i];
    times[i] = t;
  }
  fillDurations(times, durs);
  return { times, durs };
}

/**
 * dur[i] = t[i+1] - t[i] (clamped at 0); last = median interval.
 * Only meaningful when `times` is sorted ascending, so callers must sort
 * out-of-order samples (V8 emits negative timeDeltas) before calling.
 */
export function fillDurations(times, durs) {
  const n = times.length;
  const intervals = [];
  for (let i = 0; i + 1 < n; i++) {
    const d = times[i + 1] - times[i];
    durs[i] = d > 0 ? d : 0;
    intervals.push(durs[i]);
  }
  if (n > 0) durs[n - 1] = median(intervals);
}

/** Human location `url:line:col` (1-based) or codeType / (native). */
export function frameLocation(f) {
  if (!f.url) return f.codeType && f.codeType !== 'other' ? f.codeType : '(native)';
  if (f.lineNumber < 0) return f.url;
  const col = f.columnNumber >= 0 ? `:${f.columnNumber + 1}` : '';
  return `${f.url}:${f.lineNumber + 1}${col}`;
}

export function frameName(f) {
  return f.functionName || '(anonymous)';
}

/**
 * Build per-thread sample tables from raw profiles.
 * @returns {{frames:any[], nodes:{frame:number,kind:number,anc:number[]}[], threads:Map<string,{key:string,pid:any,tid:any,times:Float64Array,durs:Float64Array,node:Int32Array}>}}
 */
export function buildProfiles(rawProfiles) {
  const frames = [];
  const frameIndex = new Map();
  const nodes = [];
  const perThread = new Map();

  for (const p of rawProfiles) {
    if (p.samples.length === 0) continue;
    const local = new Map(); // node id -> global index
    // resolve parents (accept `parent` or `children`)
    const parentOf = new Map();
    for (const [id, nd] of p.nodes) parentOf.set(id, nd.parent);
    for (const [child, par] of p.childParent) if (parentOf.get(child) == null) parentOf.set(child, par);

    const resolve = (id) => {
      const have = local.get(id);
      if (have !== undefined) return have;
      // walk up iteratively
      const chain = [];
      let cur = id;
      let guard = 0;
      while (cur != null && local.get(cur) === undefined && guard++ < 100000) {
        chain.push(cur);
        cur = parentOf.get(cur);
        if (chain.length > 1 && cur === chain[0]) break;
      }
      let parentGlobal = cur != null ? local.get(cur) : undefined;
      for (let i = chain.length - 1; i >= 0; i--) {
        const nid = chain[i];
        const nd = p.nodes.get(nid);
        let kind = KIND_NORMAL;
        let frame = -1;
        if (nd) {
          const syn = !nd.url ? SYNTHETIC.get(nd.functionName) : undefined;
          if (syn !== undefined) kind = syn;
          else {
            const key = `${nd.functionName}\u0000${nd.url}\u0000${nd.lineNumber}\u0000${nd.columnNumber}`;
            frame = frameIndex.get(key);
            if (frame === undefined) {
              frame = frames.length;
              frameIndex.set(key, frame);
              frames.push({
                functionName: nd.functionName,
                url: nd.url,
                lineNumber: nd.lineNumber,
                columnNumber: nd.columnNumber,
                codeType: nd.codeType,
              });
            }
          }
        } else {
          kind = KIND_ROOT;
        }
        const pAnc = parentGlobal !== undefined ? nodes[parentGlobal].anc : [];
        const anc = frame >= 0 && !pAnc.includes(frame) ? pAnc.concat(frame) : pAnc;
        const g = nodes.length;
        nodes.push({ frame, kind, anc });
        local.set(nid, g);
        parentGlobal = g;
      }
      return local.get(id);
    };

    const start = typeof p.startTime === 'number' ? p.startTime : 0;
    const { times, durs } = sampleTimes(start, p.deltas);
    const nodeArr = new Int32Array(times.length);
    for (let i = 0; i < times.length; i++) nodeArr[i] = resolve(p.samples[i]);
    const key = `${p.pid}:${p.tid}`;
    let th = perThread.get(key);
    if (!th) perThread.set(key, (th = { key, pid: p.pid, tid: p.tid, parts: [] }));
    th.parts.push({ times, durs, node: nodeArr });
  }

  const threads = new Map();
  for (const [key, th] of perThread) {
    if (th.parts.length === 1 && isSorted(th.parts[0].times)) {
      const part = th.parts[0];
      threads.set(key, { key, pid: th.pid, tid: th.tid, times: part.times, durs: part.durs, node: part.node });
      continue;
    }
    let total = 0;
    for (const part of th.parts) total += part.times.length;
    const order = [];
    for (let pi = 0; pi < th.parts.length; pi++) {
      for (let i = 0; i < th.parts[pi].times.length; i++) order.push([th.parts[pi].times[i], pi, i]);
    }
    order.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const times = new Float64Array(total);
    const durs = new Float64Array(total);
    const node = new Int32Array(total);
    for (let j = 0; j < total; j++) {
      const [, pi, i] = order[j];
      times[j] = th.parts[pi].times[i];
      node[j] = th.parts[pi].node[i];
    }
    // Recompute durations on the merged, sorted timeline. Per-part durations
    // are wrong for out-of-order samples: the backwards step clamps to 0 but
    // the following forward step double counts the same wall time.
    fillDurations(times, durs);
    threads.set(key, { key, pid: th.pid, tid: th.tid, times, durs, node });
  }
  return { frames, nodes, threads };
}

function isSorted(a) {
  for (let i = 1; i < a.length; i++) if (a[i] < a[i - 1]) return false;
  return true;
}

/** First index with times[i] >= t. */
export function lowerBound(times, t) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Aggregate one thread's samples whose own timestamp is in [start, end].
 * Adds into `acc` (created when omitted).
 */
export function aggregateSamples(prof, th, start, end, acc) {
  const a = acc || { self: new Map(), total: new Map(), idle: 0, program: 0, gc: 0, other: 0, sampled: 0, first: Infinity, last: -Infinity, count: 0 };
  const { times, durs, node } = th;
  const nodes = prof.nodes;
  let i = Number.isFinite(start) ? lowerBound(times, start) : 0;
  for (; i < times.length; i++) {
    const t = times[i];
    if (t > end) break;
    const d = durs[i];
    a.count++;
    a.sampled += d;
    if (t < a.first) a.first = t;
    if (t + d > a.last) a.last = t + d;
    const nd = nodes[node[i]];
    switch (nd.kind) {
      case KIND_IDLE:
        a.idle += d;
        break;
      case KIND_PROGRAM:
        a.program += d;
        break;
      case KIND_GC:
        a.gc += d;
        break;
      case KIND_ROOT:
        a.other += d;
        break;
      default: {
        a.self.set(nd.frame, (a.self.get(nd.frame) || 0) + d);
        const anc = nd.anc;
        for (let k = 0; k < anc.length; k++) a.total.set(anc[k], (a.total.get(anc[k]) || 0) + d);
      }
    }
  }
  return a;
}
