import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildNesting, topLevelTasks, overlap } from '../scripts/lib/nesting.mjs';
import { collectEvents } from '../scripts/lib/collect.mjs';
import { detectMainThreads, resolveThreads } from '../scripts/lib/threads.mjs';
import { UserError } from '../scripts/lib/errors.mjs';
import { analyze, render } from '../scripts/lib/analyze.mjs';
import { TraceBuilder, BASE, PID, TID } from './helpers/fixtures.mjs';

const ev = (name, ts, dur) => ({ name, cat: 'c', ts, dur });
const byName = (nest) => {
  const m = {};
  nest.events.forEach((e, k) => (m[e.name] = { self: nest.self[k], depth: nest.depth[k], winSelf: nest.winSelf[k], winDur: nest.winDur[k], k }));
  return m;
};

describe('self time and nesting', () => {
  it('subtracts direct children only', () => {
    const n = byName(buildNesting([ev('A', 0, 100), ev('B', 10, 50), ev('C', 20, 10), ev('D', 70, 20)]));
    assert.equal(n.A.self, 100 - 50 - 20);
    assert.equal(n.B.self, 40);
    assert.equal(n.C.self, 10);
    assert.equal(n.D.self, 20);
    assert.deepEqual([n.A.depth, n.B.depth, n.C.depth, n.D.depth], [0, 1, 2, 1]);
  });

  it('clips a child that overruns its parent', () => {
    const nest = buildNesting([ev('P', 0, 100), ev('Kid', 80, 50), ev('Next', 110, 10)]);
    const n = byName(nest);
    assert.equal(n.P.self, 80); // only 20 of Kid counted against P
    assert.equal(n.Kid.self, 50);
    assert.equal(n.Next.depth, 0, 'event after parent end is top level, not a child of the overrun');
  });

  it('orders ties by duration descending (longer is parent), stable otherwise', () => {
    const n = byName(buildNesting([ev('short', 0, 10), ev('long', 0, 100)]));
    assert.equal(n.long.depth, 0);
    assert.equal(n.short.depth, 1);
    assert.equal(n.long.self, 90);
    const same = buildNesting([ev('first', 0, 10), ev('second', 0, 10)]);
    assert.equal(same.events[0].name, 'first');
    assert.equal(same.depth[1], 1);
    assert.equal(same.self[0], 0);
  });

  it('clamps self time at zero', () => {
    const n = byName(buildNesting([ev('A', 0, 10), ev('B', 0, 10), ev('C', 0, 10)]));
    assert.ok(n.A.self >= 0 && n.B.self >= 0);
  });

  it('clips aggregate time to the window (overlap, not containment)', () => {
    const n = byName(buildNesting([ev('A', 0, 100), ev('B', 40, 40)], { start: 50, end: 70 }));
    assert.equal(n.A.winDur, 20);
    assert.equal(n.A.winSelf, 0);
    assert.equal(n.B.winDur, 20);
    assert.equal(n.B.winSelf, 20);
    assert.equal(overlap(0, 10, 20, 30), 0);
  });

  it('flags same-name ancestors and subtracts artifacts from tasks', () => {
    const nest = buildNesting([ev('RunTask', 0, 100), ev('FunctionCall', 0, 50), ev('FunctionCall', 10, 10), ev('CpuProfiler::StartProfiling', 60, 30)]);
    assert.equal(nest.sameNameAncestor[2], 1);
    assert.equal(nest.sameNameAncestor[1], 0);
    const [task] = topLevelTasks(nest);
    assert.equal(task.effDur, 70);
    assert.equal(task.artifact, false);
  });
});

describe('collector', () => {
  it('pairs B/E per thread (E closes the most recent B) and drops unclosed B', () => {
    const b = new TraceBuilder();
    b.begin('Outer', 10).begin('Inner', 20).end(30).end(50);
    b.begin('Other', 15, { tid: 2 }).end(25, { tid: 2 });
    b.begin('Never', 60);
    b.end(70, { tid: 3 });
    const m = collectEvents(b.events);
    const t1 = m.threads.find((t) => t.tid === TID);
    assert.deepEqual(t1.events.map((e) => [e.name, e.ts, e.dur]).sort(), [['Inner', 20, 10], ['Outer', 10, 40]]);
    const t2 = m.threads.find((t) => t.tid === 2);
    assert.deepEqual(t2.events.map((e) => [e.name, e.dur]), [['Other', 10]]);
    assert.ok(m.warnings.some((w) => /1 unclosed B/.test(w)));
    assert.ok(m.warnings.some((w) => /without a matching B/.test(w)));
  });

  it('uses the smallest positive non-metadata ts as origin', () => {
    const b = new TraceBuilder();
    b.mainThread();
    b.x('A', 0, 5);
    b.x('B', 500, 5);
    b.instant('I', 300);
    const m = collectEvents(b.events);
    assert.equal(m.origin, 300);
    assert.equal(m.maxEnd, 505);
  });

  it('records thread and process names from M events', () => {
    const b = new TraceBuilder().processName(PID, 'Renderer').mainThread();
    b.x('A', BASE, 5);
    const m = collectEvents(b.events);
    assert.equal(m.threads[0].name, 'CrRendererMain');
    assert.equal(m.threads[0].processName, 'Renderer');
  });
});

