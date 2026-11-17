// websocket: connections and lifecycle events.

import { fmtMs, fmtCount, mdTable, round3, shortUrl, byStr } from '../format.mjs';
import { emptyBlock, heading, offsetFields, offsetHeaders, offsetCells, topN, moreLine } from './common.mjs';

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
  const evs = ctx.model.websocket.filter((e) => typeof e.ts === 'number' && ctx.inWin(e.ts)).sort((a, b) => a.ts - b.ts);
  let conns = groupSockets(evs);
  const urlOf = new Map(conns.map((c) => [`${c.pid}|${c.identifier}`, c.url]));
  if (ctx.matcher) conns = conns.filter((c) => ctx.matcher(c.url));
  if (!conns.length) return { connections: [], events: [], more: 0, note: 'No WebSocket activity in scope.' };
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
  return { connections, events: t.rows, more: t.more, hasUtc: !!ctx.utc };
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
  return [heading(title), t1, 'Events:', t2, moreLine(d.more)].filter(Boolean).join('\n\n');
}
