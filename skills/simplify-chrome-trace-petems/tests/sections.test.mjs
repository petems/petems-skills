import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, render } from '../scripts/lib/analyze.mjs';
import { bucketize, collapseQuiet, fitBucketMs, MAX_BUCKETS } from '../scripts/lib/sections/timeline.mjs';
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

describe('profiler artifacts in event tables', () => {
  it('excludes work nested inside a profiler artifact from events, frequent and categories', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, ms(100));
    b.x('CpuProfiler::StartProfiling', BASE, ms(60));
    b.x('MajorGC', BASE + ms(10), ms(30)); // recording overhead, not app GC
    b.x('FunctionCall', BASE + ms(70), ms(20)); // real work
    const names = (k) => section(b.events, k).rows.map((r) => r.name);
    assert.ok(!names('events').includes('MajorGC'));
    assert.ok(!names('frequent').includes('MajorGC'));
    assert.ok(names('events').includes('FunctionCall'));
    const groups = section(b.events, 'categories').rows.map((g) => g.group);
    assert.ok(!groups.includes('Garbage Collection'));
    assert.match(section(b.events, 'events').artifactNote, /and 1 event\(s\) nested inside them/);
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

  it('TBT only counts the blocking portion inside the window', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, ms(100)); // blocking portion is 50-100 ms
    b.x('Marker', BASE + ms(200), ms(1));
    assert.equal(section(b.events, 'summary', { window: '99-150' }).tasks.tbtMs, 1);
    assert.equal(section(b.events, 'summary', { window: '0-40' }).tasks.tbtMs, 0, 'first 50 ms is not blocking');
    assert.equal(section(b.events, 'summary', { window: '0-150' }).tasks.tbtMs, 50);
  });

  it('TBT never counts profiler overhead, wherever it sits in the task', () => {
    // 100 ms task with 40 ms of profiler overhead: 60 ms effective, so 10 ms
    // of blocking time, at the end of the effective time.
    const cases = [
      { name: 'end', art: [60, 40], blocking: [50, 60], artifactWindow: '90-100' },
      { name: 'start', art: [0, 40], blocking: [90, 100], artifactWindow: '0-40' },
      { name: 'middle', art: [30, 40], blocking: [90, 100], artifactWindow: '30-70' },
    ];
    for (const c of cases) {
      const b = new TraceBuilder().mainThread();
      b.x('RunTask', BASE, ms(100));
      b.x(c.art[0] === 0 ? 'CpuProfiler::StartProfiling' : 'CpuProfiler::StopProfiling', BASE + ms(c.art[0]), ms(c.art[1]));
      b.x('Marker', BASE + ms(200), ms(1));
      const tbt = (w) => section(b.events, 'summary', { window: w }).tasks.tbtMs;
      assert.equal(tbt('0-150'), 10, `${c.name}: total`);
      assert.equal(tbt(`${c.blocking[0]}-${c.blocking[1]}`), 10, `${c.name}: blocking lands on real work`);
      assert.equal(tbt(c.artifactWindow), 0, `${c.name}: none inside the artifact`);
    }
  });

  it('busy % never exceeds 100% with several threads in scope', () => {
    const b = new TraceBuilder().mainThread().threadName(100, 2, 'CrRendererMain');
    b.x('RunTask', BASE, ms(100));
    b.x('RunTask', BASE, ms(100), { tid: 2 });
    const d = section(b.events, 'summary', { thread: 'all' });
    assert.equal(d.tasks.busyMs, 100);
    assert.ok(d.tasks.busyPct <= 100);
  });
});

