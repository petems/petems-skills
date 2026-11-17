// longtasks: top-level main-thread tasks over the threshold.

import { fmtMs, fmtCount, mdTable, urlBasename, byStr } from '../format.mjs';
import { overlap } from '../nesting.mjs';
import { aggregateSamples, frameName } from '../profile.mjs';
import { threadShort } from '../threads.mjs';
import { emptyBlock, heading, offsetFields, offsetHeaders, offsetCells, topN, moreLine, ms } from './common.mjs';

/** Select long tasks. Pure over ctx-like input. */
export function selectLongTasks(ctx) {
  const thresholdUs = ctx.options.longTaskMs * 1000;
  const { start, end } = ctx.win;
  const out = [];
  let excluded = 0;
  for (const th of ctx.scope.threads) {
    for (const t of ctx.tasks.get(th.key)) {
      const inScope = t.dur > 0 ? overlap(t.ts, t.end, start, end) > 0 : t.ts >= start && t.ts <= end;
      if (!inScope || t.dur < thresholdUs) continue;
      if (t.artifact || t.effDur < thresholdUs) {
        excluded++;
        continue;
      }
      out.push({ thread: th, task: t, clipped: ctx.win.set && (t.ts < start || t.end > end) });
    }
  }
  out.sort((a, b) => b.task.effDur - a.task.effDur || a.task.ts - b.task.ts || byStr(a.thread.key, b.thread.key));
  return { tasks: out, excluded };
}

function insideNames(ctx, selected) {
  const byThread = new Map();
  for (const s of selected) {
    let m = byThread.get(s.thread.key);
    if (!m) byThread.set(s.thread.key, (m = new Map()));
    m.set(s.task.index, new Map());
  }
  for (const [key, roots] of byThread) {
    const nest = ctx.nests.get(key);
    const { events, root, self, isArtifact, artifactAncestor } = nest;
    for (let k = 0; k < events.length; k++) {
      const acc = roots.get(root[k]);
      if (acc === undefined || root[k] === k || isArtifact[k] || artifactAncestor[k]) continue;
      const n = events[k].name;
      acc.set(n, (acc.get(n) || 0) + self[k]);
    }
  }
  return (s) => {
    const acc = byThread.get(s.thread.key).get(s.task.index);
    return [...acc.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1] || byStr(a[0], b[0]))
      .slice(0, 3)
      .map(([name, v]) => ({ name, selfMs: ms(v) }));
  };
}

function topJs(ctx, s) {
  const pt = ctx.prof.threads.get(s.thread.key);
  if (!pt) return [];
  const a = aggregateSamples(ctx.prof, pt, s.task.ts, s.task.end, undefined, { inclusive: false });
  return [...a.self.entries()]
    .sort((x, y) => y[1] - x[1] || x[0] - y[0])
    .slice(0, 2)
    .map(([fi, v]) => {
      const f = ctx.prof.frames[fi];
      const loc = f.url ? `${urlBasename(f.url)}${f.lineNumber >= 0 ? ':' + (f.lineNumber + 1) : ''}` : f.codeType || '(native)';
      return { name: frameName(f), location: loc, selfMs: ms(v) };
    });
}

export function compute(ctx) {
  const thresholdMs = ctx.options.longTaskMs;
  const { tasks, excluded } = selectLongTasks(ctx);
  const inside = insideNames(ctx, tasks);
  const multi = ctx.scope.threads.length > 1;
  let rows = tasks.map((s) => ({
    durMs: ms(s.task.effDur),
    rawDurMs: ms(s.task.dur),
    artifactMs: ms(s.task.artifactUs),
    ...offsetFields(ctx, s.task.ts),
    name: s.task.name,
    thread: multi ? threadShort(s.thread) : undefined,
    clipped: s.clipped,
    inside: inside(s),
    topJs: topJs(ctx, s),
  }));
  if (ctx.matcher) {
    rows = rows.filter((r) => ctx.matcher(r.name, ...r.inside.map((x) => x.name), ...r.topJs.map((x) => x.name), ...r.topJs.map((x) => x.location)));
  }
  const total = rows.length;
  const t = topN(rows, ctx.top);
  t.rows.forEach((r, i) => (r.rank = i + 1));
  const base = { thresholdMs, total, excludedArtifacts: excluded, hasUtc: !!ctx.utc, multiThread: multi, hasProfile: ctx.prof.threads.size > 0 };
  if (!total) {
    return { ...base, rows: [], more: 0, note: `No main-thread tasks of ${fmtMs(thresholdMs)} ms or longer in scope.` };
  }
  return { ...base, rows: t.rows, more: t.more };
}

export function md(d) {
  const title = `Long tasks (>= ${fmtMs(d.thresholdMs)} ms)`;
  const excl = d.excludedArtifacts
    ? `${fmtCount(d.excludedArtifacts)} task(s) excluded as CPU profiler overhead (CpuProfiler::StartProfiling/StopProfiling).`
    : '';
  if (!d.rows.length) return [emptyBlock(title, d.note), excl].filter(Boolean).join('\n\n');
  const headers = ['#', 'dur (ms)', ...offsetHeaders(d.hasUtc), ...(d.multiThread ? ['thread'] : []), 'name', 'inside', 'top JS'];
  const rows = d.rows.map((r) => [
    String(r.rank),
    fmtMs(r.durMs) + (r.clipped ? ' (clipped)' : ''),
    ...offsetCells(r, d.hasUtc),
    ...(d.multiThread ? [r.thread] : []),
    r.name,
    r.inside.map((x) => `${x.name} ${fmtMs(x.selfMs)}`).join(', ') || '-',
    r.topJs.map((x) => `${x.name} (${x.location}) ${fmtMs(x.selfMs)}`).join(', ') || (d.hasProfile ? '-' : 'no profile'),
  ]);
  const out = [heading(title), `${fmtCount(d.total)} long task(s) in scope.`, mdTable(headers, rows)];
  const more = moreLine(d.more);
  if (more) out.push(more);
  if (excl) out.push(excl);
  return out.join('\n\n');
}