describe('main thread detection', () => {
  const base = () => {
    const b = new TraceBuilder();
    b.threadName(1, 1, 'CrBrowserMain').x('X', BASE, 1, { pid: 1, tid: 1 });
    b.threadName(200, 5, 'CrRendererMain').x('X', BASE, 1, { pid: 200, tid: 5 });
    b.threadName(300, 7, 'CrRendererMain').x('X', BASE, 1, { pid: 300, tid: 7 });
    return b;
  };

  it('1-2: uses TracingStartedInBrowser main frame pid, then CrRendererMain there', () => {
    const b = base();
    b.tracingStarted([
      { frame: 'SUB', processId: 200, parent: 'MAIN' },
      { frame: 'MAIN', processId: 300, isOutermostMainFrame: true },
    ]);
    const r = detectMainThreads(collectEvents(b.events));
    assert.deepEqual(r.threads.map((t) => t.pid), [300]);
    assert.match(r.reason, /TracingStartedInBrowser/);
  });

  it('honours FrameCommittedInBrowser / ProcessReadyInBrowser for the main frame', () => {
    const b = base();
    b.tracingStarted([{ frame: 'MAIN', processId: 999, isOutermostMainFrame: true }]);
    b.instant('FrameCommittedInBrowser', BASE + 10, { pid: 1, tid: 1, args: { data: { frame: 'MAIN', processId: 200 } } });
    const r = detectMainThreads(collectEvents(b.events));
    assert.deepEqual(r.threads.map((t) => t.pid), [200]);
  });

  it('falls back to isInPrimaryMainFrame, then frames without a parent', () => {
    const b = base();
    b.tracingStarted([{ frame: 'A', processId: 200, isInPrimaryMainFrame: true }, { frame: 'B', processId: 300, parent: 'A' }]);
    assert.deepEqual(detectMainThreads(collectEvents(b.events)).threads.map((t) => t.pid), [200]);
    const c = base();
    c.tracingStarted([{ frame: 'A', processId: 300 }, { frame: 'B', processId: 200, parent: 'A' }]);
    assert.deepEqual(detectMainThreads(collectEvents(c.events)).threads.map((t) => t.pid), [300]);
  });

  it('3: with no frame info, picks the busiest CrRendererMain and warns (never combines tabs)', () => {
    const b = base();
    b.x('Busy', BASE + 10, 5000, { pid: 300, tid: 7 });
    const r = detectMainThreads(collectEvents(b.events));
    assert.deepEqual(r.threads.map((t) => t.pid), [300]);
    assert.match(r.reason, /busiest CrRendererMain/);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /2 renderer main threads \(pids 200, 300\).*analysed the busiest \(pid 300, tid 7\).*--thread pid:tid/);
    const one = new TraceBuilder().threadName(200, 5, 'CrRendererMain').x('X', BASE, 1, { pid: 200, tid: 5 });
    assert.deepEqual(detectMainThreads(collectEvents(one.events)).warnings, [], 'a single renderer needs no warning');
  });

  it('multi-tab trace: picks one top-level frame and warns, never both', () => {
    const b = base();
    b.tracingStarted([
      { frame: 'TAB1', processId: 200, isOutermostMainFrame: true, url: 'https://inspected.test/' },
      { frame: 'TAB2', processId: 300, isOutermostMainFrame: true, url: 'https://other-tab.test/secret' },
    ]);
    const r = detectMainThreads(collectEvents(b.events));
    assert.deepEqual(r.threads.map((t) => t.pid), [200], 'first listed frame only');
    assert.match(r.warnings[0], /2 top-level frames \(renderer pids 200, 300\); analysed the first listed \(pid 200\)/);
    assert.ok(!r.warnings[0].includes('other-tab.test'), 'warning never exposes the other tab URL');
  });

  it('multi-tab trace: the primary main frame settles it without a warning', () => {
    const b = base();
    b.tracingStarted([
      { frame: 'TAB1', processId: 200, isOutermostMainFrame: true },
      { frame: 'TAB2', processId: 300, isOutermostMainFrame: true, isInPrimaryMainFrame: true },
    ]);
    const r = detectMainThreads(collectEvents(b.events));
    assert.deepEqual(r.threads.map((t) => t.pid), [300]);
    assert.deepEqual(r.warnings, []);
  });

  it('multi-tab trace: the other tab stays out of tasks, functions and network', () => {
    const b = base();
    b.tracingStarted([
      { frame: 'TAB1', processId: 200, isOutermostMainFrame: true },
      { frame: 'TAB2', processId: 300, isOutermostMainFrame: true },
    ]);
    b.x('RunTask', BASE + 100, 80_000, { pid: 200, tid: 5 });
    b.x('OtherTabWork', BASE + 100, 90_000, { pid: 300, tid: 7 });
    b.request({ requestId: 'a', url: 'https://inspected.test/', sendTs: BASE + 200, pid: 200, tid: 5, frame: 'TAB1' });
    b.request({ requestId: 'b', url: 'https://other-tab.test/secret', sendTs: BASE + 300, pid: 300, tid: 7, frame: 'TAB2' });
    b.request({ requestId: 'c', url: 'https://other-tab.test/via-browser', sendTs: BASE + 400, pid: 1, tid: 1, frame: 'TAB2' });
    const out = render(analyze(b.events, { sections: ['summary', 'longtasks', 'events', 'network'] }), { format: 'md' });
    assert.ok(!out.includes('other-tab.test'), 'no URL from the other tab anywhere in the report');
    assert.ok(!out.includes('OtherTabWork'));
    assert.match(out, /inspected\.test/);
    assert.match(out, /analysed the first listed/);
  });

  it('4: CrBrowserMain when there is no renderer', () => {
    const b = new TraceBuilder().threadName(1, 1, 'CrBrowserMain').x('X', BASE, 1, { pid: 1, tid: 1 });
    b.threadName(2, 2, 'Busy').x('Y', BASE, 1000, { pid: 2, tid: 2 });
    const r = detectMainThreads(collectEvents(b.events));
    assert.equal(r.threads[0].name, 'CrBrowserMain');
  });

  it('5: thread with the most duration otherwise', () => {
    const b = new TraceBuilder();
    b.x('A', BASE, 10, { pid: 1, tid: 1 }).x('B', BASE, 500, { pid: 2, tid: 2 }).x('C', BASE + 600, 100, { pid: 1, tid: 1 });
    const r = detectMainThreads(collectEvents(b.events));
    assert.equal(r.threads[0].pid, 2);
  });

  it('--thread accepts a name, pid:tid or all, and errors clearly otherwise', () => {
    const b = base();
    b.threadName(200, 9, 'DedicatedWorker thread').x('W', BASE, 1, { pid: 200, tid: 9 });
    const m = collectEvents(b.events);
    assert.equal(resolveThreads(m, 'DedicatedWorker thread').threads[0].tid, 9);
    assert.equal(resolveThreads(m, 'dedicatedworker THREAD').threads[0].tid, 9);
    assert.equal(resolveThreads(m, '300:7').threads[0].pid, 300);
    const all = resolveThreads(m, 'all');
    assert.equal(all.all, true);
    assert.equal(all.threads.length, 4);
    assert.throws(() => resolveThreads(m, 'Nope'), UserError);
    assert.throws(() => resolveThreads(m, '1:999'), UserError);
  });

  it('--thread by name refuses to combine matches from different processes (tabs)', () => {
    const b = base();
    b.threadName(200, 9, 'DedicatedWorker thread').x('W', BASE, 1, { pid: 200, tid: 9 });
    b.threadName(300, 8, 'DedicatedWorker\nthread').x('W', BASE, 1, { pid: 300, tid: 8 });
    const m = collectEvents(b.events);
    // Both spellings clean to the same name, so the lookup must match both.
    for (const name of ['DedicatedWorker thread', 'dedicatedworker THREAD']) {
      assert.throws(
        () => resolveThreads(m, name),
        (err) => err instanceof UserError && /matches threads in 2 processes \(200:9, 300:8\)/.test(err.message) && /--thread pid:tid/.test(err.message) && !err.message.includes('\n'),
      );
    }
    assert.deepEqual(resolveThreads(m, '300:8').threads.map((t) => `${t.pid}:${t.tid}`), ['300:8']);
    assert.throws(() => resolveThreads(m, 'CrRendererMain'), /200:5, 300:7/);
  });

  it('--thread by name combines same-named threads within one process', () => {
    const b = base();
    for (const tid of [11, 12]) b.threadName(200, tid, 'ThreadPoolForegroundWorker').x('P', BASE, 1, { pid: 200, tid });
    const r = resolveThreads(collectEvents(b.events), 'ThreadPoolForegroundWorker');
    assert.deepEqual(r.threads.map((t) => `${t.pid}:${t.tid}`).sort(), ['200:11', '200:12']);
    assert.match(r.reason, /2 threads in pid 200/);
  });
});
