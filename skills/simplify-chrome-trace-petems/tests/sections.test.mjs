import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, render } from '../scripts/lib/analyze.mjs';
import { bucketize, collapseQuiet } from '../scripts/lib/sections/timeline.mjs';
import { inpEstimate, groupInteractions } from '../scripts/lib/sections/interactions.mjs';
import { clsSessions } from '../scripts/lib/sections/vitals.mjs';
import { groupOf } from '../scripts/lib/sections/events.mjs';
import { SECTION_KEYS } from '../scripts/lib/sections/index.mjs';
import { TraceBuilder, BASE, richTrace } from './helpers/fixtures.mjs';

const section = (events, key, opts = {}) => analyze(events, { sections: [key], ...opts }).sections[0].data;
const ms = (x) => x * 1000;

describe('long tasks', () => {
  it('subtracts profiler artifacts and never lists an artifact task', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, ms(100));
    b.x('CpuProfiler::StartProfiling', BASE + ms(10), ms(80)); // leaves 20 ms
    b.x('CpuProfiler::StartProfiling', BASE + ms(200), ms(600)); // artifact itself
    b.x('RunTask', BASE + ms(1000), ms(120));
    b.x('CpuProfiler::StopProfiling', BASE + ms(1010), ms(30)); // leaves 90 ms
    const d = section(b.events, 'longtasks');
    assert.equal(d.rows.length, 1);
    assert.equal(d.rows[0].durMs, 90);
    assert.equal(d.rows[0].artifactMs, 30);
    assert.equal(d.excludedArtifacts, 2);
    assert.match(render(analyze(b.events, { sections: ['longtasks'] })), /2 task\(s\) excluded as CPU profiler overhead/);
  });

  it('lists inside (top descendants by self) and top JS during the task', () => {
    const d = section(richTrace().events, 'longtasks');
    const r = d.rows[0];
    assert.deepEqual(r.inside.map((x) => x.name), ['FunctionCall', 'UpdateLayoutTree']);
    assert.equal(r.topJs[0].name, 'heavy');
    assert.equal(r.topJs[0].location, 'app.js:20');
  });

  it('sorts by duration, respects --top and --long-task-ms, marks clipped tasks', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, ms(60));
    b.x('RunTask', BASE + ms(100), ms(200));
    b.x('RunTask', BASE + ms(400), ms(80));
    const d = section(b.events, 'longtasks', { top: 2 });
    assert.deepEqual(d.rows.map((r) => r.durMs), [200, 80]);
    assert.equal(d.more, 1);
    assert.equal(section(b.events, 'longtasks', { longTaskMs: 100 }).rows.length, 1);
    const w = section(b.events, 'longtasks', { window: '150-450' });
    assert.deepEqual(w.rows.map((r) => [r.durMs, r.clipped]), [[200, true], [80, true]]);
  });
});

describe('summary task stats', () => {
  it('computes TBT over tasks > 50 ms after artifact removal', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, ms(40));
    b.x('RunTask', BASE + ms(100), ms(70)); // 20
    b.x('RunTask', BASE + ms(200), ms(150)); // 100
    b.x('RunTask', BASE + ms(400), ms(100));
    b.x('CpuProfiler::StartProfiling', BASE + ms(400), ms(60)); // 40 left -> 0
    const t = section(b.events, 'summary').tasks;
    assert.equal(t.tbtMs, 120);
    assert.equal(t.over50, 2);
    assert.equal(t.count, 4);
    assert.equal(t.busyMs, 40 + 70 + 150 + 40);
  });

  it('busy time is clipped to the window', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, ms(100));
    const d = section(b.events, 'summary', { window: '50-75' });
    assert.equal(d.tasks.busyMs, 25);
    assert.equal(d.tasks.busyPct, 100);
  });
});

describe('timeline', () => {
  it('splits a task across buckets and never exceeds 100%', () => {
    const busy = bucketize([[0, 2500], [2600, 2700]], 0, 1000, 3);
    assert.deepEqual([...busy], [1000, 1000, 600]);
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, ms(2500));
    b.x('RunTask', BASE + ms(500), ms(100), { tid: 2 });
    b.threadName(100, 2, 'CrRendererMain');
    const d = section(b.events, 'timeline');
    assert.ok(d.rows.every((r) => r.quiet || r.busyPct <= 100));
    assert.deepEqual(d.rows.map((r) => r.busyMs), [1000, 1000, 500]);
  });

  it('collapses runs of quiet buckets', () => {
    const mk = (i, q) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, busyMs: q ? 0 : 500, busyPct: q ? 0 : 50, quiet: q });
    const rows = collapseQuiet([mk(0, false), mk(1, true), mk(2, true), mk(3, true), mk(4, false), mk(5, true)]);
    assert.equal(rows.length, 4);
    assert.deepEqual([rows[1].startMs, rows[1].endMs, rows[1].collapsed], [1000, 4000, true]);
    assert.equal(rows[3].collapsed, undefined);
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, ms(900));
    b.x('RunTask', BASE + ms(5000), ms(900));
    const md = render(analyze(b.events, { sections: ['timeline'], window: '0-500' }));
    assert.match(md, /\| 1000-5000 \| quiet \|/);
    assert.match(md, /\| 0 \| 900\.0 \| 90\.0% \| #{18} \| <- window \|/);
  });

  it('covers the whole trace even when a window is set', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, ms(900));
    b.x('RunTask', BASE + ms(2000), ms(900));
    const d = section(b.events, 'timeline', { window: '2000-2500' });
    assert.equal(d.rows[0].busyMs, 900);
    assert.equal(d.rows[d.rows.length - 1].inWindow, true);
  });
});

