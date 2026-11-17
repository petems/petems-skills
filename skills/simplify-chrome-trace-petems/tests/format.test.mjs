import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeCell, mdText, mdTable, fmtMs, fmtCount, shortUrl, joinBlocks, makeUtc, urlBasename } from '../scripts/lib/format.mjs';
import { makeMatcher } from '../scripts/lib/match.mjs';
import { parseWindowSpec, resolveWindow } from '../scripts/lib/window.mjs';
import { UsageError, UserError } from '../scripts/lib/errors.mjs';

describe('markdown formatting', () => {
  it('escapes pipes, flattens newlines and truncates long cells', () => {
    assert.equal(escapeCell('a|b'), 'a\\|b');
    assert.equal(escapeCell('line1\nline2\r\nline3'), 'line1 line2 line3');
    const long = escapeCell('x'.repeat(200));
    assert.equal(long.length, 120);
    assert.ok(long.endsWith('...'));
    assert.equal(mdTable(['a', 'b'], [['1|2', '3']]), '| a | b |\n| --- | --- |\n| 1\\|2 | 3 |');
    assert.equal(mdTable(['a', 'b'], [['', 'x']]), '| a | b |\n| --- | --- |\n| | x |', 'empty cell is a single space');
  });

  it('backslash-escapes link, image, HTML and code-span markup, after truncating', () => {
    assert.equal(escapeCell('![x](https://h/p) <b> `c` a\\b'), '!\\[x\\](https://h/p) \\<b\\> \\`c\\` a\\\\b');
    assert.equal(mdText('[a]|<x>'), '\\[a\\]|\\<x\\>', 'prose keeps pipes');
    assert.equal(escapeCell('CpuProfiler::StartProfiling (anonymous) a.js:15:3'), 'CpuProfiler::StartProfiling (anonymous) a.js:15:3');
    const long = escapeCell('['.repeat(200));
    assert.equal(long, '\\['.repeat(117) + '...', 'truncated to 120 source chars, then escaped');
  });

  it('formats ms with one decimal and counts with commas regardless of locale', () => {
    assert.equal(fmtMs(12.345), '12.3');
    assert.equal(fmtMs(0.04), '0.0');
    assert.equal(fmtMs(-0.01), '0.0');
    assert.equal(fmtMs(null), '-');
    assert.equal(fmtCount(1234567), '1,234,567');
    assert.equal(fmtCount(999), '999');
  });

  it('shortens URLs: drops scheme and middle-truncates to 90 chars', () => {
    assert.equal(shortUrl('https://example.com/a.js'), 'example.com/a.js');
    const s = shortUrl('https://x.test/' + 'b'.repeat(200) + 'TAIL');
    assert.equal(s.length, 90);
    assert.ok(s.startsWith('x.test/') && s.endsWith('TAIL') && s.includes('...'));
    assert.equal(urlBasename('https://a/b/c.js?x=1'), 'c.js');
  });

  it('collapses blank lines and ends with exactly one newline', () => {
    assert.equal(joinBlocks(['a\n\n\n\nb', '', null, 'c\n\n']), 'a\n\nb\n\nc\n');
  });

  it('formats wall clock offsets as UTC HH:MM:SS.mmm', () => {
    const utc = makeUtc('2025-01-02T03:04:05.000Z');
    assert.equal(utc(1234.5), '03:04:06.235');
    assert.equal(makeUtc('nope'), null);
  });
});

describe('match and window parsing', () => {
  it('matches case-insensitive substrings and /regex/flags', () => {
    assert.equal(makeMatcher(undefined), null);
    const m = makeMatcher('LaYoUt');
    assert.equal(m('UpdateLayoutTree'), true);
    assert.equal(m('Paint'), false);
    const r = makeMatcher('/^paint$/i');
    assert.equal(r('Paint'), true);
    assert.equal(r('PaintImage'), false);
    assert.throws(() => makeMatcher('/(/'), UsageError);
  });

  it('parses START-END, START-, -END and rejects bad windows', () => {
    assert.deepEqual(parseWindowSpec('100-250.5'), { kind: 'range', startMs: 100, endMs: 250.5 });
    assert.deepEqual(parseWindowSpec('100-'), { kind: 'range', startMs: 100, endMs: null });
    assert.deepEqual(parseWindowSpec('-250'), { kind: 'range', startMs: null, endMs: 250 });
    assert.deepEqual(parseWindowSpec('breadcrumb'), { kind: 'breadcrumb' });
    for (const bad of ['-', 'abc', '300-100', '1-2-3']) assert.throws(() => parseWindowSpec(bad), UsageError, bad);
    const w = resolveWindow(parseWindowSpec('1-2'), 1000, null);
    assert.deepEqual([w.start, w.end], [2000, 3000]);
    const bc = resolveWindow({ kind: 'breadcrumb' }, 0, { modifications: { initialBreadcrumb: { window: { min: 5, max: 9 } } } });
    assert.deepEqual([bc.start, bc.end], [5, 9]);
    assert.throws(() => resolveWindow({ kind: 'breadcrumb' }, 0, {}), UserError);
  });
});
