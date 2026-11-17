---
name: simplify-chrome-trace-petems
description: >-
  Summarise a large Chrome DevTools performance trace (a multi-MB
  `Trace-*.json` or `Trace-*.json.gz`, or any JSON with `traceEvents`) into a
  compact markdown report, so it can be reasoned about without loading the raw
  file. Use when given a Performance-panel recording and asked what is slow,
  what runs too often, where the long tasks or jank are, which JS functions or
  scripts are hot, why an interaction feels laggy, or what the network and
  WebSockets were doing during an action.
license: MIT
allowed-tools:
  - Bash(node:*)
  - Read
---

# Simplify trace

DevTools traces are tens to hundreds of MB of JSON. Never `Read` or `cat` the
raw trace. Run the script, read the few-KB report, then ask narrower follow-up
questions with flags.

The script is read-only, has no npm dependencies (Node 22+), streams the file
(so traces bigger than V8's ~512 MB string limit still work) and reads
`.json.gz` directly.

## Workflow

1. **Overview.** Write the default report to a temp file and read it:

   ```bash
   node skills/simplify-chrome-trace-petems/scripts/simplify-chrome-trace.mjs TRACE --out /tmp/trace-report.md
   ```

   Check the header first: which main thread was picked, the span, busy %,
   TBT, and any warnings (for example "no CPU profile").

2. **Locate the action.** A recording of one action (open a menu, switch a
   file) is mostly idle setup, which dilutes everything. Find where the work is:

   ```bash
   node …/simplify-chrome-trace.mjs TRACE --only timeline
   ```

   If the user saved the trace with a range selected in DevTools,
   `--window breadcrumb` reuses that selection.

3. **Window to it** and re-run. Every table then describes only that slice:

   ```bash
   node …/simplify-chrome-trace.mjs TRACE --window 62000-69000 --out /tmp/trace-window.md
   ```

4. **Drill in** with `--only` and `--match`:

   ```bash
   # what was on the wire, and the sockets, during the action?
   node …/simplify-chrome-trace.mjs TRACE --only network,websocket --window 62000-69000 --match api
   # which bundle is the cost in?
   node …/simplify-chrome-trace.mjs TRACE --only functions,scripts --window 62000-69000
   # a worker instead of the page
   node …/simplify-chrome-trace.mjs TRACE --thread "DedicatedWorker thread"
   ```

5. **Report back** with numbers and offsets from the report, not guesses.
   Point at `file:line` locations for hot functions.

## Options

| flag | meaning |
| --- | --- |
| `--top N` | rows per table (default 25) |
| `--long-task-ms MS` | long-task threshold (default 50) |
| `--window A-B` | scope to offsets A..B ms from trace start. `A-` and `-B` work, `breadcrumb` uses the saved DevTools selection |
| `--bucket MS` | timeline bucket size (default 1000) |
| `--thread T` | thread to analyse: a name, `pid:tid`, or `all` (default: the page's main thread, auto-detected) |
| `--only a,b` / `--except a,b` / `--all` | choose sections |
| `--match TEXT` | case-insensitive row filter (names, functions, URLs). `/regex/i` also works |
| `--wall-clock` | add UTC columns, to line offsets up with server logs |
| `--format json` | machine-readable output instead of markdown |
| `--out FILE` | write to a file instead of stdout |
| `--list` | list sections |

## Sections

Default: `summary`, `vitals`, `longtasks`, `interactions`, `marks`, `events`,
`frequent`, `functions`, `categories`.
Opt-in: `timeline`, `scripts`, `network`, `websocket`.

- **summary**: span, main thread, per-thread sampled busy/idle, task count,
  busy %, TBT, warnings.
- **timeline**: main-thread busy time per bucket over the whole trace (each
  bucket is capped at 100%). Use it to choose a window.
- **vitals**: FCP, LCP, CLS, DOMContentLoaded, load, when the recording
  includes a page load.
- **longtasks**: main-thread tasks over the threshold, each with the event
  types and JS functions that dominate it. Profiler start-up overhead is
  removed so it doesn't pose as the worst task.
- **interactions**: slow clicks, keypresses and taps, split into input delay,
  processing and presentation delay, plus an INP estimate.
- **marks**: `performance.mark` / `measure` and `console.timeStamp` entries.
- **events** / **frequent**: event types by self time, and by count with a
  rate per second.
- **functions** / **scripts**: sampled JS self time by function (`file:line`)
  and by script URL.
- **categories**: main-thread time split into scripting, style and layout,
  rendering, parsing, GC and other.
- **network** / **websocket**: request waterfall with TTFB, size, status, and
  WebSocket connection lifecycles.

## How to read it

- **Self vs total.** High self time is where the cost actually is. High total
  with low self means the cost is in callees, so look further down.
- **Count vs average.** Huge count with a tiny average is death by a thousand
  cuts (a reactive or render loop firing too often). Ask why it fires, not how
  to make each call faster.
- **Long tasks** say *when* the main thread was blocked. The `inside` and
  `top JS` columns say *what* it was doing.
- **Interactions.** Big input delay means something else was already hogging
  the main thread. Big processing means the event handlers are slow. Big
  presentation delay means rendering work after the handlers (style, layout,
  paint).
- **Style and layout** high in `categories` with many short `Layout` or
  `UpdateLayoutTree` events usually means layout thrashing (reading layout
  after writing styles in a loop).
- **No long tasks** in a window means no single blocking task. Look at
  aggregate self time, GC, and per-second rates instead.
- **Minified names** (`r`, `Tg`) come with `file:line:col`. Use them to find
  the source, or ask for source maps.
- **Idle, quiet gaps.** The trace shows *when* but not *why*. Suggest adding
  `performance.mark()` or `console.timeStamp()` in the code path; they show up
  in the `marks` section on the next recording.
- **Huge traces** that still run out of memory: prefix the command with
  `node --max-old-space-size=8192`.

## References

- `references/spec.md`: the behavioural specification (what each number
  means and how it is computed).
- `examples/demo-trace.json.gz` and `examples/demo-report.md`: a real
  recording of `examples/demo/index.html`, a small page with deliberate
  problems (a start-up long task, layout thrashing on click, a timer and
  animation loop that fire every frame, a slow request). Use it to see
  what each section looks like, or to sanity-check the script.
  `examples/demo-recording.mp4` / `.gif` is a screen recording of the
  same session, and `examples/README.md` maps what you see in it to what
  the report says.
- `examples/record-demo-trace.mjs`: re-records the trace and video in a
  throwaway headless Chrome profile, keeps only the demo page's renderer
  process, and refuses to write the file if it finds non-demo URLs,
  extension URLs, or local paths.
- Tests: `cd skills/simplify-chrome-trace-petems && npm test`.
