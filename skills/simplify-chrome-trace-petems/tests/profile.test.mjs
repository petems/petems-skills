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

  it('filters per sample using each sample timestamp', () => {
    const { p } = prof({ samples: [5, 5, 5, 5], deltas: [0, 1000, 1000, 1000], chunks: 1 });
    const th = [...p.threads.values()][0];
    const a = aggregateSamples(p, th, BASE + 1000, BASE + 2000);
    assert.equal(a.count, 2);
    assert.equal(a.sampled, 2000);
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
    const w = analyze(b.events, { sections: ['functions'], window: '0-1.5' });
    assert.equal(w.sections[0].data.rows[0].selfMs, 2);
    assert.equal(w.sections[0].data.rows.length, 3);
    const w2 = analyze(b.events, { sections: ['functions'], window: '1.5-2.5' });
    assert.deepEqual(w2.sections[0].data.rows.map((x) => [x.function, x.selfMs]), [['inner', 1], ['outer', 0]]);
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
