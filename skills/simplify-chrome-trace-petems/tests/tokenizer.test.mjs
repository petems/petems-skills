import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
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
      ['{"traceEvents":[],"unused":}', /missing value in top-level object/],
      ['{"unused":,"traceEvents":[]}', /missing value in top-level object/],
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

// Input limits: a small, highly compressible file must not be able to expand
// into gigabytes of memory. The limits are lowered here so the tests run fast.
const MB = 1024 * 1024;

/**
 * A gzip bomb: `head`, then `copies` concatenated gzip members of `fill`
 * (each `fillMb` MB once expanded), then `tail`. Multi-member gzip is valid
 * and gunzip expands every member, so a few hundred KB on disk expand to
 * gigabytes.
 */
function gzipBomb(head, fill, copies, tail) {
  const member = gzipSync(Buffer.from(fill));
  const parts = [gzipSync(Buffer.from(head))];
  for (let i = 0; i < copies; i++) parts.push(member);
  parts.push(gzipSync(Buffer.from(tail)));
  return Buffer.concat(parts);
}

function writeBuf(name, buf) {
  const p = writeTemp(name, '');
  writeFileSync(p, buf);
  return p;
}

describe('input limits', () => {
  it('stops a gzip bomb of whitespace once the decompressed size passes the limit', async () => {
    // 1 GB of whitespace between two events, from well under 2 MB of gzip.
    const bomb = gzipBomb('{"traceEvents":[{"ph":"I","ts":1}', ' '.repeat(MB), 1024, ',{"ph":"I","ts":2}]}');
    assert.ok(bomb.length < 2 * MB, `bomb is small on disk (${bomb.length} bytes)`);
    const p = writeBuf('bomb.json.gz', bomb);
    const rss = process.memoryUsage().rss;
    const t0 = Date.now();
    let events = 0;
    await assert.rejects(loadTraceFile(p, () => events++, { maxInputBytes: 8 * MB }), (e) => {
      assert.ok(e instanceof UserError);
      assert.match(e.message, /^decompressed trace is larger than the 8 MB input limit; if the file is genuine, raise it with --max-input-mb$/);
      return true;
    });
    assert.equal(events, 1, 'stopped before reaching the second event');
    assert.ok(Date.now() - t0 < 5000, 'aborted promptly, without expanding the whole bomb');
    assert.ok(process.memoryUsage().rss - rss < 200 * MB, 'memory stays small');
  });

  it('rejects a single event that grows past the value limit before buffering all of it', async () => {
    // One event holding a 1 GB string, from a small gzip file.
    const bomb = gzipBomb('{"traceEvents":[{"ph":"I","ts":1,"args":{"s":"', 'a'.repeat(MB), 1024, '"}}]}');
    const p = writeBuf('big-event.json.gz', bomb);
    const rss = process.memoryUsage().rss;
    await assert.rejects(loadTraceFile(p, () => {}, { maxValueChars: 4 * MB }), (e) => {
      assert.ok(e instanceof UserError);
      assert.match(e.message, /^trace event #1 is larger than the 4 MB limit for a single value; the trace is malformed or hostile$/);
      return true;
    });
    assert.ok(process.memoryUsage().rss - rss < 200 * MB, 'memory stays small');
  });

  it('checks the value limit while the pieces are collected, chunk by chunk', () => {
    const tok = new TraceTokenizer(() => {}, { maxValueChars: 1000 });
    tok.push('{"traceEvents":[{"s":"');
    let pushed = 0;
    assert.throws(() => {
      for (; pushed < 1000; pushed++) tok.push('x'.repeat(100));
    }, (e) => e instanceof UserError && /trace event #1 is larger than/.test(e.message));
    assert.ok(pushed <= 10, `rejected after ${pushed} chunks, not after the value ended`);
  });

  it('applies the value limit to the metadata object and to top-level keys', () => {
    const limits = { maxValueChars: 1000 };
    const meta = JSON.stringify({ metadata: { sourceMap: 'm'.repeat(5000) }, traceEvents: [] });
    for (const chunk of [64, 1 << 20]) {
      assert.throws(() => tokenizeString(meta, () => {}, chunk, limits), (e) => e instanceof UserError && /^the metadata object is larger than/.test(e.message));
    }
    const key = `{"${'k'.repeat(5000)}":1,"traceEvents":[]}`;
    assert.throws(() => tokenizeString(key, () => {}, 64, limits), (e) => e instanceof UserError && /^a top-level key is larger than/.test(e.message));
    // A large value that is not kept (an unknown key) costs no memory, so it is not limited.
    const skipped = JSON.stringify({ other: 'o'.repeat(5000), traceEvents: [{ ph: 'I', ts: 1 }] });
    assert.equal(tokenizeString(skipped, () => {}, 64, limits).eventCount, 1);
  });

  it('accepts values up to the limit, including multi-MB metadata by default', () => {
    const ev = JSON.stringify({ ph: 'I', ts: 1 });
    const exact = `[${ev}]`;
    assert.equal(tokenizeString(exact, () => {}, 3, { maxValueChars: ev.length }).eventCount, 1);
    assert.throws(() => tokenizeString(exact, () => {}, 3, { maxValueChars: ev.length - 1 }), UserError);
    const res = tokenizeString(JSON.stringify({ metadata: { sourceMap: 's'.repeat(20 * MB) }, traceEvents: [] }), () => {});
    assert.equal(res.metadata.sourceMap.length, 20 * MB);
  });

  it('caps the number of events', async () => {
    const events = Array.from({ length: 11 }, (_, i) => ({ ph: 'I', ts: i }));
    assert.equal(tokenizeString(JSON.stringify(events.slice(0, 10)), () => {}, 1 << 20, { maxEvents: 10 }).eventCount, 10);
    assert.throws(() => tokenizeString(JSON.stringify(events), () => {}, 1 << 20, { maxEvents: 10 }), (e) => e instanceof UserError && /^trace has more than 10 events, the most this tool accepts; record a shorter trace$/.test(e.message));
    // Many tiny events in a gzip bomb hit the cap without buffering them.
    const bomb = gzipBomb('[', '{"ph":"I","ts":1},'.repeat(10000), 100, '{"ph":"I","ts":1}]');
    let seen = 0;
    await assert.rejects(loadTraceFile(writeBuf('many.json.gz', bomb), () => seen++, { maxEvents: 5000 }), (e) => e instanceof UserError && /more than 5,000 events/.test(e.message));
    assert.equal(seen, 5000);
  });

  it('applies the input limit to plain files before reading them', async () => {
    const text = JSON.stringify({ traceEvents: tricky });
    const p = writeTemp('plain.json', text);
    const out = [];
    const bytes = Buffer.byteLength(text);
    await loadTraceFile(p, (e) => out.push(e), { maxInputBytes: bytes });
    assert.deepEqual(out, tricky, 'a file exactly at the limit is fine');
    let seen = 0;
    await assert.rejects(loadTraceFile(p, () => seen++, { maxInputBytes: bytes - 1 }), (e) => e instanceof UserError && /^trace is larger than the .* MB input limit; .*--max-input-mb$/.test(e.message));
    assert.equal(seen, 0);
  });

  it('leaves normal traces alone under the default limits', async () => {
    const text = JSON.stringify({ traceEvents: tricky, metadata: { source: 'x' } });
    for (const gzip of [false, true]) {
      const out = [];
      const res = await loadTraceFile(writeTemp('ok.json', text, { gzip }), (e) => out.push(e));
      assert.deepEqual(out, tricky);
      assert.equal(res.metadata.source, 'x');
      assert.deepEqual(res.warnings, []);
    }
  });
});
