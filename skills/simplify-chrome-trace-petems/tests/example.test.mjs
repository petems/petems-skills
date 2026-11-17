// Checks the committed example trace stays useful and safe to publish.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { analyzeFile, render } from '../scripts/lib/analyze.mjs';

const tracePath = fileURLToPath(new URL('../examples/demo-trace.json.gz', import.meta.url));

describe('examples/demo-trace.json.gz', () => {
  it('only references the local demo origin', () => {
    const text = gunzipSync(readFileSync(tracePath)).toString('utf8');
    const urls = new Set(text.match(/\b(?:https?|wss?|file|chrome-extension):\/\/[^\s"'\\)]+/g) || []);
    const foreign = [...urls].filter((u) => !/^http:\/\/127\.0\.0\.1:8080(\/|$)/.test(u));
    assert.deepEqual(foreign, []);
    assert.ok(!/\/Users\/|\/home\//.test(text), 'no local filesystem paths');
  });

  it('surfaces each deliberate problem in the demo page', async () => {
    const report = await analyzeFile(tracePath, {});
    const md = render(report, { format: 'md' });
    assert.match(md, /## Long tasks/);
    assert.match(md, /resizeBoxes/, 'layout thrashing handler is the hot function');
    assert.match(md, /parseConfig/, 'start-up long task is attributed');
    assert.match(md, /Style & Layout/);
    assert.match(md, /demo:thrash/, 'performance.measure entries appear');
    assert.match(md, /pointerdown, pointerup, click/, 'clicks appear as interactions');
  });
});
