// network: request waterfall.

import { fmtMs, fmtCount, mdTable, mdText, round3, shortUrl, byStr } from '../format.mjs';
import { emptyBlock, heading, offsetFields, offsetHeaders, offsetCells, topN, moreLine, pageRecordFilter, omittedNote } from './common.mjs';

/** Shape one collected request into a row (µs in, ms out). */
export function requestRow(r) {
  const bytes = r.finishBytes !== null ? r.finishBytes : r.dataBytes > 0 ? r.dataBytes : null;
  return {
    url: r.url,
    method: r.method || null,
    priority: r.priority || null,
    ttfbMs: r.responseTs !== null ? round3((r.responseTs - r.sendTs) / 1000) : null,
    durMs: r.finishTs !== null ? round3((r.finishTs - r.sendTs) / 1000) : null,
    sizeKB: bytes !== null ? round3(bytes / 1024) : null,
    status: r.status,
    mimeType: r.mimeType || null,
    fromCache: r.fromCache,
    fromServiceWorker: r.fromServiceWorker,
    didFail: r.didFail,
  };
}

export function compute(ctx) {
  const inWindow = ctx.model.network.filter((r) => r.sendTs !== null && ctx.inWin(r.sendTs));
  const page = pageRecordFilter(ctx, ctx.model.network);
  let reqs = inWindow.filter((r) => page.keep(r));
  const omitted = omittedNote(page, 'request', 'requests');
  if (ctx.matcher) reqs = reqs.filter((r) => ctx.matcher(r.url));
  reqs.sort((a, b) => a.sendTs - b.sendTs || byStr(String(a.requestId), String(b.requestId)));
  const rows = reqs.map((r) => ({ ...offsetFields(ctx, r.sendTs), ...requestRow(r) }));
  if (!rows.length) return { rows: [], more: 0, omitted, note: ['No network requests (ResourceSendRequest) in scope.', omitted].filter(Boolean).join(' ') };
  let totalKB = 0;
  let failed = 0;
  let slowest = null;
  for (const r of rows) {
    if (r.sizeKB !== null) totalKB += r.sizeKB;
    if (r.didFail) failed++;
    if (r.durMs !== null && (!slowest || r.durMs > slowest.durMs)) slowest = r;
  }
  const t = topN(rows, ctx.top);
  return {
    rows: t.rows,
    more: t.more,
    omitted,
    rollup: { count: rows.length, totalKB: round3(totalKB), failed, slowestMs: slowest ? slowest.durMs : null, slowestUrl: slowest ? slowest.url : null },
    hasUtc: !!ctx.utc,
  };
}

function statusCell(r) {
  let s = r.status === null || r.status === undefined ? '-' : String(r.status);
  const flags = [];
  if (r.didFail) flags.push('failed');
  if (r.fromCache) flags.push('cache');
  if (r.fromServiceWorker) flags.push('sw');
  return flags.length ? `${s} (${flags.join(', ')})` : s;
}

export function md(d) {
  const title = 'Network';
  if (!d.rows.length) return emptyBlock(title, d.note);
  const ru = d.rollup;
  const rollup = `${fmtCount(ru.count)} request${ru.count === 1 ? '' : 's'}, ${fmtMs(ru.totalKB)} KB, ${fmtCount(ru.failed)} failed, slowest ${fmtMs(ru.slowestMs)} ms${ru.slowestUrl ? ` (${mdText(shortUrl(ru.slowestUrl))})` : ''}.`;
  const headers = [...offsetHeaders(d.hasUtc), 'ttfb (ms)', 'dur (ms)', 'size (KB)', 'status', 'method', 'url'];
  const rows = d.rows.map((r) => [...offsetCells(r, d.hasUtc), fmtMs(r.ttfbMs), fmtMs(r.durMs), fmtMs(r.sizeKB), statusCell(r), r.method || '-', shortUrl(r.url)]);
  return [heading(title), rollup, mdTable(headers, rows), moreLine(d.more), d.omitted].filter(Boolean).join('\n\n');
}
