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

/**
 * Group EventTiming records into interactions. Pure.
 *
 * Phases span every event in the interaction (as web-vitals attribution
 * does), not just the longest one: a click is usually pointerdown +
 * pointerup + click, and the slow handler may live on a different event
 * from the one with the longest duration.
 *   input delay  = earliest processingStart - earliest timeStamp
 *   processing   = latest processingEnd - earliest processingStart
 *   presentation = duration - input delay - processing
 */
export function groupInteractions(records) {
  const groups = new Map();
  for (const r of records) {
    const key = `${r.pid}|${r.interactionId}`;
    let g = groups.get(key);
    if (!g) {
      groups.set(
        key,
        (g = {
          pid: r.pid,
          interactionId: r.interactionId,
          ts: r.ts,
          types: [],
          duration: 0,
          start: Infinity,
          procStart: Infinity,
          procEnd: -Infinity,
        }),
      );
    }
    if (r.ts < g.ts) g.ts = r.ts;
    if (!g.types.includes(r.type)) g.types.push(r.type);
    if (r.duration > g.duration) g.duration = r.duration;
    if (r.timeStamp < g.start) g.start = r.timeStamp;
    if (r.processingStart < g.procStart) g.procStart = r.processingStart;
    if (r.processingEnd > g.procEnd) g.procEnd = r.processingEnd;
  }
  return [...groups.values()].map((g) => {
    const inputDelayMs = Math.min(g.duration, pos(g.procStart - g.start));
    const processingMs = Math.min(g.duration - inputDelayMs, pos(g.procEnd - g.procStart));
    return {
      pid: g.pid,
      interactionId: g.interactionId,
      ts: g.ts,
      types: g.types,
      durationMs: g.duration,
      inputDelayMs,
      processingMs,
      presentationMs: pos(g.duration - inputDelayMs - processingMs),
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