describe('timeline', () => {
  it('fits the bucket to at most MAX_BUCKETS with a 1-2-5 size', () => {
    assert.equal(fitBucketMs(88_000, 1000), 1000, 'untouched when it already fits');
    assert.equal(fitBucketMs(88_000, 10), 50);
    assert.equal(fitBucketMs(3e11, 1000), 200_000_000);
    assert.ok(Math.ceil(3e11 / fitBucketMs(3e11, 1000)) <= MAX_BUCKETS);
  });

  it('survives an outlier timestamp years away with bounded buckets and a note', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, ms(10));
    b.x('Outlier', BASE + 10 * 365 * 24 * 3600 * 1e6, ms(1)); // ten years later
    const started = Date.now();
    const d = section(b.events, 'timeline');
    assert.ok(Date.now() - started < 2000);
    assert.ok(d.rows.length <= MAX_BUCKETS);
    assert.ok(d.bucketMs > 1000);
    assert.match(d.widened, /Bucket widened from 1000 ms to .* to keep the timeline within 2,000 buckets/);
    assert.match(render(analyze(b.events, { sections: ['timeline'] }), { format: 'md' }), /Bucket widened/);
  });

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
  it('computes phases from the worst event frame and groups by interactionId', () => {
    const g = groupInteractions([
      { pid: 1, ts: 10, interactionId: 3, type: 'pointerdown', duration: 50, timeStamp: 100, processingStart: 105, processingEnd: 120 },
      { pid: 1, ts: 12, interactionId: 3, type: 'click', duration: 80, timeStamp: 100, processingStart: 130, processingEnd: 160 },
      { pid: 1, ts: 20, interactionId: 4, type: 'keydown', duration: 10, timeStamp: 200, processingStart: 190, processingEnd: 220 },
    ]);
    assert.equal(g.length, 2);
    const a = g[0];
    assert.deepEqual(a.types, ['pointerdown', 'click']);
    assert.equal(a.durationMs, 80);
    // pointerdown ended at 150, click at 180: different frames, so only the
    // click's frame counts.
    assert.equal(a.inputDelayMs, 30);
    assert.equal(a.processingMs, 30);
    assert.equal(a.presentationMs, 20, 'remainder of the duration');
    assert.equal(g[1].inputDelayMs, 0, 'negative input delay clamps to 0');
    assert.equal(g[1].presentationMs, 0);
  });

  it('attributes a slow click handler to processing even when pointerdown is longest', () => {
    // Real Chrome shape: pointerdown has the longest duration but no handler,
    // the click event carries the 395 ms handler.
    const [g] = groupInteractions([
      { pid: 1, ts: 1, interactionId: 9, type: 'pointerdown', duration: 399, timeStamp: 1000, processingStart: 1000.3, processingEnd: 1000.3 },
      { pid: 1, ts: 2, interactionId: 9, type: 'pointerup', duration: 398, timeStamp: 1001, processingStart: 1001.2, processingEnd: 1001.2 },
      { pid: 1, ts: 3, interactionId: 9, type: 'click', duration: 398, timeStamp: 1001, processingStart: 1001.3, processingEnd: 1396.3 },
    ]);
    assert.equal(g.durationMs, 399);
    assert.ok(Math.abs(g.inputDelayMs - 0.3) < 1e-9);
    assert.ok(Math.abs(g.processingMs - 396) < 1e-9);
    assert.ok(Math.abs(g.inputDelayMs + g.processingMs + g.presentationMs - 399) < 1e-9, 'phases sum to duration');
  });

  it('does not count a held pointer as processing', () => {
    // pointerdown painted on its own at 16 ms; the pointer is held until
    // 500 ms; pointerup + click paint together at 520 ms. Handlers are 1 ms.
    const [g] = groupInteractions([
      { pid: 1, ts: 1, interactionId: 4, type: 'pointerdown', duration: 16, timeStamp: 0, processingStart: 0, processingEnd: 1 },
      { pid: 1, ts: 2, interactionId: 4, type: 'pointerup', duration: 20, timeStamp: 500, processingStart: 500, processingEnd: 501 },
      { pid: 1, ts: 3, interactionId: 4, type: 'click', duration: 20, timeStamp: 500, processingStart: 501, processingEnd: 502 },
    ]);
    assert.equal(g.durationMs, 20);
    assert.equal(g.inputDelayMs, 0);
    assert.equal(g.processingMs, 2);
    assert.equal(g.presentationMs, 18);
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
  it('keeps a user measure named like a navigation-timing mark', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, 10);
    b.instant('loadEventEnd', BASE + ms(1), { cat: 'blink.user_timing', args: { frame: 'F' } }); // native mark
    b.measure('loadEventEnd', BASE + ms(3), ms(7)); // user measure with the same name
    const d = section(b.events, 'marks');
    assert.deepEqual(d.rows.map((r) => [r.kind, r.name, r.durMs]), [['measure', 'loadEventEnd', 7]]);
  });

  it('a user measure named navigationStart is a measure, not a navigation', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, 10);
    b.instant('navigationStart', BASE + ms(1), { cat: 'blink.user_timing', args: { frame: 'F1', data: { documentLoaderURL: 'https://real.test/', isLoadingMainFrame: true } } });
    b.instant('firstContentfulPaint', BASE + ms(100), { cat: 'loading', args: { frame: 'F1' } });
    b.measure('navigationStart', BASE + ms(500), ms(20));
    const v = section(b.events, 'vitals');
    assert.equal(v.navigations, 1);
    assert.equal(v.rows.find((r) => r.metric === 'First Contentful Paint').sinceNavMs, 99);
    assert.deepEqual(section(b.events, 'marks').rows.map((r) => [r.kind, r.name, r.durMs]), [['measure', 'navigationStart', 20]]);
  });

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
  it('keeps browser-process requests only when tied to the page frame', () => {
    const b = new TraceBuilder().mainThread().threadName(200, 1, 'CrRendererMain').threadName(1, 1, 'CrBrowserMain');
    b.x('RunTask', BASE, ms(1));
    b.request({ requestId: 'p', url: 'https://page.test/', sendTs: BASE + ms(1), frame: 'PAGE' });
    b.request({ requestId: 'o', url: 'https://other-tab.test/', sendTs: BASE + ms(2), pid: 200, frame: 'OTHER' });
    b.request({ requestId: 'b', url: 'https://page.test/doc', sendTs: BASE + ms(3), pid: 1, frame: 'PAGE' });
    b.request({ requestId: 'x', url: 'https://unrelated.test/', sendTs: BASE + ms(4), pid: 1, frame: 'ELSEWHERE' });
    b.request({ requestId: 'n', url: 'https://unknown.test/', sendTs: BASE + ms(5), pid: 1 });
    const d = section(b.events, 'network');
    assert.deepEqual(d.rows.map((r) => r.url), ['https://page.test/', 'https://page.test/doc']);
    assert.match(d.omitted, /^2 requests from the browser or a service process could not be tied to this page/);
    assert.match(render(analyze(b.events, { sections: ['network'] }), { format: 'md' }), /use --thread all to include them/);
    assert.equal(section(b.events, 'network', { thread: 'all' }).rows.length, 5);
  });

  it('keeps a request id reused by another renderer separate', () => {
    const b = new TraceBuilder().mainThread().threadName(200, 1, 'CrRendererMain');
    b.x('RunTask', BASE, ms(1));
    b.request({ requestId: 'dup', url: 'https://page.test/a', sendTs: BASE + ms(1), responseTs: BASE + ms(11), finishTs: BASE + ms(31), finishBytes: 4096, frame: 'PAGE' });
    b.request({ requestId: 'dup', url: 'https://other-tab.test/secret', sendTs: BASE + ms(2), responseTs: BASE + ms(50), finishTs: BASE + ms(300), finishBytes: 9999, status: 404, method: 'POST', pid: 200, frame: 'OTHER' });
    const d = section(b.events, 'network');
    assert.deepEqual(d.rows.map((r) => [r.url, r.ttfbMs, r.durMs, r.sizeKB, r.status, r.method]), [['https://page.test/a', 10, 30, 4, 200, 'GET']]);
    assert.ok(!render(analyze(b.events, { sections: ['network'] })).includes('other-tab.test'));
    const all = section(b.events, 'network', { thread: 'all' });
    assert.deepEqual(all.rows.map((r) => [r.url, r.ttfbMs, r.durMs, r.status]), [['https://page.test/a', 10, 30, 200], ['https://other-tab.test/secret', 48, 298, 404]]);
  });

  it('joins a browser-sent request to the renderer with the same id and frame', () => {
    const b = new TraceBuilder().mainThread().threadName(200, 1, 'CrRendererMain').threadName(1, 1, 'CrBrowserMain');
    b.x('RunTask', BASE, ms(1));
    // Navigation: the browser emits the send, the page renderer the rest.
    b.instant('ResourceSendRequest', BASE + ms(1), { pid: 1, args: { data: { requestId: 'nav', url: 'https://page.test/doc', requestMethod: 'GET', frame: 'PAGE' } } });
    b.instant('ResourceReceiveResponse', BASE + ms(21), { args: { data: { requestId: 'nav', frame: 'PAGE', statusCode: 200, mimeType: 'text/html' } } });
    b.instant('ResourceFinish', BASE + ms(41), { args: { data: { requestId: 'nav', encodedDataLength: 2048 } } });
    // Another tab's renderer happens to reuse the id.
    b.request({ requestId: 'nav', url: 'https://other-tab.test/secret', sendTs: BASE + ms(2), responseTs: BASE + ms(5), finishTs: BASE + ms(9), status: 500, pid: 200, frame: 'OTHER' });
    const d = section(b.events, 'network');
    assert.deepEqual(d.rows.map((r) => [r.url, r.ttfbMs, r.durMs, r.sizeKB, r.status]), [['https://page.test/doc', 20, 40, 2, 200]]);
    assert.equal(d.omitted, '');
    assert.equal(section(b.events, 'network', { thread: 'all' }).rows.length, 2);
  });

  it('keeps browser-process requests that share an id across frames apart', () => {
    const b = new TraceBuilder().mainThread().threadName(1, 1, 'CrBrowserMain');
    b.tracingStarted([{ frame: 'PAGE', processId: 100, isOutermostMainFrame: true }]);
    b.x('RunTask', BASE, ms(1));
    // Only the sends carry a frame; the browser's later events do not.
    const send = (ts, frame, url, method) => b.instant('ResourceSendRequest', ts, { pid: 1, args: { data: { requestId: 'dup', url, requestMethod: method, frame } } });
    send(BASE + ms(1), 'PAGE', 'https://page.test/doc', 'GET');
    b.instant('ResourceReceiveResponse', BASE + ms(21), { args: { data: { requestId: 'dup', frame: 'PAGE', statusCode: 200, mimeType: 'text/html' } } });
    b.instant('ResourceFinish', BASE + ms(41), { args: { data: { requestId: 'dup', encodedDataLength: 2048 } } });
    send(BASE + ms(50), 'OTHER', 'https://other-tab.test/secret', 'POST');
    b.instant('ResourceReceiveResponse', BASE + ms(60), { pid: 1, args: { data: { requestId: 'dup', statusCode: 500 } } });
    b.instant('ResourceFinish', BASE + ms(90), { pid: 1, args: { data: { requestId: 'dup', encodedDataLength: 9999 } } });
    const d = section(b.events, 'network');
    assert.deepEqual(d.rows.map((r) => [r.url, r.method, r.ttfbMs, r.durMs, r.sizeKB, r.status]), [['https://page.test/doc', 'GET', 20, 40, 2, 200]]);
    assert.ok(!render(analyze(b.events, { sections: ['network'] })).includes('other-tab.test'));
    // The browser never closed the page's send, so its frameless response
    // and finish could belong to either request: they are left unattributed
    // rather than guessed.
    const all = section(b.events, 'network', { thread: 'all' });
    assert.deepEqual(all.rows.map((r) => [r.url, r.method, r.ttfbMs, r.durMs, r.status]), [
      ['https://page.test/doc', 'GET', 20, 40, 200],
      ['https://other-tab.test/secret', 'POST', null, null, null],
    ]);
  });

  it('splits a browser request id reused in one frame, and never guesses frameless events', () => {
    const b = new TraceBuilder().threadName(1, 1, 'CrBrowserMain');
    b.x('RunTask', BASE, ms(1), { pid: 1 });
    // Sequential reuse after a finish: two requests.
    b.request({ requestId: 'seq', url: 'https://a.test/1', sendTs: BASE + ms(1), responseTs: BASE + ms(5), finishTs: BASE + ms(9), pid: 1, frame: 'F' });
    b.request({ requestId: 'seq', url: 'https://a.test/2', sendTs: BASE + ms(20), responseTs: BASE + ms(30), finishTs: BASE + ms(40), status: 404, pid: 1, frame: 'F' });
    // Two frames in flight at once: a frameless response could be either's.
    b.instant('ResourceSendRequest', BASE + ms(50), { pid: 1, args: { data: { requestId: 'par', url: 'https://b.test/x', frame: 'F' } } });
    b.instant('ResourceSendRequest', BASE + ms(51), { pid: 1, args: { data: { requestId: 'par', url: 'https://b.test/y', frame: 'G' } } });
    b.instant('ResourceReceiveResponse', BASE + ms(60), { pid: 1, args: { data: { requestId: 'par', statusCode: 500 } } });
    const all = section(b.events, 'network', { thread: 'all' });
    assert.deepEqual(all.rows.map((r) => [r.url, r.ttfbMs, r.durMs, r.status]), [
      ['https://a.test/1', 4, 8, 200],
      ['https://a.test/2', 10, 20, 404],
      ['https://b.test/x', null, null, null],
      ['https://b.test/y', null, null, null],
    ]);
  });

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
  it('keeps a connection URL when WebSocketCreate is before the window', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, ms(1));
    b.websocket(7, 'wss://sock.test/feed', [['WebSocketCreate', BASE + ms(1)], ['WebSocketSendHandshakeRequest', BASE + ms(50)], ['WebSocketDestroy', BASE + ms(90)]]);
    const d = section(b.events, 'websocket', { window: '40-100', match: 'sock.test' });
    assert.equal(d.connections.length, 1);
    assert.equal(d.connections[0].url, 'wss://sock.test/feed');
    assert.equal(d.connections[0].events, 2, 'counts stay window-scoped');
  });

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

  it('bounds the connection table by --top', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, 10);
    for (let i = 0; i < 30; i++) b.websocket(i, `wss://s${i}.test/`, [['WebSocketCreate', BASE + ms(1 + i)]]);
    const d = section(b.events, 'websocket', { top: 1 });
    assert.deepEqual(d.connections.map((c) => c.url), ['wss://s0.test/']);
    assert.equal(d.connectionsMore, 29);
    assert.equal(d.events.length, 1);
    assert.equal(d.more, 29);
    const md = render(analyze(b.events, { sections: ['websocket'], top: 1 }));
    assert.equal((md.match(/\| s\d+\.test\//g) || []).length, 2, 'one connection row and one event row');
    assert.equal((md.match(/\.\.\.29 more/g) || []).length, 2);
    assert.equal(JSON.parse(render(analyze(b.events, { sections: ['websocket'], top: 1 }), { format: 'json' })).sections.websocket.connectionsMore, 29);
  });
});

