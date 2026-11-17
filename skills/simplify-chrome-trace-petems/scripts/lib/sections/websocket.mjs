// websocket: connections and lifecycle events.

import { fmtMs, fmtCount, mdTable, round3, shortUrl, byStr } from '../format.mjs';
import { emptyBlock, heading, offsetFields, offsetHeaders, offsetCells, topN, moreLine, pageRecordFilter, omittedNote } from './common.mjs';

/** Group WebSocket events by (pid, identifier). Pure; ts in µs. */
export function groupSockets(events) {
  const conns = new Map();
  for (const e of events) {
    const key = `${e.pid}|${e.identifier}`;
    let c = conns.get(key);
    if (!c) conns.set(key, (c = { identifier: e.identifier, pid: e.pid, url: '', created: null, sendHs: null, recvHs: null, destroyed: null, count: 0 }));
    c.count++;
    if (e.url && !c.url) c.url = e.url;
    if (e.name === 'WebSocketCreate' && c.created === null) c.created = e.ts;
    else if (e.name === 'WebSocketSendHandshakeRequest' && c.sendHs === null) c.sendHs = e.ts;
    else if (e.name === 'WebSocketReceiveHandshakeResponse' && c.recvHs === null) c.recvHs = e.ts;
    else if (e.name === 'WebSocketDestroy') c.destroyed = e.ts;
  }
  return [...conns.values()];
}

export function compute(ctx) {
  // URLs come from the whole trace: the WebSocketCreate that carries a
  // connection's URL may fall before the window while its later lifecycle
  // events (which often have no URL) are inside it.
  // The frame usually rides only on WebSocketCreate; share it across the
  // connection so every event can be attributed to (or away from) the page.
  const urlOf = new Map();
  const frameOf = new Map();
  for (const e of ctx.model.websocket) {
    const key = `${e.pid}|${e.identifier}`;
    if (e.url && !urlOf.has(key)) urlOf.set(key, e.url);
    if (e.frame && !frameOf.has(key)) frameOf.set(key, e.frame);
  }
  const all = ctx.model.websocket.map((e) => (e.frame ? e : { ...e, frame: frameOf.get(`${e.pid}|${e.identifier}`) || '' }));
  const page = pageRecordFilter(ctx, all);
  const evs = all.filter((e) => typeof e.ts === 'number' && ctx.inWin(e.ts) && page.keep(e)).sort((a, b) => a.ts - b.ts);
  const omitted = omittedNote(page.omitted(), page.omitted() === 1 ? 'WebSocket event' : 'WebSocket events');
  let conns = groupSockets(evs);
  for (const c of conns) if (!c.url) c.url = urlOf.get(`${c.pid}|${c.identifier}`) || '';
  if (ctx.matcher) conns = conns.filter((c) => ctx.matcher(c.url));
  if (!conns.length) return { connections: [], events: [], more: 0, omitted, note: ['No WebSocket activity in scope.', omitted].filter(Boolean).join(' ') };
  const keep = new Set(conns.map((c) => `${c.pid}|${c.identifier}`));
  conns.sort((a, b) => (a.created ?? Infinity) - (b.created ?? Infinity) || byStr(String(a.identifier), String(b.identifier)));
  const connections = conns.map((c) => ({
    identifier: c.identifier,
    url: c.url,
    createdMs: c.created !== null ? round3(ctx.off(c.created)) : null,
    handshakeMs: c.sendHs !== null && c.recvHs !== null ? round3((c.recvHs - c.sendHs) / 1000) : null,
    destroyedMs: c.destroyed !== null ? round3(ctx.off(c.destroyed)) : null,
    events: c.count,
  }));
  const rows = evs
    .filter((e) => keep.has(`${e.pid}|${e.identifier}`))
    .map((e) => ({ ...offsetFields(ctx, e.ts), event: e.name, identifier: e.identifier, url: e.url || urlOf.get(`${e.pid}|${e.identifier}`) || '' }));
  const t = topN(rows, ctx.top);
  return { connections, events: t.rows, more: t.more, omitted, hasUtc: !!ctx.utc };
}

export function md(d) {
  const title = 'WebSocket';
  if (!d.connections.length) return emptyBlock(title, d.note);
  const t1 = mdTable(
    ['url', 'created (ms)', 'handshake (ms)', 'destroyed (ms)', 'events'],
    d.connections.map((c) => [shortUrl(c.url) || `(id ${c.identifier})`, fmtMs(c.createdMs), fmtMs(c.handshakeMs), c.destroyedMs === null ? 'open' : fmtMs(c.destroyedMs), fmtCount(c.events)]),
  );
  const t2 = mdTable(
    [...offsetHeaders(d.hasUtc), 'event', 'url'],
    d.events.map((e) => [...offsetCells(e, d.hasUtc), e.event, shortUrl(e.url)]),
  );
  return [heading(title), t1, 'Events:', t2, moreLine(d.more), d.omitted].filter(Boolean).join('\n\n');
}
