// marks: performance.mark / measure and console.timeStamp.

import { fmtMs, fmtCount, mdTable, round3, byStr } from '../format.mjs';
import { emptyBlock, heading, offsetFields, offsetHeaders, offsetCells, topN, moreLine } from './common.mjs';

// Navigation-timing marks Chrome also emits under blink.user_timing. These
// are native instant marks; a user measure with one of these names is kept.
const NAV_TIMING = new Set([
  'navigationStart', 'fetchStart', 'redirectStart', 'redirectEnd', 'unloadEventStart', 'unloadEventEnd',
  'domainLookupStart', 'domainLookupEnd', 'connectStart', 'connectEnd', 'secureConnectionStart',
  'requestStart', 'responseStart', 'responseEnd', 'domLoading', 'domInteractive',
  'domContentLoadedEventStart', 'domContentLoadedEventEnd', 'domComplete', 'loadEventStart', 'loadEventEnd',
  'commitNavigationEnd',
]);

/** Pair user timing events into marks and measures. Pure. */
export function userTimingEntries(records) {
  const out = [];
  const open = new Map();
  const sorted = records.slice().sort((a, b) => a.ts - b.ts);
  for (const r of sorted) {
    switch (r.ph) {
      case 'b': {
        const key = `${r.pid}|${r.cat}|${r.name}|${r.id}`;
        let st = open.get(key);
        if (!st) open.set(key, (st = []));
        const entry = { kind: 'measure', name: r.name, ts: r.ts, dur: null };
        st.push(entry);
        out.push(entry);
        break;
      }
      case 'e': {
        const key = `${r.pid}|${r.cat}|${r.name}|${r.id}`;
        const st = open.get(key);
        const entry = st && st.pop();
        if (entry) entry.dur = Math.max(0, r.ts - entry.ts);
        break;
      }
      case 'X':
        out.push({ kind: 'measure', name: r.name, ts: r.ts, dur: r.dur });
        break;
      case 'I':
      case 'i':
      case 'R':
      case 'n':
        if (NAV_TIMING.has(r.name)) break;
        out.push({ kind: 'mark', name: r.name, ts: r.ts, dur: null });
        break;
      default:
        break;
    }
  }
  return out;
}

export function compute(ctx) {
  const entries = userTimingEntries(ctx.model.userTiming.filter((r) => typeof r.ts === 'number' && (ctx.scope.all || ctx.scopePids.has(r.pid))));
  for (const t of ctx.model.timeStamps) {
    if (ctx.scope.all || ctx.scopePids.has(t.pid)) entries.push({ kind: 'timeStamp', name: t.message, ts: t.ts, dur: null });
  }
  let list = entries.filter((e) => typeof e.ts === 'number' && ctx.inWin(e.ts));
  if (ctx.matcher) list = list.filter((e) => ctx.matcher(e.name));
  list.sort((a, b) => a.ts - b.ts || byStr(a.kind, b.kind) || byStr(a.name, b.name));
  const rows = list.map((e) => ({ ...offsetFields(ctx, e.ts), kind: e.kind, name: e.name, durMs: e.dur === null ? null : round3(e.dur / 1000) }));
  if (!rows.length) return { rows: [], more: 0, note: 'No user timing marks, measures or console.timeStamp events in scope.' };
  const t = topN(rows, ctx.top);
  return { rows: t.rows, more: t.more, total: rows.length, hasUtc: !!ctx.utc };
}

export function md(d) {
  const title = 'Marks and measures';
  if (!d.rows.length) return emptyBlock(title, d.note);
  const headers = [...offsetHeaders(d.hasUtc), 'kind', 'name', 'dur (ms)'];
  const rows = d.rows.map((r) => [...offsetCells(r, d.hasUtc), r.kind, r.name, fmtMs(r.durMs)]);
  const out = [heading(title), `${fmtCount(d.total)} entr${d.total === 1 ? 'y' : 'ies'} in scope.`, mdTable(headers, rows)];
  const more = moreLine(d.more);
  if (more) out.push(more);
  return out.join('\n\n');
}
