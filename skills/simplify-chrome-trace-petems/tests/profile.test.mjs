import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTimes, median, buildProfiles, aggregateSamples, frameLocation } from '../scripts/lib/profile.mjs';
import { collectEvents } from '../scripts/lib/collect.mjs';
import { analyze } from '../scripts/lib/analyze.mjs';
import { TraceBuilder, BASE } from './helpers/fixtures.mjs';

const NODES = [
  { id: 1, functionName: '(root)' },
  { id: 2, parent: 1, functionName: '(program)' },
  { id: 3, parent: 1, functionName: '(idle)' },
  { id: 4, parent: 1, functionName: 'outer', url: 'https://a.test/app.js', lineNumber: 0, columnNumber: 0 },
  { id: 5, parent: 4, functionName: 'inner', url: 'https://a.test/app.js', lineNumber: 41, columnNumber: 6 },
  // recursion: outer -> inner -> outer(again, same frame) -> leaf
  { id: 6, parent: 5, functionName: 'outer', url: 'https://a.test/app.js', lineNumber: 0, columnNumber: 0 },
  { id: 7, parent: 6, functionName: '', url: 'https://a.test/app.js', lineNumber: 9, columnNumber: 1 },
  { id: 8, parent: 1, functionName: '(garbage collector)' },
];

function prof(opts) {
  const b = new TraceBuilder().mainThread();
  b.x('RunTask', BASE, 1_000_000);
  b.profile({ nodes: NODES, ...opts });
  const m = collectEvents(b.events);
  return { m, p: buildProfiles(m.profiles) };
}

