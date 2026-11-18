// events / frequent / categories: aggregations of duration events in scope.

import { fmtMs, fmtCount, fmtPct, mdTable, round3, byStr } from '../format.mjs';
import { emptyBlock, heading, topN, moreLine, ms } from './common.mjs';

/** Aggregate scope-thread duration events by name (clipped to window). */
export function aggregateEvents(ctx) {
  if (ctx._eventAgg) return ctx._eventAgg;
  const byName = new Map();
  const byCat = new Map();
  let artifacts = 0;
  let artifactUs = 0;
  let nestedInArtifacts = 0;
  const { start, end } = ctx.win;
  for (const th of ctx.scope.threads) {
    const nest = ctx.nests.get(th.key);
    const { events, winDur, winSelf, sameNameAncestor, isArtifact, artifactAncestor } = nest;
    for (let k = 0; k < events.length; k++) {
      const e = events[k];
      const wd = winDur[k];
      if (wd <= 0 && !(e.dur === 0 && e.ts >= start && e.ts <= end)) continue;
      if (isArtifact[k]) {
        artifacts++;
        artifactUs += wd;
        continue;
      }
      // Work inside a profiler artifact (GC during StartProfiling, say) is
      // recording overhead too, as summary and timeline already treat it.
      // Its time is already part of the artifact's.
      if (artifactAncestor[k]) {
        nestedInArtifacts++;
        continue;
      }
      let a = byName.get(e.name);
      if (a === undefined) {
        a = { name: e.name, count: 0, self: 0, total: 0, sum: 0, max: 0 };
        byName.set(e.name, a);
      }
      a.count++;
      a.self += winSelf[k];
      if (!sameNameAncestor[k]) a.total += wd;
      a.sum += wd;
      if (wd > a.max) a.max = wd;
      if (winSelf[k] > 0) {
        const cat = e.cat ? e.cat.split(',')[0] : '(none)';
        byCat.set(cat, (byCat.get(cat) || 0) + winSelf[k]);
      }
    }
  }
  ctx._eventAgg = { byName, byCat, artifacts, artifactUs, nestedInArtifacts };
  return ctx._eventAgg;
}

function rowsOf(agg) {
  return [...agg.byName.values()].map((a) => ({
    name: a.name,
    count: a.count,
    selfMs: ms(a.self),
    totalMs: ms(a.total),
    avgMs: ms(a.count ? a.sum / a.count : 0),
    maxMs: ms(a.max),
  }));
}

function artifactNote(agg) {
  return agg.artifacts
    ? `Excluded ${fmtCount(agg.artifacts)} profiler artifact event(s) (CpuProfiler::StartProfiling/StopProfiling, ${fmtMs(agg.artifactUs / 1000)} ms)${agg.nestedInArtifacts ? ` and ${fmtCount(agg.nestedInArtifacts)} event(s) nested inside them` : ''}.`
    : '';
}

function scopeLabel(ctx) {
  return ctx.scope.all ? 'all threads' : 'main thread';
}

export const events = {
  compute(ctx) {
    const agg = aggregateEvents(ctx);
    let rows = rowsOf(agg);
    if (ctx.matcher) rows = rows.filter((r) => ctx.matcher(r.name));
    rows.sort((a, b) => b.selfMs - a.selfMs || b.count - a.count || byStr(a.name, b.name));
    const t = topN(rows, ctx.top);
    const base = { scope: scopeLabel(ctx), artifacts: agg.artifacts, artifactMs: ms(agg.artifactUs), artifactNote: artifactNote(agg) };
    if (!rows.length) return { ...base, rows: [], more: 0, note: 'No duration events in scope.' };
    return { ...base, rows: t.rows, more: t.more };
  },
  md(d) {
    const title = `Hottest events by self time (${d.scope})`;
    if (!d.rows.length) return [emptyBlock(title, d.note), d.artifactNote].filter(Boolean).join('\n\n');
    const headers = ['name', 'count', 'self (ms)', 'total (ms)', 'avg (ms)', 'max (ms)'];
    const rows = d.rows.map((r) => [r.name, fmtCount(r.count), fmtMs(r.selfMs), fmtMs(r.totalMs), fmtMs(r.avgMs), fmtMs(r.maxMs)]);
    return [heading(title), mdTable(headers, rows), moreLine(d.more), d.artifactNote].filter(Boolean).join('\n\n');
  },
};

