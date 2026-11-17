// timeline: main-thread busy time per bucket over the whole trace.

import { fmtMs, fmtBound, fmtPct, mdTable, round3 } from '../format.mjs';
import { emptyBlock, heading } from './common.mjs';

export const QUIET_PCT = 5;

/**
 * A task's effective intervals (µs): the task minus any nested profiler
 * artifact intervals, in time order.
 * @param {{ts:number,end:number}} t
 * @param {[number, number][] | undefined} arts
 */
export function taskIntervals(t, arts) {
  if (!arts) return [[t.ts, t.end]];
  const out = [];
  let cur = t.ts;
  for (const [s, e] of arts.slice().sort((a, b) => a[0] - b[0])) {
    if (s > cur) out.push([cur, Math.min(s, t.end)]);
    if (e > cur) cur = e;
  }
  if (t.end > cur) out.push([cur, t.end]);
  return out;
}

/** Busy intervals (µs) of scope threads: tasks minus nested artifacts, merged. */
export function busyIntervals(ctx) {
  const list = [];
  for (const th of ctx.scope.threads) {
    const nest = ctx.nests.get(th.key);
    for (const t of ctx.tasks.get(th.key)) {
      if (t.artifact || t.dur <= 0) continue;
      for (const iv of taskIntervals(t, nest.artifactIntervals.get(t.index))) list.push(iv);
    }
  }
  list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const iv of list) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) {
      if (iv[1] > last[1]) last[1] = iv[1];
    } else merged.push([iv[0], iv[1]]);
  }
  return merged;
}

/**
 * Split intervals across buckets. Pure.
 * @returns {Float64Array} busy µs per bucket
 */
export function bucketize(intervals, origin, bucketUs, count) {
  const busy = new Float64Array(count);
  for (const [s, e] of intervals) {
    let b = Math.max(0, Math.floor((s - origin) / bucketUs));
    for (; b < count; b++) {
      const bs = origin + b * bucketUs;
      const be = bs + bucketUs;
      if (bs >= e) break;
      const a = s > bs ? s : bs;
      const z = e < be ? e : be;
      if (z > a) busy[b] += z - a;
    }
  }
  for (let i = 0; i < count; i++) if (busy[i] > bucketUs) busy[i] = bucketUs;
  return busy;
}

/** Collapse runs (2+) of quiet buckets into one row. Pure. */
export function collapseQuiet(buckets) {
  const rows = [];
  let i = 0;
  while (i < buckets.length) {
    if (buckets[i].quiet) {
      let j = i;
      while (j + 1 < buckets.length && buckets[j + 1].quiet) j++;
      if (j > i) {
        rows.push({
          startMs: buckets[i].startMs,
          endMs: buckets[j].endMs,
          quiet: true,
          collapsed: true,
          inWindow: buckets.slice(i, j + 1).some((b) => b.inWindow),
        });
        i = j + 1;
        continue;
      }
    }
    rows.push(buckets[i]);
    i++;
  }
  return rows;
}

export function compute(ctx) {
  if (ctx.scope.threads.length === 0 || ctx.traceEnd <= ctx.origin) {
    return { rows: [], bucketMs: ctx.options.bucketMs, note: 'No main-thread tasks to place on a timeline.' };
  }
  const bucketMs = ctx.options.bucketMs;
  const bucketUs = bucketMs * 1000;
  const spanUs = ctx.traceEnd - ctx.origin;
  const count = Math.max(1, Math.ceil(spanUs / bucketUs));
  const busy = bucketize(busyIntervals(ctx), ctx.origin, bucketUs, count);
  const buckets = [];
  for (let b = 0; b < count; b++) {
    const bs = ctx.origin + b * bucketUs;
    const be = bs + bucketUs;
    const len = Math.min(be, Math.max(ctx.traceEnd, bs + 1)) - bs;
    const pct = len > 0 ? Math.min(100, (busy[b] / len) * 100) : 0;
    buckets.push({
      startMs: round3(b * bucketMs),
      endMs: round3((b + 1) * bucketMs),
      busyMs: round3(busy[b] / 1000),
      busyPct: round3(pct),
      quiet: pct < QUIET_PCT,
      inWindow: ctx.win.set && bs < ctx.win.end && be > ctx.win.start,
    });
  }
  return { rows: collapseQuiet(buckets), bucketMs, windowSet: ctx.win.set };
}

export function md(d) {
  const title = `Timeline (main-thread busy per ${fmtBound(d.bucketMs)} ms bucket, whole trace)`;
  if (!d.rows.length) return emptyBlock(title, d.note);
  const headers = ['start (ms)', 'busy (ms)', 'busy %', 'bar'];
  if (d.windowSet) headers.push('window');
  const rows = d.rows.map((r) => {
    const cells = r.collapsed
      ? [`${fmtBound(r.startMs)}-${fmtBound(r.endMs)}`, 'quiet', '', '']
      : [fmtBound(r.startMs), fmtMs(r.busyMs), fmtPct(r.busyPct), '#'.repeat(Math.round(r.busyPct / 5))];
    if (d.windowSet) cells.push(r.inWindow ? '<- window' : '');
    return cells;
  });
  return `${heading(title)}\n\n${mdTable(headers, rows)}`;
}
