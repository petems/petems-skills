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
 * - Records from any renderer other than the scope's (another tab, an
 *   out-of-process iframe) are dropped.
 * - Records from browser or service processes can belong to any tab, so they
 *   are kept only when their `frame` is one of the page's frames.
 *   Unattributable ones are dropped and counted, so the section can say so.
 * - When the trace gives the page's frame tree (and the scope is the page's
 *   renderer), that tree is the page's frame set. Chrome can put several
 *   tabs in one renderer process, so the scope's own records are filtered
 *   by frame too: a framed record is kept only if its frame is in the tree.
 *   A frameless record cannot be attributed; it is kept unless the process
 *   is known to host other frames (another top-level frame listed in the
 *   trace, or a record from the process whose frame is outside the tree),
 *   in which case it is dropped. Records dropped here are counted.
 * - With no frame tree (CDP recordings, hand-made traces) the process is the
 *   only signal: the scope's records are all kept, and frames seen on them
 *   are added to the page's frame set.
 * - `--thread all` keeps everything.
 *
 * @param {any} ctx
 * @param {{pid:any, frame?:string}[]} records
 * @returns {{keep:(r:any)=>boolean, omitted:()=>number, pageOmitted:()=>number}}
 */
export function pageRecordFilter(ctx, records) {
  if (ctx.scope.all) return { keep: () => true, omitted: () => 0, pageOmitted: () => 0 };
  const renderers = new Set();
  for (const t of ctx.threadByKey.values()) if (t.name === 'CrRendererMain') renderers.add(t.pid);
  const tree = ctx.mainFrame.treeFrameIds;
  const treeKnown = tree.size > 0 && [...ctx.scopePids].some((p) => ctx.mainFrame.pids.has(p));
  // Seed the page's frames from the tree only when it belongs to the scope.
  // An explicit --thread never carries another tab's tree (resolveThreads
  // gives it its own root, or none), so a tree outside the scope's process
  // is the default selection's fallback; a root with no known process can
  // still be used there, since it cannot be tied to any renderer.
  const treeOwned = treeKnown || ctx.mainFrame.pids.size === 0;
  const pageFrames = new Set(treeOwned ? tree : []);
  let shared = ctx.mainFrame.sharedRoots > 0;
  for (const r of records) {
    if (!ctx.scopePids.has(r.pid) || !r.frame) continue;
    if (!treeKnown) pageFrames.add(r.frame);
    else if (!tree.has(r.frame)) shared = true;
  }
  let omitted = 0;
  let pageOmitted = 0;
  return {
    keep(r) {
      if (ctx.scopePids.has(r.pid)) {
        if (!treeKnown || (r.frame ? tree.has(r.frame) : !shared)) return true;
        pageOmitted++;
        return false;
      }
      if (renderers.has(r.pid)) return false;
      if (r.frame && pageFrames.has(r.frame)) return true;
      omitted++;
      return false;
    },
    omitted: () => omitted,
    pageOmitted: () => pageOmitted,
  };
}

/**
 * Note for records dropped because they could not be tied to the page.
 * @param {{omitted:()=>number, pageOmitted:()=>number}} filter
 */
export function omittedNote(filter, one, many) {
  const parts = [];
  const was = (n) => (n === 1 ? 'was' : 'were');
  const n = filter.omitted();
  if (n) parts.push(`${n} ${n === 1 ? one : many} from the browser or a service process could not be tied to this page and ${was(n)} omitted (use --thread all to include them).`);
  const p = filter.pageOmitted();
  if (p) {
    parts.push(
      `${p} ${p === 1 ? one : many} from the page's renderer process could not be tied to this page's frames (the process hosts other frames, possibly another tab) and ${was(p)} omitted (use --thread all to include them).`,
    );
  }
  return parts.join(' ');
}

/**
 * True when a CPU profile thread belongs to the analysed page's process(es),
 * or when --thread all asked for everything. Keeps the page's own workers but
 * never another tab's profile.
 */
export function inPageProcess(ctx, pt) {
  return ctx.scope.all || ctx.scopePids.has(pt.pid);
}
