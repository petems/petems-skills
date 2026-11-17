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
 * @returns {{frames:any[], nodes:{frame:number,kind:number,parent:number}[], threads:Map<string,{key:string,pid:any,tid:any,times:Float64Array,durs:Float64Array,node:Int32Array}>}}
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
      // Walk up iteratively. A malformed (cyclic) parent chain stops at the
      // first repeated node and the last new node becomes a root, so every
      // profile node is created at most once and the walk is bounded by the
      // profile's own node count (no separate depth guard is needed).
      const chain = [];
      const seen = new Set();
      let cur = id;
      while (cur != null && local.get(cur) === undefined) {
        if (seen.has(cur)) {
          cur = null;
          break;
        }
        seen.add(cur);
        chain.push(cur);
        cur = parentOf.get(cur);
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
        // Store only the parent link: a per-node ancestor list would grow
        // quadratically with stack depth on a deep (or hostile) profile.
        const g = nodes.length;
        nodes.push({ frame, kind, parent: parentGlobal !== undefined ? parentGlobal : -1 });
        local.set(nid, g);
        parentGlobal = g;
      }
      return local.get(id);
    };

    const start = typeof p.startTime === 'number' ? p.startTime : 0;
    let { times, durs } = sampleTimes(start, p.deltas);
    let nodeArr = new Int32Array(times.length);
    for (let i = 0; i < times.length; i++) nodeArr[i] = resolve(p.samples[i]);
    // V8 can emit negative timeDeltas (out-of-order samples). Sort within
    // this profile and recompute durations on the sorted timeline: otherwise
    // the backwards step clamps to 0 and the next forward step double counts
    // the same wall time. Durations never span two profiles.
    if (!isSorted(times)) ({ times, durs, node: nodeArr } = sortSamples(times, nodeArr));
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
      durs[j] = th.parts[pi].durs[i];
      node[j] = th.parts[pi].node[i];
    }
    // Keep each profile's own durations: recomputing across the merged
    // timeline would hand the gap between two recordings to one sample. But
    // never let a sample run past the next one (a profile's inferred last
    // interval can reach into the next profile), or that time counts twice.
    for (let j = 0; j + 1 < total; j++) {
      const room = times[j + 1] - times[j];
      if (durs[j] > room) durs[j] = room;
    }
    threads.set(key, { key, pid: th.pid, tid: th.tid, times, durs, node });
  }
  return { frames, nodes, threads };
}

/** Sort one profile's samples by time and recompute their durations. */
function sortSamples(times, node) {
  const idx = Array.from(times, (_, i) => i).sort((a, b) => times[a] - times[b] || a - b);
  const t = new Float64Array(idx.length);
  const n = new Int32Array(idx.length);
  for (let j = 0; j < idx.length; j++) {
    t[j] = times[idx[j]];
    n[j] = node[idx[j]];
  }
  const d = new Float64Array(idx.length);
  fillDurations(t, d);
  return { times: t, durs: d, node: n };
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
 * Aggregate one thread's sampled time inside the half-open range
 * [start, end). Each sample covers [t, t + dur); only the part that overlaps
 * the range counts, so totals never exceed the range and a sample starting
 * exactly at `end` belongs to whatever comes next (adjacent tasks never
 * share a sample). Adds into `acc` (created when omitted). Pass
 * `{ inclusive: false }` to skip inclusive totals when only self time is
 * needed (their cost grows with stack depth, not sample count).
 */
export function aggregateSamples(prof, th, start, end, acc, { inclusive = true } = {}) {
  const a = acc || { self: new Map(), total: new Map(), idle: 0, program: 0, gc: 0, other: 0, sampled: 0, first: Infinity, last: -Infinity, count: 0 };
  const { times, durs, node } = th;
  const nodes = prof.nodes;
  const lo = Number.isFinite(start) ? start : -Infinity;
  const hi = Number.isFinite(end) ? end : Infinity;
  // Sampled time per profile node; inclusive totals are derived from it
  // once per call instead of walking every sample's whole stack.
  const selfByNode = new Map();
  let i = Number.isFinite(start) ? lowerBound(times, start) : 0;
  // Samples that start before the range may still run into it.
  while (i > 0 && times[i - 1] + durs[i - 1] > lo) i--;
  for (; i < times.length; i++) {
    const t = times[i];
    if (t >= hi) break;
    const s0 = t > lo ? t : lo;
    const s1 = t + durs[i] < hi ? t + durs[i] : hi;
    const d = s1 - s0;
    if (d <= 0 && !(durs[i] === 0 && t >= lo)) continue;
    a.count++;
    a.sampled += d;
    if (s0 < a.first) a.first = s0;
    if (s1 > a.last) a.last = s1;
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
      default:
        a.self.set(nd.frame, (a.self.get(nd.frame) || 0) + d);
        if (inclusive) selfByNode.set(node[i], (selfByNode.get(node[i]) || 0) + d);
    }
  }
  addInclusive(prof, selfByNode, a.total);
  return a;
}

/**
 * Add inclusive (total) time per frame into `total`, given the sampled time
 * per node. Each frame is credited once per sample (at its outermost
 * occurrence on the stack), so recursion does not double count. Linear in
 * the number of sampled nodes plus their ancestors: walking each sample's
 * whole stack would be quadratic on a deep profile.
 */
function addInclusive(prof, selfByNode, total) {
  if (selfByNode.size === 0) return;
  const nodes = prof.nodes;
  // Subtree time for every sampled node and its ancestors. The ancestor
  // walk stops at a node already collected, so each node is visited once.
  const sub = new Map();
  for (const [g, d] of selfByNode) {
    for (let n = g; n >= 0 && !sub.has(n); n = nodes[n].parent) sub.set(n, 0);
    sub.set(g, sub.get(g) + d);
  }
  // buildProfiles creates every parent before its children, so a parent's
  // index is always lower: visiting indices high to low sees children first.
  const order = Int32Array.from(sub.keys()).sort();
  const children = new Map();
  const roots = [];
  for (let k = order.length - 1; k >= 0; k--) {
    const g = order[k];
    const par = nodes[g].parent;
    if (par < 0) {
      roots.push(g);
      continue;
    }
    sub.set(par, sub.get(par) + sub.get(g));
    let c = children.get(par);
    if (!c) children.set(par, (c = []));
    c.push(g);
  }
  // Iterative DFS (stacks can be very deep) counting how often each frame
  // is on the current path. A node whose frame is not yet on the path is
  // that frame's outermost occurrence for every sample below it.
  let onPath = prof._onPath;
  if (!onPath || onPath.length < prof.frames.length) onPath = prof._onPath = new Int32Array(prof.frames.length);
  const stack = roots;
  while (stack.length) {
    const e = stack.pop();
    if (e < 0) {
      onPath[nodes[~e].frame]--;
      continue;
    }
    const f = nodes[e].frame;
    if (f >= 0) {
      if (onPath[f]++ === 0) total.set(f, (total.get(f) || 0) + sub.get(e));
      stack.push(~e);
    }
    const c = children.get(e);
    if (c) for (let k = 0; k < c.length; k++) stack.push(c[k]);
  }
}
