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
  // Navigation choice uses the page's records regardless of the window: a
  // window can start after the navigation its paints belong to. Reported
  // metrics are then windowed.
  const scoped = ctx.model.vitals.filter((v) => {
    if (typeof v.ts !== 'number') return false;
    if (all) return true;
    if (!ctx.scopePids.has(v.pid)) return false;
    if (frameIds.size > 0 && v.frame && !frameIds.has(v.frame)) return false;
    return true;
  });
  scoped.sort((a, b) => a.ts - b.ts);
  const evs = scoped.filter((v) => ctx.inWin(v.ts));
  const of = (name) => evs.filter((v) => v.name === name);
  const allNavs = scoped.filter((v) => v.name === 'navigationStart');
  const navs = of('navigationStart');
  // Anchor on the chronologically first page-load metric in the window (any
  // kind, layout shifts included), and pick the last navigation at or before
  // it. Preferring a later FCP could jump to a second page and silently drop
  // the first page's earlier metrics.
  const METRICS = new Set(['firstContentfulPaint', 'largestContentfulPaint::Candidate', 'MarkDOMContent', 'MarkLoad', 'LayoutShift']);
  // A shift with recent input is discarded from CLS below, so it must not
  // pick the navigation either.
  const anchor = evs.find((v) => METRICS.has(v.name) && !(v.name === 'LayoutShift' && v.hadRecentInput));
  let nav = null;
  if (anchor) {
    const before = allNavs.filter((n) => n.ts <= anchor.ts);
    nav = before.length ? before[before.length - 1] : null;
  } else if (navs.length) {
    nav = navs[0];
  }
  // Every metric belongs to the chosen navigation: from it up to (not
  // including) the next one, so a later page's paints or an earlier page's
  // layout shifts never mix in.
  const nextNav = nav ? allNavs.find((n) => n.ts > nav.ts) : null;
  const navEnd = nextNav ? nextNav.ts : Infinity;
  const after = (list) => (nav ? list.filter((v) => v.ts >= nav.ts && v.ts < navEnd) : list);
  const fcps = of('firstContentfulPaint');
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
  if (nav && ctx.inWin(nav.ts)) row('Navigation start', nav.ts, nav.url ? shortUrl(nav.url) : '');
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
  const shifts = after(of('LayoutShift')).filter((s) => !s.hadRecentInput);
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