describe('interactions', () => {
  it('computes phases from EventTiming fields and groups by interactionId', () => {
    const g = groupInteractions([
      { pid: 1, ts: 10, interactionId: 3, type: 'pointerdown', duration: 50, timeStamp: 100, processingStart: 105, processingEnd: 120 },
      { pid: 1, ts: 12, interactionId: 3, type: 'click', duration: 80, timeStamp: 100, processingStart: 130, processingEnd: 160 },
      { pid: 1, ts: 20, interactionId: 4, type: 'keydown', duration: 10, timeStamp: 200, processingStart: 190, processingEnd: 220 },
    ]);
    assert.equal(g.length, 2);
    const a = g[0];
    assert.deepEqual(a.types, ['pointerdown', 'click']);
    assert.equal(a.durationMs, 80);
    assert.equal(a.inputDelayMs, 30);
    assert.equal(a.processingMs, 30);
    assert.equal(a.presentationMs, 20);
    assert.equal(g[1].inputDelayMs, 0, 'negative input delay clamps to 0');
    assert.equal(g[1].presentationMs, 0);
  });

  it('INP: worst below 50 interactions, skip one per 50 above', () => {
    assert.equal(inpEstimate([5, 9, 3]), 9);
    const fifty = Array.from({ length: 50 }, (_, i) => i + 1);
    assert.equal(inpEstimate(fifty), 49);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(inpEstimate(hundred), 98);
    assert.equal(inpEstimate(fifty.slice(0, 49)), 49);
    assert.equal(inpEstimate([]), null);
  });

  it('ignores interactionId 0 and filters rows by --match on type', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, 10);
    b.eventTiming(BASE + 10, { interactionId: 0, type: 'mousemove', duration: 500, timeStamp: 0, processingStart: 0, processingEnd: 0 });
    b.eventTiming(BASE + 20, { interactionId: 1, type: 'keydown', duration: 40, timeStamp: 10, processingStart: 12, processingEnd: 30 });
    b.eventTiming(BASE + 30, { interactionId: 2, type: 'click', duration: 90, timeStamp: 20, processingStart: 22, processingEnd: 40 });
    const d = section(b.events, 'interactions');
    assert.equal(d.count, 2);
    assert.equal(d.inpMs, 90);
    assert.deepEqual(d.rows.map((r) => r.types[0]), ['click', 'keydown']);
    const m = section(b.events, 'interactions', { match: 'KEY' });
    assert.deepEqual(m.rows.map((r) => r.types[0]), ['keydown']);
  });
});

describe('marks', () => {
  it('lists marks, paired measures and console.timeStamp sorted by offset, filtered by --match', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, 10);
    b.measure('boot', BASE + ms(5), ms(20));
    b.mark('ready', BASE + ms(2));
    b.timeStamp('tick', BASE + ms(9));
    b.instant('navigationStart', BASE + 1, { cat: 'blink.user_timing', args: { frame: 'F' } });
    const d = section(b.events, 'marks');
    assert.deepEqual(d.rows.map((r) => [r.kind, r.name, r.offsetMs, r.durMs]), [
      ['mark', 'ready', 2, null],
      ['measure', 'boot', 5, 20],
      ['timeStamp', 'tick', 9, null],
    ]);
    assert.deepEqual(section(b.events, 'marks', { match: '/^bo/' }).rows.map((r) => r.name), ['boot']);
    const t = section(b.events, 'marks', { top: 1 });
    assert.equal(t.more, 2);
    assert.match(render(analyze(b.events, { sections: ['marks'], top: 1 })), /\.\.\.2 more/);
  });
});

describe('network', () => {
  it('builds rollup, sizes, TTFB and truncates long URLs', () => {
    const long = 'https://cdn.example.com/' + 'a'.repeat(150) + '/end.js';
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, 10);
    b.request({ requestId: '1', url: 'https://example.com/', sendTs: BASE + ms(1), responseTs: BASE + ms(11), finishTs: BASE + ms(31), finishBytes: 4096 });
    b.request({ requestId: '2', url: long, sendTs: BASE + ms(2), responseTs: BASE + ms(5), finishTs: BASE + ms(100), dataChunks: [1024, 1024], didFail: true });
    b.request({ requestId: '3', url: 'https://example.com/pending', sendTs: BASE + ms(3) });
    const d = section(b.events, 'network');
    assert.deepEqual(d.rollup, { count: 3, totalKB: 6, failed: 1, slowestMs: 98, slowestUrl: long });
    assert.deepEqual(d.rows.map((r) => [r.ttfbMs, r.durMs, r.sizeKB]), [[10, 30, 4], [3, 98, 2], [null, null, null]]);
    const md = render(analyze(b.events, { sections: ['network'] }));
    const urlCell = md.split('\n').find((l) => l.startsWith('|') && l.includes('end.js')).split('|').slice(-2, -1)[0].trim();
    assert.equal(urlCell.length, 90);
    assert.ok(urlCell.startsWith('cdn.example.com/aaa'));
    assert.ok(urlCell.endsWith('/end.js'));
    assert.ok(urlCell.includes('...'));
    assert.match(md, /\| - \| - \| - \| - \| GET \| example\.com\/pending \|/);
    assert.equal(section(b.events, 'network', { match: 'pending' }).rows.length, 1);
    assert.equal(section(b.events, 'network', { window: '1.5-' }).rows.length, 2);
  });
});