export const frequent = {
  compute(ctx) {
    const agg = aggregateEvents(ctx);
    const secs = ctx.scopeMs / 1000;
    let rows = rowsOf(agg).map((r) => ({ ...r, perSec: secs > 0 ? round3(r.count / secs) : null }));
    if (ctx.matcher) rows = rows.filter((r) => ctx.matcher(r.name));
    rows.sort((a, b) => b.count - a.count || b.totalMs - a.totalMs || byStr(a.name, b.name));
    const t = topN(rows, ctx.top);
    const base = { scope: scopeLabel(ctx), artifactNote: artifactNote(agg) };
    if (!rows.length) return { ...base, rows: [], more: 0, note: 'No duration events in scope.' };
    return { ...base, rows: t.rows, more: t.more };
  },
  md(d) {
    const title = `Most frequent events (${d.scope})`;
    if (!d.rows.length) return emptyBlock(title, d.note);
    const headers = ['name', 'count', 'total (ms)', 'self (ms)', 'avg (ms)', 'per sec'];
    const rows = d.rows.map((r) => [r.name, fmtCount(r.count), fmtMs(r.totalMs), fmtMs(r.selfMs), fmtMs(r.avgMs), r.perSec === null ? '-' : fmtMs(r.perSec)]);
    return [heading(title), mdTable(headers, rows), moreLine(d.more), d.artifactNote].filter(Boolean).join('\n\n');
  },
};

// Lighthouse-style task groups.
const GROUPS = [
  ['Script Evaluation', ['EvaluateScript', 'v8.evaluateModule', 'FunctionCall', 'TimerFire', 'FireIdleCallback', 'FireAnimationFrame', 'RunMicrotasks', 'V8.Execute', 'EventDispatch', 'v8.callFunction', 'v8.run']],
  ['Script Parsing & Compilation', ['v8.compile', 'v8.compileModule', 'v8.parseOnBackground', 'v8.produceCache', 'v8.produceModuleCache', 'v8.deserializeOnBackground', 'CacheScript', 'CompileScript']],
  ['Style & Layout', ['ScheduleStyleRecalculation', 'RecalculateStyles', 'UpdateLayoutTree', 'InvalidateLayout', 'Layout']],
  ['Rendering', ['Animation', 'HitTest', 'PaintSetup', 'Paint', 'PaintImage', 'RasterTask', 'ScrollLayer', 'UpdateLayer', 'UpdateLayerTree', 'PrePaint', 'Layerize', 'CompositeLayers', 'Commit', 'IntersectionObserverController::computeIntersections']],
  ['Parse HTML & CSS', ['ParseHTML', 'ParseAuthorStyleSheet']],
];
const GROUP_OF = new Map();
for (const [g, names] of GROUPS) for (const n of names) GROUP_OF.set(n, g);
const GC_PREFIXES = ['V8.GC', 'MinorGC', 'MajorGC', 'BlinkGC.', 'GCEvent', 'ThreadState::', 'CppGC'];
export const GROUP_ORDER = [...GROUPS.map((g) => g[0]), 'Garbage Collection', 'Other'];

/** Map an event name to its work group. */
export function groupOf(name) {
  const g = GROUP_OF.get(name);
  if (g) return g;
  for (const p of GC_PREFIXES) if (name.startsWith(p)) return 'Garbage Collection';
  return 'Other';
}

export const categories = {
  compute(ctx) {
    const agg = aggregateEvents(ctx);
    const groups = new Map(GROUP_ORDER.map((g) => [g, 0]));
    let total = 0;
    for (const a of agg.byName.values()) {
      const g = groupOf(a.name);
      groups.set(g, groups.get(g) + a.self);
      total += a.self;
    }
    if (total <= 0) return { scope: scopeLabel(ctx), rows: [], cats: [], note: 'No main-thread self time in scope.' };
    const rows = [...groups.entries()]
      .filter(([, v]) => v > 0)
      .map(([group, v]) => ({ group, selfMs: ms(v), pct: round3((v / total) * 100) }))
      .sort((a, b) => b.selfMs - a.selfMs || GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
    const cats = [...agg.byCat.entries()]
      .map(([cat, v]) => ({ category: cat, selfMs: ms(v), pct: round3((v / total) * 100) }))
      .sort((a, b) => b.selfMs - a.selfMs || byStr(a.category, b.category))
      .slice(0, 10);
    return { scope: scopeLabel(ctx), totalMs: ms(total), rows, cats };
  },
  md(d) {
    const title = `Self time by work group (${d.scope})`;
    if (!d.rows.length) return emptyBlock(title, d.note);
    const t1 = mdTable(['group', 'self (ms)', '%'], d.rows.map((r) => [r.group, fmtMs(r.selfMs), fmtPct(r.pct)]));
    const t2 = mdTable(['trace category', 'self (ms)', '%'], d.cats.map((r) => [r.category, fmtMs(r.selfMs), fmtPct(r.pct)]));
    return [heading(title), t1, 'Top trace categories (first `cat` token):', t2].join('\n\n');
  },
};
