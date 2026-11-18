import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readFileSync, symlinkSync, writeFileSync, linkSync, unlinkSync, statSync, mkdirSync, mkdtempSync, renameSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from '../scripts/lib/args.mjs';
import { analyze, render } from '../scripts/lib/analyze.mjs';
import { UsageError, UserError } from '../scripts/lib/errors.mjs';
import { writeOutputSafely, resolveOutput } from '../scripts/lib/cli.mjs';
import { SECTION_KEYS, DEFAULT_SECTION_KEYS } from '../scripts/lib/sections/index.mjs';
import { richTrace, writeTemp } from './helpers/fixtures.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'simplify-chrome-trace.mjs');
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

describe('argument parsing', () => {
  it('treats a known flag after a value flag as a missing value', () => {
    assert.throws(() => parseArgs(['t.json', '--out', '--all']), (e) => e instanceof UsageError && /--out needs a value/.test(e.message));
    assert.throws(() => parseArgs(['t.json', '--match', '--top=5']), UsageError);
    assert.equal(parseArgs(['t.json', '--out=--all']).out, '--all', 'explicit = form is a literal');
    assert.deepEqual(parseArgs(['t.json', '--window', '-100']).options.window, { kind: 'range', startMs: null, endMs: 100 });
  });

  it('accepts --flag value and --flag=value', () => {
    const a = parseArgs(['t.json', '--top', '5', '--long-task-ms=80', '--window=10-20', '--bucket', '250', '--thread', 'all', '--match=x', '--wall-clock', '--format', 'json', '--out', 'o.md']);
    assert.equal(a.file, 't.json');
    assert.equal(a.out, 'o.md');
    assert.deepEqual(
      { top: a.options.top, lt: a.options.longTaskMs, b: a.options.bucketMs, th: a.options.thread, m: a.options.match, wc: a.options.wallClock, f: a.options.format },
      { top: 5, lt: 80, b: 250, th: 'all', m: 'x', wc: true, f: 'json' },
    );
    assert.deepEqual(a.options.window, { kind: 'range', startMs: 10, endMs: 20 });
  });

  it('selects sections with --only, --except and --all', () => {
    assert.deepEqual(parseArgs(['t']).options.sections, DEFAULT_SECTION_KEYS);
    assert.deepEqual(parseArgs(['t', '--all']).options.sections, SECTION_KEYS);
    assert.deepEqual(parseArgs(['t', '--only', 'network,summary']).options.sections, ['network', 'summary']);
    assert.ok(!parseArgs(['t', '--all', '--except', 'timeline']).options.sections.includes('timeline'));
  });

  it('rejects bad arguments with UsageError', () => {
    const bad = [
      ['t', '--nope'],
      ['t', '--top'],
      ['t', '--top', 'abc'],
      ['t', '--top', '0'],
      ['t', '--top', '-3'],
      ['t', '--top', '2.5'],
      ['t', '--bucket', '0'],
      ['t', '--long-task-ms', 'x'],
      ['t', '--only', 'bogus'],
      ['t', '--except', 'summary,nope'],
      ['t', '--window', '200-100'],
      ['t', '--window', 'x'],
      ['t', '--format', 'xml'],
      ['t', '--all=1'],
      [],
      ['a', 'b'],
    ];
    for (const argv of bad) assert.throws(() => parseArgs(argv), UsageError, argv.join(' '));
  });
  it('parses --max-input-mb as a positive number', () => {
    assert.equal(parseArgs(['t.json', '--max-input-mb', '8192']).options.maxInputMb, 8192);
    assert.equal(parseArgs(['t.json', '--max-input-mb=0.5']).options.maxInputMb, 0.5);
    assert.equal(parseArgs(['t.json']).options.maxInputMb, undefined, 'no flag, default limit');
    for (const bad of ['0', '-5', 'abc', '1e-9', 'Infinity']) {
      assert.throws(() => parseArgs(['t.json', `--max-input-mb=${bad}`]), UsageError, bad);
    }
    assert.throws(() => parseArgs(['t.json', '--max-input-mb']), (e) => e instanceof UsageError && /--max-input-mb needs a value/.test(e.message));
  });
});