describe('websocket', () => {
  it('groups by identifier with handshake and lifecycle', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, 10);
    b.websocket(7, 'wss://a.test/s', [['WebSocketCreate', BASE + ms(1)], ['WebSocketSendHandshakeRequest', BASE + ms(2)], ['WebSocketReceiveHandshakeResponse', BASE + ms(7)], ['WebSocketDestroy', BASE + ms(50)]]);
    b.websocket(8, 'wss://b.test/s', [['WebSocketCreate', BASE + ms(3)], ['WebSocketSend', BASE + ms(4)]]);
    const d = section(b.events, 'websocket');
    assert.deepEqual(d.connections.map((c) => [c.identifier, c.url, c.createdMs, c.handshakeMs, c.destroyedMs, c.events]), [
      [7, 'wss://a.test/s', 1, 5, 50, 4],
      [8, 'wss://b.test/s', 3, null, null, 2],
    ]);
    assert.equal(d.events.length, 6);
    assert.equal(d.events[3].url, 'wss://b.test/s');
    assert.match(render(analyze(b.events, { sections: ['websocket'] })), /\| open \| 2 \|/);
  });
});

describe('vitals', () => {
  it('reports nav-relative times and CLS session windows', () => {
    const d = section(richTrace().events, 'vitals');
    const fcp = d.rows.find((r) => r.metric === 'First Contentful Paint');
    assert.equal(fcp.sinceNavMs, 149);
    const s = clsSessions([
      { ts: 0, score: 0.1 },
      { ts: 500_000, score: 0.1 },
      { ts: 3_000_000, score: 0.05 },
      { ts: 3_200_000, score: 0.2 },
    ]);
    assert.ok(Math.abs(s.total - 0.45) < 1e-9);
    assert.ok(Math.abs(s.largest.score - 0.25) < 1e-9);
    const capped = clsSessions(Array.from({ length: 7 }, (_, i) => ({ ts: i * 900_000, score: 0.1 })));
    assert.equal(capped.largest.count, 6);
  });
});

describe('events, frequent, categories', () => {
  it('aggregates by name, excludes artifacts, clips to window', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, ms(100));
    b.x('FunctionCall', BASE + ms(10), ms(40));
    b.x('FunctionCall', BASE + ms(20), ms(10)); // nested same name: not double counted in total
    b.x('CpuProfiler::StartProfiling', BASE + ms(60), ms(20));
    b.x('Layout', BASE + ms(200), ms(5));
    const d = section(b.events, 'events');
    const fc = d.rows.find((r) => r.name === 'FunctionCall');
    assert.deepEqual([fc.count, fc.selfMs, fc.totalMs, fc.maxMs], [2, 40, 40, 40]);
    assert.equal(d.artifacts, 1);
    assert.ok(!d.rows.some((r) => r.name.startsWith('CpuProfiler')));
    const w = section(b.events, 'events', { window: '0-30' });
    assert.equal(w.rows.find((r) => r.name === 'RunTask').totalMs, 30);
    assert.ok(!w.rows.some((r) => r.name === 'Layout'));
    const f = section(b.events, 'frequent');
    assert.equal(f.rows[0].name, 'FunctionCall');
    const cats = section(b.events, 'categories');
    assert.equal(cats.rows.find((r) => r.group === 'Script Evaluation').selfMs, 40);
    assert.equal(groupOf('V8.GC_SCAVENGER'), 'Garbage Collection');
    assert.equal(groupOf('LayoutShift'), 'Other');
    assert.equal(groupOf('Layout'), 'Style & Layout');
  });
});

describe('empty sections', () => {
  it('print the heading and an italic note, never an empty table', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, 10);
    const md = render(analyze(b.events, { sections: SECTION_KEYS }));
    assert.match(md, /_No CPU profile in this trace\. Record with "JavaScript samples" enabled\._/);
    for (const re of [/## Vitals\n\n_No page-load vitals/, /## Interactions\n\n_No user interactions/, /## Network\n\n_No network/, /## WebSocket\n\n_No WebSocket/, /## Marks and measures\n\n_No user timing/, /## Long tasks .*\n\n_No main-thread tasks/]) {
      assert.match(md, re);
    }
    assert.ok(!/\|---\|\n\n/.test(md));
  });
});
