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
 * Decide which process-level records (network requests, WebSocket events)
 * belong to the analysed page.
 *
 * - Records from the scope's own renderer process are kept.
 * - Records from any other renderer (another tab, an out-of-process iframe)
 *   are dropped.
 * - Records from browser or service processes can belong to any tab, so they
 *   are kept only when their `frame` is one of the page's frames (the main
 *   frame ids from the trace, plus frames seen on the page renderer's own
 *   records). Unattributable ones are dropped and counted, so the section can
 *   say so.
 * - `--thread all` keeps everything.
 *
 * @param {any} ctx
 * @param {{pid:any, frame?:string}[]} records
 * @returns {{keep:(r:any)=>boolean, omitted:()=>number}}
 */
export function pageRecordFilter(ctx, records) {
  if (ctx.scope.all) return { keep: () => true, omitted: () => 0 };
  const renderers = new Set();
  for (const t of ctx.threadByKey.values()) if (t.name === 'CrRendererMain') renderers.add(t.pid);
  const pageFrames = new Set(ctx.mainFrame.frameIds);
  for (const r of records) if (ctx.scopePids.has(r.pid) && r.frame) pageFrames.add(r.frame);
  let omitted = 0;
  return {
    keep(r) {
      if (ctx.scopePids.has(r.pid)) return true;
      if (renderers.has(r.pid)) return false;
      if (r.frame && pageFrames.has(r.frame)) return true;
      omitted++;
      return false;
    },
    omitted: () => omitted,
  };
}

/** One-line note for records dropped because they could not be tied to the page. */
export function omittedNote(n, what) {
  if (!n) return '';
  return `${n} ${what} from the browser or a service process could not be tied to this page and ${n === 1 ? 'was' : 'were'} omitted (use --thread all to include them).`;
}
