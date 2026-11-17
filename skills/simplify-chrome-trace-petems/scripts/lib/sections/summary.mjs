// summary: header block.

import { fmtMs, fmtCount, fmtPct, round3, cleanText } from '../format.mjs';
import { overlap } from '../nesting.mjs';
import { aggregateSamples } from '../profile.mjs';
import { threadLabel, threadShort } from '../threads.mjs';
import { ms, inPageProcess } from './common.mjs';
import { busyIntervals, taskIntervals } from './timeline.mjs';

export const TBT_THRESHOLD_US = 50000;

/**
 * Task stats over scope threads (tasks overlapping the window).
 *
 * Busy time is the union of task intervals across scope threads (minus
 * profiler artifacts) clipped to the window, so it can never exceed the
 * window even with several threads in scope.
 *
 * TBT follows Lighthouse: a task's blocking portion is everything after its
 * first 50 ms of effective (non-artifact) time, and only the part of that
 * inside the window counts. A long task that barely overlaps the window adds
 * only what overlaps, and profiler overhead is never counted as blocking.
 */
export function taskStats(ctx) {
  let count = 0;
  let over50 = 0;
  let tbtUs = 0;
  const { start, end } = ctx.win;
  for (const th of ctx.scope.threads) {
    for (const t of ctx.tasks.get(th.key)) {
      if (t.artifact) continue;
      const inside = t.dur > 0 ? overlap(t.ts, t.end, start, end) > 0 : t.ts >= start && t.ts <= end;
      if (!inside) continue;
      count++;
      if (t.effDur > TBT_THRESHOLD_US) {
        over50++;
        tbtUs += blockingInWindow(taskIntervals(t, ctx.nests.get(th.key).artifactIntervals.get(t.index)), start, end);
      }
    }
  }
  let busyUs = 0;
  for (const [s, e] of busyIntervals(ctx)) busyUs += overlap(s, e, start, end);
  return { count, busyMs: ms(busyUs), over50, tbtMs: ms(tbtUs) };
}

/**
 * Blocking time of one task inside [start, end]: skip the first 50 ms of the
 * task's effective (non-artifact) time, then count what remains inside the
 * window. Profiler overhead is never counted as blocking, wherever it sits.
 */
export function blockingInWindow(intervals, start, end) {
  let skip = TBT_THRESHOLD_US;
  let total = 0;
  for (const [s, e] of intervals) {
    let from = s;
    if (skip > 0) {
      const used = Math.min(skip, e - s);
      skip -= used;
      from = s + used;
    }
    if (e > from) total += overlap(from, e, start, end);
  }
  return total;
}

function countInWindow(ctx) {
  const ts = ctx.model.ts;
  const { start, end } = ctx.win;
  let n = 0;
  for (let i = 0; i < ts.length; i++) if (ts[i] >= start && ts[i] <= end) n++;
  return n;
}

