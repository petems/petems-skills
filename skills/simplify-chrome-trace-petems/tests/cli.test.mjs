import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync, writeFileSync, linkSync, unlinkSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs } from '../scripts/lib/args.mjs';
import { analyze, render } from '../scripts/lib/analyze.mjs';
import { UsageError, UserError } from '../scripts/lib/errors.mjs';
import { writeOutputSafely } from '../scripts/lib/cli.mjs';
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
});

describe('CLI (child process)', () => {
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

// The early check runs before analysis; these call the write-time check
// directly, after swapping the output path, to stand in for a race.
describe('writeOutputSafely', () => {
  const setup = () => {
    const input = writeTemp('in.json', 'TRACE');
    const st = statSync(input);
    return { input, id: { dev: st.dev, ino: st.ino }, out: input.replace(/in\.json$/, 'out.md') };
  };
  const refused = (re) => (e) => e instanceof UserError && re.test(e.message);

  it('refuses when the output was swapped for a symlink to the input', () => {
    const { input, id, out } = setup();
    writeFileSync(out, 'old report'); // passed the early check as a regular file
    unlinkSync(out);
    symlinkSync(input, out);
    assert.throws(() => writeOutputSafely(out, id, 'REPORT'), refused(/through a symlink/));
    assert.equal(readFileSync(input, 'utf8'), 'TRACE', 'input intact');
  });

  it('refuses when the output was swapped for a hard link to the input', () => {
    const { input, id, out } = setup();
    linkSync(input, out);
    assert.throws(() => writeOutputSafely(out, id, 'REPORT'), refused(/over the input trace/));
    assert.equal(readFileSync(input, 'utf8'), 'TRACE', 'input intact');
  });

  it('refuses a symlink to another file, leaving it intact', () => {
    const { id, out } = setup();
    const other = out.replace(/out\.md$/, 'other.txt');
    writeFileSync(other, 'keep me');
    symlinkSync(other, out);
    assert.throws(() => writeOutputSafely(out, id, 'REPORT'), refused(/through a symlink/));
    assert.equal(readFileSync(other, 'utf8'), 'keep me');
  });

  it('writes a new file and fully replaces an existing one', () => {
    const { id, out } = setup();
    writeOutputSafely(out, id, 'first, longer report');
    assert.equal(readFileSync(out, 'utf8'), 'first, longer report');
    writeOutputSafely(out, id, 'short');
    assert.equal(readFileSync(out, 'utf8'), 'short');
  });
});