describe('CLI (child process)', () => {
  it('stops a gzip bomb with a one-line error naming --max-input-mb (exit 1)', () => {
    const member = gzipSync(Buffer.alloc(1024 * 1024, 0x20));
    const parts = [gzipSync(Buffer.from('{"traceEvents":['))];
    for (let i = 0; i < 64; i++) parts.push(member);
    parts.push(gzipSync(Buffer.from(']}')));
    const file = writeTemp('bomb.json', '');
    writeFileSync(file, Buffer.concat(parts));
    const r = run(file, '--max-input-mb', '2');
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'simplify-chrome-trace: error: decompressed trace is larger than the 2 MB input limit; if the file is genuine, raise it with --max-input-mb\n');
    assert.equal(run(file, '--max-input-mb', '128', '--only', 'summary').status, 0, 'a raised limit lets the same (valid, empty) trace through');
  });

  it('runs normally with --max-input-mb above the trace size, and rejects bad values with exit 2', () => {
    const file = writeTemp('in.json', richTrace().toJSON());
    const r = run(file, '--max-input-mb', '64');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, run(file).stdout);
    const bad = run(file, '--max-input-mb', '0');
    assert.equal(bad.status, 2);
    assert.equal(bad.stderr, 'simplify-chrome-trace: --max-input-mb must be positive, got 0. Run with --help\n');
  });

  it('refuses to write the report over the input trace, including via a symlink', () => {
    const file = writeTemp('in.json', richTrace().toJSON());
    const before = readFileSync(file, 'utf8');
    const r = run(file, '--out', file);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing to write the report over the input trace/);
    const link = file.replace(/in\.json$/, 'link.json');
    symlinkSync(file, link);
    const viaLink = run(file, '--out', link);
    assert.equal(viaLink.status, 1);
    assert.match(viaLink.stderr, /refusing to write the report over the input trace/);
    assert.equal(readFileSync(file, 'utf8'), before, 'input untouched');
  });

  it('refuses a symlinked --out even when it points at another file', () => {
    const file = writeTemp('in.json', richTrace().toJSON());
    const other = file.replace(/in\.json$/, 'other.txt');
    writeFileSync(other, 'keep me');
    const link = file.replace(/in\.json$/, 'report.md');
    symlinkSync(other, link);
    const r = run(file, '--out', link);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^simplify-chrome-trace: error: refusing to write the report through a symlink \(.*report\.md\); remove it or choose another path\n$/);
    assert.equal(readFileSync(other, 'utf8'), 'keep me', 'link target untouched');
  });

  it('--out creates a new file, and fully replaces an existing regular file', () => {
    const file = writeTemp('in.json', richTrace().toJSON());
    const out = file.replace(/in\.json$/, 'new.md');
    assert.equal(run(file, '--out', out).status, 0);
    const expected = run(file).stdout;
    assert.equal(readFileSync(out, 'utf8'), expected);
    writeFileSync(out, 'x'.repeat(expected.length * 3));
    assert.equal(run(file, '--out', out).status, 0);
    assert.equal(readFileSync(out, 'utf8'), expected, 'old, longer content fully replaced');
    assert.deepEqual(readdirSync(dirname(file)).sort(), ['in.json', 'new.md'], 'no temp file left');
  });

  it('--help and --list exit 0', () => {
    const h = run('--help');
    assert.equal(h.status, 0);
    assert.match(h.stdout, /Usage: node scripts\/simplify-chrome-trace\.mjs/);
    assert.equal(run('-h').status, 0);
    const l = run('--list');
    assert.equal(l.status, 0);
    for (const k of SECTION_KEYS) assert.match(l.stdout, new RegExp(`\\b${k}\\b`));
  });

  it('usage errors exit 2 with one line and a --help hint', () => {
    for (const args of [['x.json', '--bogus'], ['x.json', '--top', 'zero'], ['x.json', '--only', 'nope'], ['x.json', '--window', '9-1'], ['x.json', '--bucket', '1e-12'], ['x.json', '--bucket=0.5'], []]) {
      const r = run(...args);
      assert.equal(r.status, 2, args.join(' '));
      const lines = r.stderr.trim().split('\n');
      assert.equal(lines.length, 1);
      assert.match(lines[0], /Run with --help/);
      assert.equal(r.stdout, '');
    }
  });

  it('input errors exit 1 with a single line and no stack trace', () => {
    const notJson = writeTemp('bad.json', 'this is not json');
    const noEvents = writeTemp('obj.json', '{"foo": 1}');
    for (const [p, re] of [['/no/such/file.json', /file not found/], [notJson, /not JSON/], [noEvents, /no traceEvents array/]]) {
      const r = run(p);
      assert.equal(r.status, 1);
      assert.match(r.stderr, re);
      assert.equal(r.stderr.trim().split('\n').length, 1);
      assert.ok(!/\bat \S+:\d+/.test(r.stderr));
    }
    const noCrumb = writeTemp('nocrumb.json', '[{"ph":"X","name":"A","pid":1,"tid":1,"ts":5,"dur":1}]');
    assert.equal(run(noCrumb, '--window', 'breadcrumb').status, 1);
    assert.equal(run(noCrumb, '--thread', 'Nope').status, 1);
    for (const w of ['2000-3000', '2000-']) {
      const r = run(noCrumb, '--window', w);
      assert.equal(r.status, 1, w);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, new RegExp(`--window ${w} ms is outside the trace \\(0\\.0-0\\.0 ms\\)`));
      assert.equal(r.stderr.trim().split('\n').length, 1);
    }
  });

  it('end to end: plain and gzipped fixtures give identical reports', () => {
    const text = richTrace().toJSON();
    const plain = writeTemp('trace.json', text);
    const gz = writeTemp('trace.json', text, { gzip: true });
    const a = run(plain, '--all');
    const b = run(gz, '--all');
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    const strip = (s) => s.replace(/- File: .*\n/, '');
    assert.equal(strip(a.stdout), strip(b.stdout));
    assert.match(a.stdout, /^> Untrusted data: [^\n]+\n\n# Trace summary: trace\.json\n/);
    assert.ok(a.stdout.endsWith('\n') && !a.stdout.endsWith('\n\n'));
    assert.ok(!/\n\n\n/.test(a.stdout));
    for (const h of ['## Long tasks', '## Interactions', '## Hottest JS functions', '## Network', '## WebSocket', '## Timeline']) assert.ok(a.stdout.includes(h), h);
  });

  it('--out writes the file and prints a one-line note', () => {
    const p = writeTemp('trace.json', richTrace().toJSON());
    const out = p + '.md';
    const r = run(p, '--out', out, '--format', 'json');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^Wrote .*trace\.json\.md \(\d+ bytes\) from [\d.]+ MB trace in [\d.]+s\n$/);
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(doc.file, 'trace.json');
  });

  it('is deterministic: two runs are byte-identical', () => {
    const p = writeTemp('trace.json', richTrace().toJSON('metadata-last'));
    const a = run(p, '--all', '--wall-clock');
    const b = run(p, '--all', '--wall-clock');
    assert.equal(a.status, 0);
    assert.equal(a.stdout, b.stdout);
    assert.match(a.stdout, /\| UTC \|/);
  });

  it('parses truncated traces and reports a warning', () => {
    const p = writeTemp('cut.json', richTrace().toJSON('truncated'));
    const r = run(p);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Warnings:\n {2}- trace is truncated/);
  });
});

