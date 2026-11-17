// functions / scripts: CPU profile tables.

import { fmtMs, fmtPct, fmtCount, mdTable, round3, shortUrl, stripQuery, byStr } from '../format.mjs';
import { aggregateSamples, frameName, frameLocation } from '../profile.mjs';
import { threadShort } from '../threads.mjs';
import { emptyBlock, heading, topN, moreLine, ms } from './common.mjs';

export const NO_PROFILE_NOTE = 'No CPU profile in this trace. Record with "JavaScript samples" enabled.';

/** Per-thread sample aggregates for the scope (memoised). */
export function scopeSamples(ctx) {
  if (ctx._samples) return ctx._samples;
  const per = [];
  for (const pt of ctx.prof.threads.values()) {
    if (!ctx.scope.all && !ctx.scopeKeys.has(pt.key)) continue;
    const agg = aggregateSamples(ctx.prof, pt, ctx.win.start, ctx.win.end);
    const th = ctx.threadByKey.get(pt.key);
    per.push({ key: pt.key, label: th ? threadShort(th) : pt.key, agg });
  }
  let busy = 0;
  for (const p of per) busy += p.agg.sampled - p.agg.idle;
  ctx._samples = { per, busy };
  return ctx._samples;
}

function noProfileNote(ctx) {
  if (ctx.prof.threads.size === 0) return NO_PROFILE_NOTE;
  const names = [...ctx.prof.threads.values()].map((pt) => {
    const th = ctx.threadByKey.get(pt.key);
    return th && th.name ? `${th.name} (${pt.key})` : pt.key;
  });
  return `No CPU profile for the selected thread(s). Profiled threads: ${names.join(', ')}. Use --thread to pick one.`;
}

export const functions = {
  compute(ctx) {
    const { per, busy } = scopeSamples(ctx);
    if (!per.length) return { rows: [], more: 0, note: noProfileNote(ctx) };
    const contributing = per.filter((p) => p.agg.self.size > 0);
    const multi = contributing.length > 1;
    const merged = new Map();
    for (const p of per) {
      for (const [fi, self] of p.agg.self) {
        const key = multi ? `${fi}|${p.key}` : String(fi);
        let r = merged.get(key);
        if (!r) merged.set(key, (r = { fi, thread: multi ? p.label : undefined, self: 0, total: 0, pkey: p.key }));
        r.self += self;
      }
      for (const [fi, total] of p.agg.total) {
        const key = multi ? `${fi}|${p.key}` : String(fi);
        let r = merged.get(key);
        if (!r) merged.set(key, (r = { fi, thread: multi ? p.label : undefined, self: 0, total: 0, pkey: p.key }));
        r.total += total;
      }
    }
    let rows = [...merged.values()].map((r) => {
      const f = ctx.prof.frames[r.fi];
      return {
        function: frameName(f),
        selfMs: ms(r.self),
        selfPct: busy > 0 ? round3((r.self / busy) * 100) : 0,
        totalMs: ms(r.total),
        location: f.url ? shortUrl(frameLocation(f), 110) : frameLocation(f),
        url: f.url,
        thread: r.thread,
      };
    });
    if (ctx.matcher) rows = rows.filter((r) => ctx.matcher(r.function, r.url));
    rows.sort((a, b) => b.selfMs - a.selfMs || b.totalMs - a.totalMs || byStr(a.function, b.function) || byStr(a.location, b.location) || byStr(a.thread || '', b.thread || ''));
    for (const r of rows) delete r.url;
    if (!rows.length) return { rows: [], more: 0, note: ctx.matcher ? 'No sampled functions match --match.' : 'No JavaScript samples in scope.' };
    const t = topN(rows, ctx.top);
    return { rows: t.rows, more: t.more, busyMs: ms(busy), multiThread: multi };
  },
  md(d) {
    const title = 'Hottest JS functions (CPU profile)';
    if (!d.rows.length) return emptyBlock(title, d.note);
    const headers = ['function', 'self (ms)', 'self %', 'total (ms)', 'location', ...(d.multiThread ? ['thread'] : [])];
    const rows = d.rows.map((r) => [r.function, fmtMs(r.selfMs), fmtPct(r.selfPct), fmtMs(r.totalMs), r.location, ...(d.multiThread ? [r.thread] : [])]);
    return [heading(title), `Percentages are of ${fmtMs(d.busyMs)} ms non-idle sampled time.`, mdTable(headers, rows), moreLine(d.more)].filter(Boolean).join('\n\n');
  },
};

export const scripts = {
  compute(ctx) {
    const { per, busy } = scopeSamples(ctx);
    if (!per.length) return { rows: [], more: 0, note: noProfileNote(ctx) };
    const byUrl = new Map();
    for (const p of per) {
      for (const [fi, self] of p.agg.self) {
        const f = ctx.prof.frames[fi];
        const url = f.url ? stripQuery(f.url) : '(native / no url)';
        let r = byUrl.get(url);
        if (!r) byUrl.set(url, (r = { url, self: 0, frames: new Set() }));
        r.self += self;
        r.frames.add(fi);
      }
    }
    let rows = [...byUrl.values()].map((r) => ({
      script: r.url === '(native / no url)' ? r.url : shortUrl(r.url, 110),
      fullUrl: r.url,
      selfMs: ms(r.self),
      selfPct: busy > 0 ? round3((r.self / busy) * 100) : 0,
      functions: r.frames.size,
    }));
    if (ctx.matcher) rows = rows.filter((r) => ctx.matcher(r.fullUrl));
    rows.sort((a, b) => b.selfMs - a.selfMs || byStr(a.fullUrl, b.fullUrl));
    for (const r of rows) delete r.fullUrl;
    if (!rows.length) return { rows: [], more: 0, note: ctx.matcher ? 'No scripts match --match.' : 'No JavaScript samples in scope.' };
    const t = topN(rows, ctx.top);
    return { rows: t.rows, more: t.more, busyMs: ms(busy) };
  },
  md(d) {
    const title = 'Sampled self time by script';
    if (!d.rows.length) return emptyBlock(title, d.note);
    const rows = d.rows.map((r) => [r.script, fmtMs(r.selfMs), fmtPct(r.selfPct), fmtCount(r.functions)]);
    return [heading(title), mdTable(['script', 'self (ms)', 'self %', 'functions'], rows), moreLine(d.more)].filter(Boolean).join('\n\n');
  },
};
