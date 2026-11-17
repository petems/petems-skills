// Shared helpers for section modules.

import { fmtMs, fmtCount, note, round3 } from '../format.mjs';

/** Offset fields for a row: { offsetMs, utc? }. */
export function offsetFields(ctx, ts) {
  const offsetMs = round3(ctx.off(ts));
  const out = { offsetMs };
  if (ctx.utc) out.utc = ctx.utc(ctx.off(ts));
  return out;
}

/** Header cells for offset (+ UTC when enabled). */
export function offsetHeaders(hasUtc, label = 'offset (ms)') {
  return hasUtc ? [label, 'UTC'] : [label];
}

export function offsetCells(row, hasUtc) {
  return hasUtc ? [fmtMs(row.offsetMs), row.utc] : [fmtMs(row.offsetMs)];
}

export function heading(title) {
  return `## ${title}`;
}

/** Heading + italic note block. */
export function emptyBlock(title, text) {
  return `${heading(title)}\n\n${note(text)}`;
}

/** Take the top N rows, remembering how many were dropped. */
export function topN(rows, n) {
  return { rows: rows.slice(0, n), more: Math.max(0, rows.length - n) };
}

export function moreLine(more) {
  return more > 0 ? `...${fmtCount(more)} more` : '';
}

export function ms(us) {
  return round3(us / 1000);
}

/**
 * Predicate for process-level records (network, WebSocket): true when the
 * pid belongs to a different renderer than the scope, i.e. another tab or
 * an out-of-process iframe. Browser and service processes are kept, since
 * Chrome may emit a page's own navigation requests there. `--thread all`
 * keeps everything.
 */
export function otherRendererFilter(ctx) {
  if (ctx.scope.all) return () => false;
  const others = new Set();
  for (const t of ctx.threadByKey.values()) {
    if (t.name === 'CrRendererMain' && !ctx.scopePids.has(t.pid)) others.add(t.pid);
  }
  return (pid) => others.has(pid);
}