describe('JSON output', () => {
  it('has the { file, meta, warnings, sections } shape with numeric ms', () => {
    const b = richTrace();
    const report = analyze(b.events, { sections: SECTION_KEYS, metadata: b.metadata, fileName: 'x.json' });
    const doc = JSON.parse(render(report, { format: 'json' }));
    assert.deepEqual(Object.keys(doc), ['notice', 'file', 'meta', 'warnings', 'sections']);
    assert.match(doc.notice, /^Untrusted data:/);
    assert.equal(doc.file, 'x.json');
    assert.deepEqual(Object.keys(doc.sections), SECTION_KEYS);
    assert.ok(Array.isArray(doc.warnings));
    assert.equal(typeof doc.meta.spanMs, 'number');
    assert.equal(typeof doc.sections.longtasks.rows[0].durMs, 'number');
    assert.equal(doc.sections.longtasks.rows[0].durMs, 120);
    assert.equal(typeof doc.sections.network.rows[0].ttfbMs, 'number');
    assert.ok(typeof doc.sections.marks.note === 'undefined');
  });

  it('applies the same section selection and filters', () => {
    const b = richTrace();
    const doc = JSON.parse(render(analyze(b.events, { sections: ['events', 'network'], match: 'function' }), { format: 'json' }));
    assert.deepEqual(Object.keys(doc.sections), ['events', 'network']);
    assert.deepEqual(doc.sections.events.rows.map((r) => r.name), ['FunctionCall']);
    assert.equal(doc.sections.network.rows.length, 0);
  });

  it('uses the breadcrumb window from metadata', () => {
    const b = richTrace();
    const doc = JSON.parse(render(analyze(b.events, { sections: ['summary', 'longtasks'], window: 'breadcrumb', metadata: b.metadata }), { format: 'json' }));
    assert.deepEqual([doc.meta.window.startMs, doc.meta.window.endMs], [0, 250]);
    assert.equal(doc.sections.summary.window.source, 'DevTools breadcrumb');
  });
});

