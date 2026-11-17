import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { tokenizeString, TraceTokenizer } from '../scripts/lib/tokenizer.mjs';
import { loadTraceFile, isGzipMagic } from '../scripts/lib/loader.mjs';
import { UserError } from '../scripts/lib/errors.mjs';
import { writeTemp } from './helpers/fixtures.mjs';

const tricky = [
  { ph: 'X', name: 'a{b}[c]', ts: 1, dur: 2, args: { s: 'quote \\" brace { } ] [ , : end' } },
  { ph: 'I', name: 'esc\\', ts: 3, args: { s: 'back\\\\slash \\\\" ok', u: 'é中😀' } },
  { ph: 'X', name: '"quoted"', ts: 4, dur: 0, args: { nested: { a: [1, { b: '}' }], n: -1.5e3, t: true, f: false, z: null } } },
];

function collect(text, chunk) {
  const out = [];
  const res = tokenizeString(text, (e) => out.push(e), chunk);
  return { out, res };
}

describe('streaming tokenizer', () => {
  const metadata = { source: 'DevTools', startTime: '2025-01-01T00:00:00Z', weird: 'a } { "' };
  const objText = JSON.stringify({ metadata, traceEvents: tricky }, null, 2);
  const mdAfter = `{"traceEvents":${JSON.stringify(tricky)},"other":[1,{"x":"]"}],"n":12,"metadata":${JSON.stringify(metadata)}}`;

  for (let size = 1; size <= 17; size++) {
    it(`parses every event with chunk size ${size}`, () => {
      const a = collect(objText, size);
      assert.deepEqual(a.out, tricky);
      assert.deepEqual(a.res.metadata, metadata);
      assert.equal(a.res.truncated, false);
      const b = collect(mdAfter, size);
      assert.deepEqual(b.out, tricky);
      assert.deepEqual(b.res.metadata, metadata);
    });
  }

  it('accepts metadata after events', () => {
    const { out, res } = collect(mdAfter, 1 << 20);
    assert.equal(out.length, 3);
    assert.equal(res.metadata.source, 'DevTools');
  });

  it('accepts a bare array', () => {
    const { out, res } = collect(JSON.stringify(tricky), 5);
    assert.deepEqual(out, tricky);
    assert.equal(res.metadata, null);
  });

  it('parses a truncated array and warns', () => {
    const text = '[' + tricky.map((e) => JSON.stringify(e)).join(',') + ',{"ph":"X","na';
    for (const size of [1, 3, 1000]) {
      const { out, res } = collect(text, size);
      assert.deepEqual(out, tricky);
      assert.equal(res.truncated, true);
      assert.ok(res.warnings.some((w) => /truncated/.test(w)));
    }
    const noBracket = collect('[' + tricky.map((e) => JSON.stringify(e)).join(',\n') + ',\n', 7);
    assert.equal(noBracket.out.length, 3);
    assert.equal(noBracket.res.truncated, true);
  });

  it('handles a leading BOM and whitespace', () => {
    const { out } = collect('﻿  \n' + JSON.stringify(tricky), 2);
    assert.equal(out.length, 3);
  });

  it('rejects non-JSON, empty and event-less input', () => {
    assert.throws(() => collect('hello', 4), (e) => e instanceof UserError && /not JSON/.test(e.message));
    assert.throws(() => collect('', 4), (e) => e instanceof UserError && /empty/.test(e.message));
    assert.throws(() => collect('{"foo": [1,2]}', 4), (e) => e instanceof UserError && /no traceEvents/.test(e.message));
    assert.throws(() => collect('{"traceEvents": {"a":1}}', 4), (e) => e instanceof UserError && /no traceEvents/.test(e.message));
    assert.throws(() => collect('42', 4), (e) => e instanceof UserError && /no traceEvents/.test(e.message));
    assert.throws(() => collect('[{"a":1},{"b":}]', 4), (e) => e instanceof UserError && /not valid JSON/.test(e.message));
  });

  it('rejects malformed top-level structure at any chunk size', () => {
    const bad = [
      ['[{"name":"A","ts":1}{"name":"B","ts":2}]', /expected "," or "\]"/],
      ['[{"ph":"X"},]', /trailing comma in traceEvents/],
      ['[,{"ph":"X"}]', /unexpected ","/],
      ['{"traceEvents":[],}', /trailing comma in top-level object/],
      ['{"traceEvents":[] "metadata":{}}', /expected "," or "}"/],
      ['[{"ph":"X"}]garbage', /unexpected data after the end/],
      ['{"traceEvents":[]}{}', /unexpected data after the end/],
    ];
    for (const [text, re] of bad) {
      for (const size of [1, 3, 1 << 20]) {
        assert.throws(() => tokenizeString(text, () => {}, size), (e) => e instanceof UserError && re.test(e.message), `${text} @${size}`);
      }
    }
  });

  it('allows trailing whitespace after the end', () => {
    const r = tokenizeString('{"traceEvents":[{"ph":"X"}]}\n\n  ', () => {}, 2);
    assert.equal(r.eventCount, 1);
    assert.equal(r.truncated, false);
  });

  it('handles a multi-MB value split into many small chunks in linear time', () => {
    const big = 'x'.repeat(12 * 1024 * 1024);
    const text = `{"metadata":{"sourceMaps":"${big}"},"traceEvents":[{"ph":"X","name":"a"}]}`;
    const started = Date.now();
    let events = 0;
    const r = tokenizeString(text, () => events++, 1024);
    const elapsed = Date.now() - started;
    assert.equal(events, 1);
    assert.equal(r.metadata.sourceMaps.length, big.length);
    // Re-copying the carried prefix per chunk takes ~12 s here; linear is ~0.1 s.
    assert.ok(elapsed < 2000, `took ${elapsed} ms`);
  });

  it('can be pushed incrementally by hand', () => {
    const out = [];
    const tok = new TraceTokenizer((e) => out.push(e));
    tok.push('{"traceEv');
    tok.push('ents": [{"a":"}');
    tok.push('"}');
    tok.push(']}');
    tok.end();
    assert.deepEqual(out, [{ a: '}' }]);
  });
});