export function compute(ctx) {
  // Only the analysed page's process(es), so its workers stay in but CPU
  // profiles from other tabs never leak into the report (unless --thread all).
  const profiles = [];
  let otherProfiles = 0;
  for (const pt of ctx.prof.threads.values()) {
    if (!inPageProcess(ctx, pt)) {
      otherProfiles++;
      continue;
    }
    const a = aggregateSamples(ctx.prof, pt, ctx.win.start, ctx.win.end);
    const th = ctx.threadByKey.get(pt.key);
    profiles.push({
      thread: th ? threadShort(th) : pt.key,
      pid: pt.pid,
      tid: pt.tid,
      inScope: ctx.scopeKeys.has(pt.key),
      samples: a.count,
      spanMs: a.count ? ms(a.last - a.first) : 0,
      busyMs: ms(a.sampled - a.idle),
      idleMs: ms(a.idle),
      programMs: ms(a.program),
      gcMs: ms(a.gc),
    });
  }
  profiles.sort((x, y) => Number(y.inScope) - Number(x.inScope) || y.busyMs - x.busyMs || (x.thread < y.thread ? -1 : x.thread > y.thread ? 1 : 0));
  const tasks = taskStats(ctx);
  const busyPct = ctx.scopeMs > 0 ? round3((tasks.busyMs / ctx.scopeMs) * 100) : 0;
  return {
    // Everything the summary prints outside a table is cleaned: it can come
    // from the trace (metadata, thread names) and must not start its own lines.
    file: cleanText(ctx.fileName),
    fileSize: ctx.fileSize,
    eventCount: ctx.model.eventCount,
    source: ctx.metadata && ctx.metadata.source ? cleanText(ctx.metadata.source) : null,
    startTime: ctx.metadata && ctx.metadata.startTime ? cleanText(ctx.metadata.startTime) : null,
    spanMs: ms(ctx.traceEnd - ctx.origin),
    window: ctx.win.set
      ? {
          startMs: round3(ctx.off(ctx.scopeStart)),
          endMs: round3(ctx.off(ctx.scopeEnd)),
          durationMs: round3(ctx.scopeMs),
          source: ctx.win.source,
          eventCount: countInWindow(ctx),
        }
      : null,
    mainThreads: ctx.scope.threads.map((t) => ({ label: threadLabel(t), pid: t.pid, tid: t.tid, name: t.name })),
    threadReason: cleanText(ctx.scope.reason),
    profiles,
    otherProfiles,
    tasks: { ...tasks, busyPct, scopeMs: round3(ctx.scopeMs) },
  };
}

function fmtSize(bytes) {
  if (bytes === null || bytes === undefined) return null;
  if (bytes >= 1024 * 1024) return `${fmtMs(bytes / (1024 * 1024))} MB`;
  return `${fmtMs(bytes / 1024)} KB`;
}

export function md(d, report) {
  const lines = [`# Trace summary: ${d.file}`, ''];
  const size = fmtSize(d.fileSize);
  lines.push(`- File: ${size ? size + ', ' : ''}${fmtCount(d.eventCount)} events`);
  if (d.source || d.startTime) {
    const parts = [];
    if (d.source) parts.push(`source ${d.source}`);
    if (d.startTime) parts.push(`started ${d.startTime}`);
    lines.push(`- Recording: ${parts.join(', ')}`);
  }
  lines.push(`- Span: ${fmtMs(d.spanMs)} ms`);
  if (d.window) {
    lines.push(
      `- Window (${d.window.source}): ${fmtMs(d.window.startMs)}-${fmtMs(d.window.endMs)} ms (${fmtMs(d.window.durationMs)} ms, ${fmtCount(d.window.eventCount)} events)`,
    );
  }
  if (d.mainThreads.length === 0) lines.push(`- Main thread: none (${d.threadReason})`);
  else {
    const names = d.mainThreads.map((t) => t.label).join('; ');
    lines.push(`- Main thread${d.mainThreads.length > 1 ? 's' : ''}: ${names}, chosen by ${d.threadReason}`);
  }
  if (d.profiles.length === 0) lines.push(d.otherProfiles ? '- CPU profile: none for this page' : '- CPU profile: none');
  for (const p of d.profiles) {
    lines.push(
      `- CPU profile ${p.thread} (${p.pid}:${p.tid}): sampled ${fmtMs(p.spanMs)} ms, busy ${fmtMs(p.busyMs)} ms, idle ${fmtMs(p.idleMs)} ms, program ${fmtMs(p.programMs)} ms, GC ${fmtMs(p.gcMs)} ms`,
    );
  }
  if (d.otherProfiles) lines.push(`- CPU profiles left out: ${fmtCount(d.otherProfiles)} from other processes (use --thread all to include them)`);
  const t = d.tasks;
  lines.push(
    `- Main-thread tasks in scope: ${fmtCount(t.count)} tasks, busy ${fmtMs(t.busyMs)} ms (${fmtPct(t.busyPct)} of ${fmtMs(t.scopeMs)} ms), ${fmtCount(t.over50)} over 50 ms, TBT (all tasks in scope) ${fmtMs(t.tbtMs)} ms`,
  );
  const warnings = (report && report.warnings) || [];
  if (warnings.length) {
    lines.push('- Warnings:');
    for (const w of warnings) lines.push(`  - ${cleanText(w)}`);
  }
  return lines.join('\n');
}
