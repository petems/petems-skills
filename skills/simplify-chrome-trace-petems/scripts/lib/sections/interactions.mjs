// interactions: EventTiming interactions and an INP estimate.

import { fmtMs, fmtCount, mdTable, round3 } from '../format.mjs';
import { emptyBlock, heading, offsetFields, offsetHeaders, offsetCells, topN, moreLine } from './common.mjs';

/** INP estimate: worst if < 50 interactions, else skip one per 50. */
export function inpEstimate(durations) {
  if (!durations.length) return null;
  const sorted = durations.slice().sort((a, b) => b - a);
  const skip = Math.min(sorted.length - 1, Math.floor(sorted.length / 50));
  return sorted[skip];
}

const pos = (x) => (x > 0 ? x : 0);

// Events presented in the same frame end at the same time (timeStamp +
// duration); allow for rounding.
const SAME_FRAME_US_MS = 1;

/**
 * Group EventTiming records into interactions. Pure.
 *
 * An interaction's duration is its worst event's duration. Its phases come
 * from the worst event's presentation frame: every event of the interaction
 * that ends with it (same frame) is combined, as web-vitals attribution does,
 * since a click is usually pointerdown + pointerup + click and the slow
 * handler may sit on a different event from the longest one. Events that
 * painted in an earlier frame (a pointerdown before a long hold, say) are left
 * out, so the hold is not counted as processing.
 *   input delay  = earliest processingStart - earliest timeStamp
 *   processing   = latest processingEnd - earliest processingStart
 *   presentation = duration - input delay - processing
 */
export function groupInteractions(records) {
  const groups = new Map();
  for (const r of records) {
    const key = `${r.pid}|${r.interactionId}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { pid: r.pid, interactionId: r.interactionId, ts: r.ts, types: [], events: [] }));
    if (r.ts < g.ts) g.ts = r.ts;
    if (!g.types.includes(r.type)) g.types.push(r.type);
    g.events.push(r);
  }
  return [...groups.values()].map((g) => {
    let worst = g.events[0];
    for (const e of g.events) if (e.duration > worst.duration) worst = e;
    const frameEnd = worst.timeStamp + worst.duration;
    const sameFrame = g.events.filter((e) => Math.abs(e.timeStamp + e.duration - frameEnd) <= SAME_FRAME_US_MS);
    let start = Infinity;
    let procStart = Infinity;
    let procEnd = -Infinity;
    for (const e of sameFrame) {
      if (e.timeStamp < start) start = e.timeStamp;
      if (e.processingStart < procStart) procStart = e.processingStart;
      if (e.processingEnd > procEnd) procEnd = e.processingEnd;
    }
    const duration = worst.duration;
    const inputDelayMs = Math.min(duration, pos(procStart - start));
    const processingMs = Math.min(duration - inputDelayMs, pos(procEnd - procStart));
    return {
      pid: g.pid,
      interactionId: g.interactionId,
      ts: g.ts,
      types: g.types,
      durationMs: duration,
      inputDelayMs,
      processingMs,
      presentationMs: pos(duration - inputDelayMs - processingMs),
    };
  });
}

export function compute(ctx) {
  const recs = ctx.model.eventTimings.filter((r) => typeof r.ts === 'number' && ctx.inWin(r.ts) && (ctx.scope.all || ctx.scopePids.has(r.pid)));
  const all = groupInteractions(recs);
  const inp = inpEstimate(all.map((g) => g.durationMs));
  let groups = all;
  if (ctx.matcher) groups = groups.filter((g) => ctx.matcher(...g.types));
  groups.sort((a, b) => b.durationMs - a.durationMs || a.ts - b.ts || a.interactionId - b.interactionId);
  const rows = groups.map((g) => ({
    ...offsetFields(ctx, g.ts),
    interactionId: g.interactionId,
    types: g.types,
    durationMs: round3(g.durationMs),
    inputDelayMs: round3(g.inputDelayMs),
    processingMs: round3(g.processingMs),
    presentationMs: round3(g.presentationMs),
  }));
  if (!all.length) return { rows: [], count: 0, inpMs: null, more: 0, note: 'No user interactions (EventTiming with interactionId) in scope.' };
  if (!rows.length) return { rows: [], count: all.length, inpMs: round3(inp), more: 0, note: 'No interactions match --match.' };
  const t = topN(rows, ctx.top);
  return { rows: t.rows, more: t.more, count: all.length, matched: rows.length, inpMs: round3(inp), hasUtc: !!ctx.utc };
}

export function md(d) {
  const title = 'Interactions';
  if (!d.rows.length) return emptyBlock(title, d.note);
  const headers = ['#', ...offsetHeaders(d.hasUtc), 'type', 'dur (ms)', 'input delay (ms)', 'processing (ms)', 'presentation (ms)'];
  const rows = d.rows.map((r, i) => [
    String(i + 1),
    ...offsetCells(r, d.hasUtc),
    r.types.join(', '),
    fmtMs(r.durationMs),
    fmtMs(r.inputDelayMs),
    fmtMs(r.processingMs),
    fmtMs(r.presentationMs),
  ]);
  const rule = d.count < 50 ? 'worst interaction' : '98th percentile, one ignored per 50';
  const out = [heading(title), `INP estimate: ${fmtMs(d.inpMs)} ms (${rule}, ${fmtCount(d.count)} interaction${d.count === 1 ? '' : 's'}).`, mdTable(headers, rows)];
  const more = moreLine(d.more);
  if (more) out.push(more);
  return out.join('\n\n');
}