describe('file loader', () => {
  const text = JSON.stringify({ traceEvents: tricky, metadata: { source: 'x' } });

  it('detects gzip by magic bytes, not extension', async () => {
    assert.equal(isGzipMagic(Buffer.from([0x1f, 0x8b, 8])), true);
    assert.equal(isGzipMagic(Buffer.from('{"')), false);
    const gzAsJson = writeTemp('looks-plain.json', text, { gzip: true });
    const plainAsGz = writeTemp('looks-gz.json.gz', text);
    for (const p of [gzAsJson, plainAsGz]) {
      const out = [];
      const res = await loadTraceFile(p, (e) => out.push(e));
      assert.deepEqual(out, tricky);
      assert.equal(res.metadata.source, 'x');
    }
    const res = await loadTraceFile(gzAsJson, () => {});
    assert.equal(res.gzip, true);
  });

  it('reports a missing file as a UserError', async () => {
    await assert.rejects(loadTraceFile('/nonexistent/trace.json', () => {}), (e) => e instanceof UserError && /not found/.test(e.message));
  });

  it('warns on a truncated gzip stream', async () => {
    const gz = gzipSync(Buffer.from(text));
    const p = writeTemp('cut.json.gz', '');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(p, gz.subarray(0, gz.length - 12));
    const out = [];
    const res = await loadTraceFile(p, (e) => out.push(e));
    assert.ok(res.warnings.length > 0);
  });

  it('handles multi-byte UTF-8 split across read chunks', async () => {
    const big = { traceEvents: [] };
    for (let i = 0; i < 40000; i++) big.traceEvents.push({ ph: 'I', name: '中é😀', ts: i });
    const p = writeTemp('utf8.json', JSON.stringify(big));
    let n = 0;
    await loadTraceFile(p, (e) => {
      assert.equal(e.name, '中é😀');
      n++;
    });
    assert.equal(n, 40000);
  });
});
