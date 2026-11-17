// vitals: navigation, FCP, LCP, CLS, DOMContentLoaded, load.

import { fmtMs, mdTable, round3, shortUrl } from '../format.mjs';
import { emptyBlock, heading, offsetFields, offsetHeaders, offsetCells } from './common.mjs';

/**
 * CLS session windows: shifts less than 1 s apart, window capped at 5 s.
 * @param {{ts:number,score:number}[]} shifts sorted by ts (µs)
 */
export function clsSessions(shifts) {
  let total = 0;
  let best = null;
  let cur = null;
  for (const s of shifts) {
    total += s.score;
    if (cur && s.ts - cur.last < 1e6 && s.ts - cur.start < 5e6) {
      cur.score += s.score;
      cur.last = s.ts;
      cur.count++;
    } else {
      cur = { start: s.ts, last: s.ts, score: s.score, count: 1 };
    }
    if (!best || cur.score > best.score) best = { ...cur };
  }
  return { total, largest: best };
}

function fmtScore(x) {
  return (Math.round(x * 10000) / 10000).toFixed(4);
}

export function compute(ctx) {
  const frameIds = ctx.mainFrame.frameIds;
  const all = ctx.scope.all;
  const evs = ctx.model.vitals.filter((v) => {
    if (typeof v.ts !== 'number' || !ctx.inWin(v.ts)) return false;
    if (all) return true;
    if (!ctx.scopePids.has(v.pid)) return false;
    if (frameIds.size > 0 && v.frame && !frameIds.has(v.frame)) return false;
    return true;
  });
  evs.sort((a, b) => a.ts - b.ts);
  const of = (name) => evs.filter((v) => v.name === name);
  const navs = of('navigationStart');
  const fcps = of('firstContentfulPaint');
  let nav = null;
  if (navs.length) {
    if (fcps.length) {
      const before = navs.filter((n) => n.ts <= fcps[0].ts);
      nav = before.length ? before[before.length - 1] : navs[0];
    } else nav = navs[0];
  }
  const after = (list) => (nav ? list.filter((v) => v.ts >= nav.ts) : list);
  const rows = [];
  const row = (metric, ts, detail, value = null) => {
    rows.push({
      metric,
      ...offsetFields(ctx, ts),
      sinceNavMs: nav ? round3((ts - nav.ts) / 1000) : null,
      value,
      detail,
    });
  };
  if (nav) row('Navigation start', nav.ts, nav.url ? shortUrl(nav.url) : '');
  const fcp = after(fcps)[0];
  if (fcp) row('First Contentful Paint', fcp.ts, '');
  const lcps = after(of('largestContentfulPaint::Candidate'));
  if (lcps.length) {
    const l = lcps[lcps.length - 1];
    const bits = [];
    if (l.size !== undefined) bits.push(`size ${l.size}`);
    if (l.type) bits.push(`type ${l.type}`);
    if (l.nodeId !== undefined) bits.push(`node ${l.nodeId}`);
    bits.push(`${lcps.length} candidate${lcps.length === 1 ? '' : 's'}`);
    row('Largest Contentful Paint', l.ts, bits.join(', '));
  }
  const dcl = after(of('MarkDOMContent'))[0];
  if (dcl) row('DOMContentLoaded', dcl.ts, '');
  const load = after(of('MarkLoad'))[0];
  if (load) row('Load', load.ts, '');
  const shifts = of('LayoutShift').filter((s) => !s.hadRecentInput);
  let cls = null;
  if (shifts.length) {
    const { total, largest } = clsSessions(shifts);
    cls = { total: Math.round(total * 10000) / 10000, largest: Math.round(largest.score * 10000) / 10000, shifts: shifts.length };
    row(
      'Cumulative Layout Shift',
      largest.start,
      `total ${fmtScore(total)} over ${shifts.length} shift${shifts.length === 1 ? '' : 's'}; largest session window ${fmtScore(largest.score)} (${largest.count} shift${largest.count === 1 ? '' : 's'}) starting here`,
      Math.round(largest.score * 10000) / 10000,
    );
  }
  if (!rows.length) {
    return { rows: [], note: 'No page-load vitals in scope (typical for a recording without a navigation).' };
  }
  return { rows, navigations: navs.length, cls, hasUtc: !!ctx.utc };
}

export function md(d) {
  const title = 'Vitals';
  if (!d.rows.length) return emptyBlock(title, d.note);
  const headers = ['metric', ...offsetHeaders(d.hasUtc), 'since nav (ms)', 'detail'];
  const rows = d.rows.map((r) => [r.metric, ...offsetCells(r, d.hasUtc), fmtMs(r.sinceNavMs), r.detail]);
  const out = [heading(title), mdTable(headers, rows)];
  if (d.navigations > 1) out.push(`${d.navigations} navigations in scope; times are relative to the one that preceded the first paint.`);
  return out.join('\n\n');
}