describe('CPU profile', () => {
  it('sample i lasts until sample i+1; last sample gets the median interval', () => {
    const { times, durs } = sampleTimes(1000, [10, 100, 200, 100, 400]);
    assert.deepEqual([...times], [1010, 1110, 1310, 1410, 1810]);
    assert.deepEqual([...durs], [100, 200, 100, 400, 150]);
    assert.equal(median([3, 1, 2]), 2);
  });

  it('clamps negative intervals to 0', () => {
    const { durs } = sampleTimes(0, [100, -50, 100]);
    assert.equal(durs[0], 0);
    assert.equal(durs[1], 100);
  });

  it('out-of-order samples do not double count time once sorted', () => {
    // times: 100, 50, 150, 200 -> sorted 50, 100, 150, 200 (50 us apart)
    const { p } = prof({ samples: [7, 5, 3, 2], deltas: [100, -50, 100, 50] });
    const th = [...p.threads.values()][0];
    assert.deepEqual([...th.times].map((t) => t - th.times[0]), [0, 50, 100, 150]);
    assert.deepEqual([...th.durs], [50, 50, 50, 50]);
    const sum = th.durs.reduce((a, b) => a + b, 0);
    assert.equal(sum, th.times[th.times.length - 1] - th.times[0] + 50);
  });

  it('reconstructs profiles across chunks with incremental nodes', () => {
    const { p } = prof({ samples: [7, 7, 5, 3, 2, 8], deltas: [0, 10, 10, 10, 10, 10], chunks: 3 });
    assert.equal(p.threads.size, 1);
    const th = [...p.threads.values()][0];
    assert.equal(th.times.length, 6);
    assert.equal(th.times[0], BASE);
  });

  it('accepts timeDeltas inside cpuProfile and children instead of parent', () => {
    const { p } = prof({ samples: [7, 5], deltas: [0, 10], deltasInCpuProfile: true, useChildren: true });
    const th = [...p.threads.values()][0];
    const a = aggregateSamples(p, th, -Infinity, Infinity);
    const names = [...a.total.keys()].map((f) => p.frames[f].functionName).sort();
    assert.deepEqual(names, ['', 'inner', 'outer']);
  });

  it('counts recursive frames once per sample in total time', () => {
    const { p } = prof({ samples: [7, 7], deltas: [0, 10] });
    const th = [...p.threads.values()][0];
    const a = aggregateSamples(p, th, -Infinity, Infinity);
    const outer = p.frames.findIndex((f) => f.functionName === 'outer');
    assert.equal(a.total.get(outer), 20); // not 40
    assert.equal(a.self.get(outer), undefined);
  });

  it('cyclic parent chains stop at the first repeated node, one global node per profile node', () => {
    // 1 -> 2 -> 3 -> 2 (cycle that does not return to the start), a self-loop
    // 4 -> 4, and a second disjoint cycle 5 -> 6 -> 7 -> 6.
    const fn = (id, parent) => ({ id, parent, functionName: `f${id}`, url: 'https://a.test/c.js', lineNumber: id });
    const nodes = [fn(1, 2), fn(2, 3), fn(3, 2), fn(4, 4), fn(5, 6), fn(6, 7), fn(7, 6)];
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, 1_000_000);
    b.profile({ nodes, samples: [1, 4, 5, 3, 7], deltas: [0, 1000, 1000, 1000, 1000] });
    const m = collectEvents(b.events);
    const p = buildProfiles(m.profiles);
    assert.ok(p.nodes.length <= nodes.length, `global nodes ${p.nodes.length} must not exceed profile nodes ${nodes.length}`);
    const th = [...p.threads.values()][0];
    const a = aggregateSamples(p, th, -Infinity, Infinity);
    const total = Object.fromEntries([...a.total].map(([f, d]) => [p.frames[f].functionName, d]));
    assert.equal(total.f1, 1000);
    // The walk from 1 stops when it meets 2 again, so 3 becomes the root: 3 -> 2 -> 1.
    assert.equal(total.f2, 1000);
    assert.equal(total.f3, 2000, 'f3 is on the stacks of samples 1 and 3');
    const r = analyze(b.events, { sections: ['summary', 'functions'] });
    assert.equal(r.sections[1].data.rows.length, 7, 'analysis completes with every frame on a sampled stack');
  });

  it('a very deep parent chain stays linear in memory and keeps inclusive time', () => {
    const N = 50_000;
    const nodes = [];
    for (let id = 1; id <= N; id++) nodes.push({ id, parent: id > 1 ? id - 1 : undefined, functionName: `d${id}`, url: 'https://a.test/d.js', lineNumber: id });
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, 1_000_000);
    b.profile({ nodes, samples: [N, N], deltas: [0, 1000] });
    const p = buildProfiles(collectEvents(b.events).profiles);
    assert.equal(p.nodes.length, N);
    const a = aggregateSamples(p, [...p.threads.values()][0], -Infinity, Infinity);
    assert.equal(a.total.size, N);
    assert.equal(a.total.get(p.frames.findIndex((f) => f.functionName === 'd1')), 2000);
  });

  it('many samples on a deep recursive stack aggregate in linear time with correct totals', () => {
    // main -> rec0 -> rec1 -> ... -> rec49 -> rec0 -> ... (20,000 deep), plus
    // a shallow side branch. Walking every sample's whole stack would cost
    // 20,000 x 20,000 steps per aggregation.
    const N = 20_000;
    const url = 'https://a.test/r.js';
    const nodes = [{ id: 1, functionName: 'main', url, lineNumber: 1000 }];
    for (let id = 2; id <= N; id++) nodes.push({ id, parent: id - 1, functionName: `rec${id % 50}`, url, lineNumber: id % 50 });
    nodes.push({ id: N + 1, parent: 1, functionName: 'side', url, lineNumber: 2000 });
    const samples = new Array(N).fill(N);
    samples[N - 1] = N + 1;
    const deltas = new Array(N).fill(1000);
    const b = new TraceBuilder().mainThread();
    // 100 long tasks so the long-task section aggregates once per task
    for (let k = 0; k < 100; k++) b.x('RunTask', BASE + k * 200_000, 100_000);
    b.profile({ nodes, samples, deltas });
    const p = buildProfiles(collectEvents(b.events).profiles);
    const a = aggregateSamples(p, [...p.threads.values()][0], -Infinity, Infinity);
    const fi = (name) => p.frames.findIndex((f) => f.functionName === name);
    assert.equal(a.total.size, 52);
    assert.equal(a.total.get(fi('main')), N * 1000);
    assert.equal(a.total.get(fi('side')), 1000);
    for (let r = 0; r < 50; r++) assert.equal(a.total.get(fi(`rec${r}`)), (N - 1) * 1000, `rec${r} counted once per sample`);
    assert.equal(a.self.get(fi(`rec${N % 50}`)), (N - 1) * 1000);
    const t0 = performance.now();
    const r = analyze(b.events, { sections: ['summary', 'functions', 'scripts', 'longtasks'], top: 200 });
    const elapsed = performance.now() - t0;
    assert.equal(r.sections.find((s) => s.key === 'longtasks').data.rows.length, 100);
    assert.ok(elapsed < 1000, `full analysis took ${elapsed.toFixed(0)} ms`);
  });

  it('counts only the part of each sample inside a half-open range', () => {
    // samples at 0, 1000, 2000, 3000 (relative), each lasting 1000 us
    const { p } = prof({ samples: [5, 5, 5, 5], deltas: [0, 1000, 1000, 1000], chunks: 1 });
    const th = [...p.threads.values()][0];
    const t0 = th.times[0];
    const exact = aggregateSamples(p, th, t0 + 1000, t0 + 2000);
    assert.equal(exact.count, 1, 'the sample starting at the end belongs to the next range');
    assert.equal(exact.sampled, 1000);
    const partial = aggregateSamples(p, th, t0 + 1500, t0 + 2500);
    assert.equal(partial.count, 2);
    assert.equal(partial.sampled, 1000, 'never more than the range');
  });

  it('adjacent ranges never share a sample', () => {
    const { p } = prof({ samples: [5, 7, 5, 7], deltas: [0, 1000, 1000, 1000] });
    const th = [...p.threads.values()][0];
    const t0 = th.times[0];
    const first = aggregateSamples(p, th, t0, t0 + 2000);
    const second = aggregateSamples(p, th, t0 + 2000, t0 + 4000);
    assert.equal(first.sampled + second.sampled, aggregateSamples(p, th, t0, t0 + 4000).sampled);
  });

  it('does not hand the gap between two profiles on one thread to a sample', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, 10_000_000);
    b.profile({ nodes: NODES, samples: [5, 5], deltas: [0, 1000] });
    b.profile({ id: '0x9', startTime: BASE + 5_000_000, nodes: NODES, samples: [5, 5], deltas: [0, 1000] });
    const m = collectEvents(b.events);
    const p = buildProfiles(m.profiles);
    const th = [...p.threads.values()][0];
    assert.equal(th.times.length, 4);
    const a = aggregateSamples(p, th, -Infinity, Infinity);
    assert.equal(a.sampled, 4000, 'two 2-sample profiles at 1 ms intervals');
  });

  it('reports idle, program and GC separately and excludes synthetic frames', () => {
    const { p } = prof({ samples: [3, 2, 8, 5], deltas: [0, 10, 10, 10] });
    const th = [...p.threads.values()][0];
    const a = aggregateSamples(p, th, -Infinity, Infinity);
    assert.equal(a.idle, 10);
    assert.equal(a.program, 10);
    assert.equal(a.gc, 10);
    assert.ok(p.frames.every((f) => !f.functionName.startsWith('(')));
  });

  it('reports 1-based line and column numbers', () => {
    assert.equal(frameLocation({ url: 'https://a/x.js', lineNumber: 0, columnNumber: 0 }), 'https://a/x.js:1:1');
    assert.equal(frameLocation({ url: 'https://a/x.js', lineNumber: 41, columnNumber: 6 }), 'https://a/x.js:42:7');
    assert.equal(frameLocation({ url: '', codeType: 'other', lineNumber: -1, columnNumber: -1 }), '(native)');
    assert.equal(frameLocation({ url: '', codeType: 'wasm', lineNumber: -1, columnNumber: -1 }), 'wasm');
  });

  it('functions section: self %, anonymous name, location, per-sample window', () => {
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, 1_000_000);
    b.profile({ nodes: NODES, samples: [7, 7, 5, 3, 2], deltas: [0, 1000, 1000, 1000, 1000] });
    const r = analyze(b.events, { sections: ['functions'] });
    const rows = r.sections[0].data.rows;
    assert.equal(rows[0].function, '(anonymous)');
    assert.equal(rows[0].selfMs, 2);
    assert.equal(rows[0].location, 'a.test/app.js:10:2');
    assert.equal(rows[0].selfPct, 50); // of 4 ms non-idle
    // [0, 1.5 ms): all of the first sample and half of the second
    const w = analyze(b.events, { sections: ['functions'], window: '0-1.5' });
    assert.equal(w.sections[0].data.rows[0].selfMs, 1.5);
    assert.equal(w.sections[0].data.rows.length, 3);
    // [1.5, 2.5 ms): half of the second (anonymous) and half of the third (inner)
    const w2 = analyze(b.events, { sections: ['functions'], window: '1.5-2.5' });
    const got = Object.fromEntries(w2.sections[0].data.rows.map((x) => [x.function, x.selfMs]));
    assert.equal(got['(anonymous)'], 0.5);
    assert.equal(got.inner, 0.5);
  });

  it('functions section adds a thread column when several threads contribute', () => {
    const b = new TraceBuilder().mainThread().threadName(100, 2, 'DedicatedWorker thread');
    b.x('RunTask', BASE, 1000).x('RunTask', BASE, 1000, { tid: 2 });
    b.profile({ nodes: NODES, samples: [5, 5], deltas: [0, 10] });
    b.profile({ tid: 2, id: '0x2', nodes: NODES, samples: [7, 7], deltas: [0, 10] });
    const main = analyze(b.events, { sections: ['functions'] }).sections[0].data;
    assert.equal(main.multiThread, false);
    const all = analyze(b.events, { sections: ['functions'], thread: 'all' }).sections[0].data;
    assert.equal(all.multiThread, true);
    assert.deepEqual([...new Set(all.rows.map((r) => r.thread))].sort(), ['CrRendererMain', 'DedicatedWorker thread']);
  });

  it('scripts section groups by URL without query string', () => {
    const nodes = [
      { id: 1, functionName: '(root)' },
      { id: 2, parent: 1, functionName: 'a', url: 'https://x.test/b.js?v=1', lineNumber: 1 },
      { id: 3, parent: 1, functionName: 'b', url: 'https://x.test/b.js?v=2', lineNumber: 2 },
      { id: 4, parent: 1, functionName: 'n', url: '' },
    ];
    const b = new TraceBuilder().mainThread();
    b.x('RunTask', BASE, 1000);
    b.profile({ nodes, samples: [2, 3, 4], deltas: [0, 10, 10] });
    const rows = analyze(b.events, { sections: ['scripts'] }).sections[0].data.rows;
    assert.deepEqual(rows.map((r) => [r.script, r.functions]), [['x.test/b.js', 2], ['(native / no url)', 1]]);
  });
});