// resolveOutput runs before analysis; these swap paths after it and then call
// the write-time check directly, to stand in for a race during analysis.
describe('writeOutputSafely', () => {
  const setup = () => {
    const input = writeTemp('in.json', 'TRACE');
    const st = statSync(input);
    const dir = dirname(input);
    return { input, dir, id: { dev: st.dev, ino: st.ino }, out: join(dir, 'out.md') };
  };
  const refused = (re) => (e) => e instanceof UserError && re.test(e.message);
  const ls = (d) => readdirSync(d).sort();

  it('refuses when the output was swapped for a symlink to the input', () => {
    const { input, dir, id, out } = setup();
    writeFileSync(out, 'old report'); // passed the early check as a regular file
    const target = resolveOutput(out);
    unlinkSync(out);
    symlinkSync(input, out);
    assert.throws(() => writeOutputSafely(target, id, 'REPORT'), refused(/through a symlink/));
    assert.equal(readFileSync(input, 'utf8'), 'TRACE', 'input intact');
    assert.deepEqual(ls(dir), ['in.json', 'out.md'], 'no temp file left');
  });

  it('refuses when the output was swapped for a hard link to the input', () => {
    const { input, dir, id, out } = setup();
    const target = resolveOutput(out);
    linkSync(input, out);
    assert.throws(() => writeOutputSafely(target, id, 'REPORT'), refused(/over the input trace/));
    assert.equal(readFileSync(input, 'utf8'), 'TRACE', 'input intact');
    assert.deepEqual(ls(dir), ['in.json', 'out.md'], 'no temp file left');
  });

  it('refuses a symlink to another file, leaving it intact', () => {
    const { dir, id, out } = setup();
    const other = join(dir, 'other.txt');
    writeFileSync(other, 'keep me');
    const target = resolveOutput(out);
    symlinkSync(other, out);
    assert.throws(() => writeOutputSafely(target, id, 'REPORT'), refused(/through a symlink/));
    assert.equal(readFileSync(other, 'utf8'), 'keep me');
    assert.deepEqual(ls(dir), ['in.json', 'other.txt', 'out.md'], 'no temp file left');
  });

  it('refuses a directory or other non-regular file at the output path', () => {
    const { input, dir, id, out } = setup();
    const target = resolveOutput(out);
    mkdirSync(out);
    assert.throws(() => writeOutputSafely(target, id, 'REPORT'), refused(/not a regular file/));
    assert.deepEqual(ls(out), [], 'directory untouched');
    assert.deepEqual(ls(dir), ['in.json', 'out.md'], 'no temp file left');
    const fifo = join(dir, 'fifo.md');
    if (spawnSync('mkfifo', [fifo]).status === 0) {
      assert.throws(() => writeOutputSafely(resolveOutput(fifo), id, 'REPORT'), refused(/not a regular file/));
      assert.ok(statSync(fifo).isFIFO());
      assert.deepEqual(ls(dir), ['fifo.md', 'in.json', 'out.md'], 'no temp file left');
    }
    assert.equal(readFileSync(input, 'utf8'), 'TRACE', 'input intact');
  });

  it('refuses when a parent directory was swapped for a symlink to another directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'simplify-chrome-trace-test-'));
    const sub = join(base, 'sub');
    const victim = join(base, 'victim');
    mkdirSync(sub);
    mkdirSync(victim);
    const input = join(base, 'in.json');
    writeFileSync(input, 'TRACE');
    const st = statSync(input);
    const id = { dev: st.dev, ino: st.ino };
    writeFileSync(join(victim, 'out.md'), 'precious data');
    const target = resolveOutput(join(sub, 'out.md'));
    renameSync(sub, join(base, 'sub-moved'));
    symlinkSync(victim, sub);
    assert.throws(() => writeOutputSafely(target, id, 'REPORT'), refused(/directory of .* changed during analysis/));
    assert.equal(readFileSync(join(victim, 'out.md'), 'utf8'), 'precious data', 'file behind the symlink untouched');
    assert.deepEqual(ls(victim), ['out.md'], 'no temp file left in the symlink target');
    assert.deepEqual(ls(join(base, 'sub-moved')), [], 'nothing written to the original directory');
    // A different real directory at the same path is refused too.
    unlinkSync(sub);
    mkdirSync(sub);
    assert.throws(() => writeOutputSafely(target, id, 'REPORT'), refused(/changed during analysis/));
    assert.deepEqual(ls(sub), [], 'no temp file left');
    assert.equal(readFileSync(input, 'utf8'), 'TRACE', 'input intact');
  });

  it('resolves a parent that is already a symlink at startup', () => {
    const { dir, id } = setup();
    const real = join(dir, 'real');
    mkdirSync(real);
    symlinkSync(real, join(dir, 'alias'));
    const target = resolveOutput(join(dir, 'alias', 'out.md'));
    assert.equal(target.dir, realpathSync(real));
    writeOutputSafely(target, id, 'REPORT');
    assert.equal(readFileSync(join(real, 'out.md'), 'utf8'), 'REPORT');
    assert.deepEqual(ls(real), ['out.md']);
  });

  it('rejects an --out that does not name a file', () => {
    const { dir } = setup();
    for (const p of ['', '.', '..', dir + '/.', dir + '/..', dir + '/', dir]) {
      assert.throws(() => resolveOutput(p), refused(/must name a file/), JSON.stringify(p));
    }
    assert.throws(() => resolveOutput(join(dir, 'missing', 'out.md')), refused(/cannot use the directory of --out/));
  });

  it('writes a new file and fully replaces an existing one, leaving no temp files', () => {
    const { dir, id, out } = setup();
    writeOutputSafely(resolveOutput(out), id, 'first, longer report');
    assert.equal(readFileSync(out, 'utf8'), 'first, longer report');
    writeOutputSafely(resolveOutput(out), id, 'short');
    assert.equal(readFileSync(out, 'utf8'), 'short');
    assert.deepEqual(ls(dir), ['in.json', 'out.md']);
  });
});