describe('vitals', () => {
  const twoNavs = (withFirstFcp) => {
    const b = new TraceBuilder().mainThread();
    const nav = (t, url) => b.instant('navigationStart', BASE + ms(t), { cat: 'blink.user_timing', args: { frame: 'F1', data: { documentLoaderURL: url, isLoadingMainFrame: true } } });
    const at = (name, t, data = {}) => b.instant(name, BASE + ms(t), { cat: 'loading', args: { frame: 'F1', data } });
    nav(0, 'https://a.test/one');
    if (withFirstFcp) at('firstContentfulPaint', 100);
    at('largestContentfulPaint::Candidate', 200, { size: 1 });
    b.instant('LayoutShift', BASE + ms(50), { args: { frame: 'F1', data: { score: 0.3, had_recent_input: false } } });
    nav(1000, 'https://a.test/two');
    at('firstContentfulPaint', 1100);
    at('largestContentfulPaint::Candidate', 1200, { size: 2 });
    b.instant('LayoutShift', BASE + ms(1150), { args: { frame: 'F1', data: { score: 0.01, had_recent_input: false } } });
    return section(b.events, 'vitals');
  };

  it('keeps every metric within the chosen navigation', () => {
    const d = twoNavs(true); // first navigation is chosen (precedes the first paint)
    const lcp = d.rows.find((r) => r.metric === 'Largest Contentful Paint');
    assert.equal(lcp.sinceNavMs, 200, 'not the second page LCP');
    assert.equal(d.cls.shifts, 1);
    assert.equal(d.cls.total, 0.3);
  });

  it('chooses the navigation from the whole trace, then windows the metrics', () => {
    const build = () => {
      const b = new TraceBuilder().mainThread();
      const nav = (t) => b.instant('navigationStart', BASE + ms(t), { cat: 'blink.user_timing', args: { frame: 'F1', data: { documentLoaderURL: `https://a.test/${t}`, isLoadingMainFrame: true } } });
      const fcp = (t) => b.instant('firstContentfulPaint', BASE + ms(t), { cat: 'loading', args: { frame: 'F1' } });
      nav(0);
      fcp(100);
      nav(1000);
      fcp(1100);
      return b.events;
    };
    const metric = (d, m) => d.rows.find((r) => r.metric === m);
    // Window starts after the first navigation: its FCP still belongs to it.
    const early = section(build(), 'vitals', { window: '50-1200' });
    assert.equal(metric(early, 'First Contentful Paint').offsetMs, 100);
    assert.equal(metric(early, 'First Contentful Paint').sinceNavMs, 100);
    assert.equal(metric(early, 'Navigation start'), undefined, 'navigation row is outside the window');
    // Window holding only the second page load picks the second navigation.
    const late = section(build(), 'vitals', { window: '500-1200' });
    assert.equal(metric(late, 'Navigation start').detail, 'a.test/1000');
    assert.equal(metric(late, 'First Contentful Paint').sinceNavMs, 100);
  });

  it('anchors on the earliest metric in the window, not a later FCP', () => {
    const b = new TraceBuilder().mainThread();
    const nav = (t) => b.instant('navigationStart', BASE + ms(t), { cat: 'blink.user_timing', args: { frame: 'F1', data: { documentLoaderURL: `https://a.test/${t}`, isLoadingMainFrame: true } } });
    const at = (name, t, data = {}) => b.instant(name, BASE + ms(t), { cat: 'loading', args: { frame: 'F1', data } });
    nav(0);
    at('firstContentfulPaint', 100);
    at('largestContentfulPaint::Candidate', 200, { size: 1 });
    nav(1000);
    at('firstContentfulPaint', 1100);
    // Window holds page A's LCP, then page B's navigation and FCP.
    const d = section(b.events, 'vitals', { window: '150-1200' });
    const lcp = d.rows.find((r) => r.metric === 'Largest Contentful Paint');
    assert.equal(lcp && lcp.offsetMs, 200, "page A's LCP is kept");
    assert.equal(d.rows.find((r) => r.metric === 'First Contentful Paint'), undefined, "page B's FCP belongs to another page");
    // A window whose first metric is a layout shift anchors on it too.
    b.instant('LayoutShift', BASE + ms(1050), { args: { frame: 'F1', data: { score: 0.1, had_recent_input: false } } });
    const s = section(b.events, 'vitals', { window: '1040-1200' });
    assert.equal(s.rows.find((r) => r.metric === 'First Contentful Paint').sinceNavMs, 100, 'relative to page B');
    assert.equal(s.cls.shifts, 1);
  });

  it('counts only the chosen page layout shifts in CLS', () => {
    // Page one's earliest metric is its layout shift, so page one is chosen
    // for the whole trace: page two's shift is excluded.
    const whole = twoNavs(false);
    assert.equal(whole.cls.shifts, 1);
    assert.equal(whole.cls.total, 0.3);
    // A window over page two only: page one's shift is excluded.
    const d = (() => {
      const b = new TraceBuilder().mainThread();
      const nav = (t, url) => b.instant('navigationStart', BASE + ms(t), { cat: 'blink.user_timing', args: { frame: 'F1', data: { documentLoaderURL: url, isLoadingMainFrame: true } } });
      nav(0, 'https://a.test/one');
      b.instant('LayoutShift', BASE + ms(50), { args: { frame: 'F1', data: { score: 0.3, had_recent_input: false } } });
      nav(1000, 'https://a.test/two');
      b.instant('firstContentfulPaint', BASE + ms(1100), { cat: 'loading', args: { frame: 'F1' } });
      b.instant('LayoutShift', BASE + ms(1150), { args: { frame: 'F1', data: { score: 0.01, had_recent_input: false } } });
      return section(b.events, 'vitals', { window: '900-1300' });
    })();
    assert.equal(d.rows.find((r) => r.metric === 'Navigation start').detail, 'a.test/two');
    assert.equal(d.cls.shifts, 1);
    assert.equal(d.cls.total, 0.01);
    assert.ok(d.rows.every((r) => r.sinceNavMs >= 0), 'no negative nav-relative times');
  });

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
