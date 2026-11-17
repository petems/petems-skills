// Per-thread duration model: sort, reconstruct nesting, compute self time.

export const ARTIFACT_NAMES = new Set(['CpuProfiler::StartProfiling', 'CpuProfiler::StopProfiling']);

/** Length of [s, e) ∩ [ws, we). */
export function overlap(s, e, ws, we) {
  const a = s > ws ? s : ws;
  const b = e < we ? e : we;
  return b > a ? b - a : 0;
}

/**
 * Build nesting for one thread's duration events.
 *
 * Sorted by start ascending, ties by duration descending, stable.
 * A child that overruns its parent is clipped to the parent end for the
 * parent's self time (and for nesting purposes).
 *
 * @param {{name:string,cat:string,ts:number,dur:number}[]} input
 * @param {{start:number,end:number}} [win] absolute µs window
 */
export function buildNesting(input, win) {
  const ws = win ? win.start : -Infinity;
  const we = win ? win.end : Infinity;
  const n = input.length;
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => {
    const ea = input[a];
    const eb = input[b];
    if (ea.ts !== eb.ts) return ea.ts - eb.ts;
    if (ea.dur !== eb.dur) return eb.dur - ea.dur;
    return a - b;
  });
  const events = new Array(n);
  for (let i = 0; i < n; i++) events[i] = input[idx[i]];

  const depth = new Int32Array(n);
  const parent = new Int32Array(n);
  const root = new Int32Array(n);
  const self = new Float64Array(n);
  const winDur = new Float64Array(n);
  const winSelf = new Float64Array(n);
  const sameNameAncestor = new Uint8Array(n);
  const isArtifact = new Uint8Array(n);
  const artifactAncestor = new Uint8Array(n);
  /** root index -> µs of (outermost) artifact time inside that task */
  const artifactTime = new Map();
  /** root index -> [[s,e],...] nested artifact intervals */
  const artifactIntervals = new Map();

  const stack = new Int32Array(n + 1);
  const stackEnd = new Float64Array(n + 1);
  let sp = 0;
  const nameCount = new Map();

  for (let k = 0; k < n; k++) {
    const e = events[k];
    const s = e.ts;
    const end = s + e.dur;
    while (sp > 0 && stackEnd[sp - 1] <= s) {
      sp--;
      const pn = events[stack[sp]].name;
      nameCount.set(pn, nameCount.get(pn) - 1);
    }
    const art = ARTIFACT_NAMES.has(e.name);
    isArtifact[k] = art ? 1 : 0;
    self[k] += e.dur;
    const wd = overlap(s, end, ws, we);
    winDur[k] = wd;
    winSelf[k] += wd;
    let eff = end;
    if (sp > 0) {
      const p = stack[sp - 1];
      const pEnd = stackEnd[sp - 1];
      if (eff > pEnd) eff = pEnd;
      parent[k] = p;
      depth[k] = sp;
      root[k] = root[p];
      self[p] -= eff - s;
      winSelf[p] -= overlap(s, eff, ws, we);
      artifactAncestor[k] = isArtifact[p] || artifactAncestor[p] ? 1 : 0;
      if (art && !artifactAncestor[k]) {
        const r = root[k];
        artifactTime.set(r, (artifactTime.get(r) || 0) + (eff - s));
        let list = artifactIntervals.get(r);
        if (!list) artifactIntervals.set(r, (list = []));
        list.push([s, eff]);
      }
    } else {
      parent[k] = -1;
      depth[k] = 0;
      root[k] = k;
    }
    const c = nameCount.get(e.name) || 0;
    sameNameAncestor[k] = c > 0 ? 1 : 0;
    nameCount.set(e.name, c + 1);
    stack[sp] = k;
    stackEnd[sp] = eff;
    sp++;
  }
  for (let k = 0; k < n; k++) {
    if (self[k] < 0) self[k] = 0;
    if (winSelf[k] < 0) winSelf[k] = 0;
  }
  return {
    events,
    depth,
    parent,
    root,
    self,
    winDur,
    winSelf,
    sameNameAncestor,
    isArtifact,
    artifactAncestor,
    artifactTime,
    artifactIntervals,
  };
}

/**
 * Top-level tasks of a nesting with artifact time removed.
 * @returns {{index:number,name:string,ts:number,dur:number,end:number,effDur:number,artifact:boolean,artifactUs:number}[]}
 */
export function topLevelTasks(nest) {
  const out = [];
  const { events, depth, isArtifact, artifactTime } = nest;
  for (let k = 0; k < events.length; k++) {
    if (depth[k] !== 0) continue;
    const e = events[k];
    const art = isArtifact[k] === 1;
    const artifactUs = art ? e.dur : artifactTime.get(k) || 0;
    const effDur = Math.max(0, e.dur - artifactUs);
    out.push({ index: k, name: e.name, ts: e.ts, dur: e.dur, end: e.ts + e.dur, effDur, artifact: art, artifactUs });
  }
  return out;
}
