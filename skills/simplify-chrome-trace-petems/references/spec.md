# simplify-chrome-trace-petems: behavioural specification

This is the specification for the trace summariser. It describes *what* the
tool does and *why*: what each number in the report means and how it is
computed. The implementation lives in `scripts/` and the tests in `tests/`.

## Goal

Chrome DevTools Performance-panel traces are tens to hundreds of MB of JSON.
An agent cannot read them directly. The tool turns one trace into a compact
(a few KB) report that surfaces work that takes too long or happens too often,
so the agent can reason about it and then drill in with narrow follow-up runs.

The tool is read-only. It never modifies the trace.

## Runtime constraints

* Node.js 22 or newer, ES modules (`.mjs`), **zero npm dependencies** (only
  `node:` built-ins). The skill must work straight after `npx skills add`.
* Entry point: `scripts/simplify-chrome-trace.mjs`. Library code lives in
  `scripts/lib/`. Tests live in `tests/` and run with `node --test`.
* Must handle a 300 MB uncompressed trace in well under 30 s on a laptop and
  must not depend on the whole file fitting in one JS string (V8 caps strings
  at roughly 512 MB, so `readFileSync` + `JSON.parse` fails outright on big
  traces no matter how much heap you give it).

## Input

* Path to a trace file. Gzip is detected by magic bytes (`1f 8b`), not by
  extension. DevTools saves `.json.gz` by default since Chrome 142.
* Accepted shapes:
  * JSON object with a `traceEvents` array and optional `metadata` object.
    The keys may appear in any order (metadata before or after events).
  * A bare JSON array of events.
  * A truncated array (the Trace Event Format allows a missing closing `]`).
    Parse what is there and emit a warning.
* Parsing is streaming: read the file in chunks, split out each top-level
  element of `traceEvents` and `JSON.parse` it on its own. The tokenizer must
  respect strings and escapes (braces inside string values, `\"`, `\\`), and
  be correct no matter where chunk boundaries fall.
* Events are handed to collectors as they stream in. Collectors keep compact
  records only (not whole raw events with big `args` blobs) where practical.
* Clear, single-line errors (exit code 1) for: file not found, not JSON, no
  `traceEvents` array and not an array. Never dump a stack trace for user
  errors.

## Trace event basics the tool relies on

* `ts` and `dur` are microseconds. Report everything in milliseconds with one
  decimal place.
* Phases: `X` complete (has `dur`), `B`/`E` begin/end on the same thread
  (pair them with a per-thread stack; an `E` closes the most recent open
  `B`), `I`/`i` instant, `M` metadata, `P` sample/profile, `b`/`e`/`n` async
  (paired by `cat` + `name` + `id` or `id2.local`/`id2.global`, scoped by
  pid), `s`/`t`/`f` flow, `C` counter, `R` mark.
* Unclosed `B` events at end of trace are dropped with a warning count.
* Thread and process names come from `M` events `thread_name` and
  `process_name` (`args.name`).
* **Trace origin (offset 0)**: smallest `ts` among non-metadata events with
  `ts > 0`. All "offset" values in the report are ms from this origin.
* `metadata.startTime` (ISO string), when present, is the wall-clock time of
  offset 0. With `--wall-clock`, time-localised tables get a `UTC` column
  (`HH:MM:SS.mmm`). This lets the user line offsets up with server logs.

## Main thread detection

Most of the report is about the page's main thread, not every thread.
Resolution order (follows Lighthouse's tracehouse approach):

1. `TracingStartedInBrowser` event: `args.data.frames[]`, pick frames with
   `isOutermostMainFrame` (or `isInPrimaryMainFrame`, or no `parent`), collect
   their `processId`. Also honour later `FrameCommittedInBrowser` /
   `ProcessReadyInBrowser` events for that frame id that carry a `processId`
   (cross-process navigations).
2. In each of those pids, the thread named `CrRendererMain`.
3. Fallback: every `CrRendererMain` thread in the trace.
4. Fallback: `CrBrowserMain` (single-process Chrome).
5. Fallback: the thread with the most `X`/`B`-`E` duration.

`--thread` overrides: a thread name (`DedicatedWorker thread`), a `pid:tid`,
or `all` (aggregate every thread). The header states which thread(s) were
used and how they were chosen.

## Duration model and self time

* Build per-thread lists of duration events (`X` plus paired `B`/`E`).
* Sort by start ascending, ties by duration descending, stable.
* Reconstruct nesting with a stack. A child that overruns its parent's end is
  clipped to the parent end for the purposes of the parent's self time.
* `self = dur - sum(direct children's clipped durations)`, clamped at 0.
* Top-level events (depth 0) on the main thread are "tasks".
* Async events (`b`/`e`) never take part in nesting.

## Windowing

`--window START-END` scopes the whole report to a slice, offsets in ms.
Open-ended forms `START-` and `-END` are allowed. `--window breadcrumb` uses
`metadata.modifications.initialBreadcrumb.window.{min,max}` (absolute µs, the
range the user had selected in DevTools when saving). Errors if absent.

Semantics:

* Duration events are included when they **overlap** the window. For
  aggregate tables (self/total/category/timeline) their time is **clipped** to
  the window, so totals are never larger than the window.
* Long tasks overlapping the window are listed with their full duration and
  marked `(clipped)` when they extend beyond it.
* Instant and async events are included by their start `ts`.
* CPU profile samples are filtered **per sample** using each sample's own
  timestamp (not per chunk).
* Timeline section always covers the whole trace (its job is to locate where
  activity is, so you can choose a window), but marks the window if set.

## CPU profile reconstruction

* A `Profile` event (`ph: P`, `id`, `args.data.startTime`) heads a profile.
  `ProfileChunk` events with the same `pid` + `id` carry
  `args.data.cpuProfile.{nodes, samples}` and `args.data.timeDeltas`
  (some traces put `timeDeltas` inside `cpuProfile`; accept both). Nodes are
  declared incrementally across chunks and may reference parents declared in
  earlier chunks. Nodes give either `parent` or `children`; accept both.
* The profile belongs to the thread (`pid:tid`) of its `Profile` event.
* Sample timestamps: `t[0] = startTime + timeDeltas[0]`, `t[i] = t[i-1] +
  timeDeltas[i]` (continuous across chunks). Per DevTools'
  CPUProfileDataModel, sample *i* covers the interval to sample *i+1*, so its
  duration is `t[i+1] - t[i]`. The last sample's duration is the median
  sampling interval of that profile. Negative intervals (out-of-order
  samples) are clamped to 0.
* `callFrame.lineNumber` and `columnNumber` are **0-based**. Report
  `url:line:col` with both +1. Frames with no url show `codeType` or
  `(native)`.
* Synthetic frames `(root)`, `(program)`, `(idle)`, `(garbage collector)` are
  excluded from the function table. `(idle)` is reported as idle time;
  `(program)` and `(garbage collector)` are reported as separate header lines.
* Self time per frame (same functionName + url + line + col = same frame).
  Inclusive (total) time per frame: walk ancestors, counting each distinct
  frame once per sample so recursion does not double count.
* Profiles are per thread. The functions table defaults to main-thread
  profiles (respecting `--thread`), with a `thread` column when more than one
  thread contributes. Percentages are of that scope's non-idle sampled time.
* Header reports, per profiled thread: sampled span, busy (non-idle) time,
  idle time. Never sum idle time across threads into one misleading number.

## Report sections

Section keys, in canonical output order. Default set is marked (d).

| key | content |
| --- | --- |
| `summary` (d) | header (always emitted first if selected) |
| `timeline` | main-thread busy time per bucket over the whole trace |
| `vitals` (d) | navigation, FCP, LCP, CLS, DOMContentLoaded, load, if present |
| `longtasks` (d) | top-level main-thread tasks over the threshold |
| `interactions` (d) | slow user interactions (EventTiming), INP estimate |
| `marks` (d) | `performance.mark/measure` and `console.timeStamp` |
| `events` (d) | hottest event types by self time |
| `frequent` (d) | most frequent event types by count |
| `functions` (d) | hottest JS functions from the CPU profile |
| `scripts` | sampled self time grouped by script URL |
| `categories` (d) | main-thread self time by work group |
| `network` | request waterfall |
| `websocket` | WebSocket connections and lifecycle |

A section with no data prints its heading and a one-line italic note (for
example `_No CPU profile in this trace. Record with "JavaScript samples"
enabled._`), never an empty table. Sections whose only possible content
would be empty because the trace type doesn't support them still print the
note, so the agent knows it was checked.

### summary

* `# Trace summary: <file basename>`
* file size, event count, `metadata.source` and `startTime` if present
* wall-clock span; window (if any) and event count in window
* main thread(s) and how chosen
* per profiled thread: busy / idle / program / GC sampled ms
* main-thread task stats in scope: number of tasks, total busy ms, busy % of
  scope, count of tasks > 50 ms, **Total Blocking Time** (sum of
  `dur - 50ms` over tasks longer than 50 ms, after artifact removal; label it
  "TBT (all tasks in scope)" since we don't bound it by FCP/TTI like
  Lighthouse does)
* warnings list (truncated file, unpaired B events, no profile, etc.)

### timeline

* Buckets of `--bucket MS` (default 1000) across the whole trace.
* Busy time per bucket = main-thread top-level task time **split across the
  buckets it spans**, so no bucket can exceed the bucket size.
* Columns: `start (ms)`, `busy (ms)`, `busy %`, a bar of `#` characters
  (20 chars = 100%).
* Consecutive quiet buckets (busy < 5% of bucket) are collapsed into one row
  like `12000-17000 | quiet`.
* If a window is set, rows overlapping it get the ASCII marker `<- window`.

### vitals

From the main frame's renderer: `navigationStart`, `firstContentfulPaint`,
`largestContentfulPaint::Candidate` (last candidate wins, show `size` and
node/type if present), `LayoutShift` (`args.data.score`, exclude
`had_recent_input`; report total CLS and the largest session window using
the standard 1 s gap / 5 s cap rule), `MarkDOMContent`, `MarkLoad`.
Times shown as trace offset and, when `navigationStart` exists, relative to
it. If none exist (typical for a non-navigation recording), print the note.

### longtasks

* Main-thread top-level tasks with `dur >= --long-task-ms` (default 50).
* Profiler artifacts: events named `CpuProfiler::StartProfiling` or
  `CpuProfiler::StopProfiling` at any depth are recording overhead. Subtract
  their time from the enclosing top-level task; if the remaining time drops
  below the threshold the task is not a long task. A task that *is* the
  artifact is never a long task. Note the excluded count under the table.
* Sorted by duration descending, top N.
* Columns: `#`, `dur (ms)`, `offset (ms)`, optional `UTC`, `name`,
  `inside` = the top 3 descendant event names by self time within that task
  with their ms (e.g. `UpdateLayoutTree 412.0, FunctionCall 88.1`), and
  `top JS` = the top 2 functions by sampled self time during the task's
  interval on that thread (name + `file:line`, shortened URL). This answers
  "what is this long task actually doing" without another run.

### interactions

* `EventTiming` async begin events (`ph: b`) with `args.data` carrying
  `interactionId > 0`. Group by `interactionId` (scoped by pid); the
  interaction's duration is the max `duration` of its events.
* For each: offset (from the earliest `b` event ts), `type`s involved,
  duration, and three phases computed across **all** events of the
  interaction (as web-vitals attribution does), since a click is usually
  pointerdown + pointerup + click and the slow handler may sit on a
  different event from the one with the longest duration:
  * input delay = earliest `processingStart` - earliest `timeStamp`
  * processing = latest `processingEnd` - earliest `processingStart`
  * presentation delay = duration - input delay - processing

  All in ms (these fields are already ms). Clamp negatives to 0 and cap
  each phase so the three sum to the duration.
* INP estimate: the worst interaction if fewer than 50, otherwise the
  98th percentile (standard rule: ignore one highest per 50 interactions).
* Rows sorted by duration descending, top N, filtered by `--match` on type.

### marks

* User Timing: events in category `blink.user_timing`. Instant/marks: name +
  offset. Measures: `b`/`e` pairs, name + offset + duration.
* `TimeStamp` events (from `console.timeStamp`): `args.data.message`.
* Sorted by offset, top N (show `...N more` when truncated).
* Filtered by `--match`.

### events

Aggregate duration events in scope by name (thread scope: main thread by
default; `--thread all` for everything). Columns: `name`, `count`,
`self (ms)`, `total (ms)`, `avg (ms)`, `max (ms)`. Sorted by self desc.
Profiler artifact events are excluded and mentioned in a note.

### frequent

Same aggregation, sorted by count desc. Columns: `name`, `count`,
`total (ms)`, `self (ms)`, `avg (ms)`, `per sec` (count / scope seconds).

### functions

Columns: `function`, `self (ms)`, `self %`, `total (ms)`, `location`
(`thread` when needed). Anonymous functions shown as `(anonymous)`.
Filtered by `--match` against function name or URL.

### scripts

Sampled self time grouped by script URL (query string stripped), plus
`(native / no url)`. Columns: `script`, `self (ms)`, `self %`,
`functions` (distinct frames). Useful to see which bundle or third-party
script dominates.

### categories

Main-thread self time grouped into work groups (follow Lighthouse's task
groups, mapping by event name):

* Script Evaluation: `EvaluateScript`, `v8.evaluateModule`, `FunctionCall`,
  `TimerFire`, `FireIdleCallback`, `FireAnimationFrame`, `RunMicrotasks`,
  `V8.Execute`, `EventDispatch`, `v8.callFunction`, `v8.run`
* Script Parsing & Compilation: `v8.compile`, `v8.compileModule`,
  `v8.parseOnBackground`, `v8.produceCache`, `v8.produceModuleCache`,
  `v8.deserializeOnBackground`, `CacheScript`, `CompileScript`
* Style & Layout: `ScheduleStyleRecalculation`, `RecalculateStyles`,
  `UpdateLayoutTree`, `InvalidateLayout`, `Layout`, `LayoutShift` excluded
* Rendering (paint, composite): `Animation`, `HitTest`, `PaintSetup`,
  `Paint`, `PaintImage`, `RasterTask`, `ScrollLayer`, `UpdateLayer`,
  `UpdateLayerTree`, `PrePaint`, `Layerize`, `CompositeLayers`, `Commit`,
  `IntersectionObserverController::computeIntersections`
* Parse HTML & CSS: `ParseHTML`, `ParseAuthorStyleSheet`
* Garbage Collection: names starting `V8.GC`, `MinorGC`, `MajorGC`,
  `BlinkGC.`, `GCEvent`, `ThreadState::`, `CppGC`
* Other: everything else (includes `RunTask` own self time)

Columns: `group`, `self (ms)`, `%`. Then a second small table: top 10 raw
first-category tokens (`cat` split on `,`) by self time, for completeness.

### network

Requests reconstructed from `ResourceSendRequest`, `ResourceReceiveResponse`,
`ResourceReceivedData`, `ResourceFinish` keyed by `args.data.requestId`.
Captured: url, method, priority, offset, TTFB (response - send), duration
(finish - send), encoded size (from finish `encodedDataLength`, else summed
`ResourceReceivedData`), status, mimeType, `fromCache`/`fromServiceWorker`,
`didFail`. Requests included when send ts is in window and url matches.
Sorted by offset. Columns: `offset (ms)`, optional UTC, `ttfb (ms)`,
`dur (ms)`, `size (KB)`, `status`, `method`, `url`. URLs drop the scheme and
are middle-truncated to 90 chars (`start...end`). A one-line rollup above the
table: count, total KB, failed count, slowest request duration. Unfinished
requests show `-` for missing values.

### websocket

Events whose name starts with `WebSocket` (`WebSocketCreate`,
`WebSocketSendHandshakeRequest`, `WebSocketReceiveHandshakeResponse`,
`WebSocketDestroy`, plus any frame events), grouped by
`args.data.identifier`. One table of connections: url, created offset,
handshake ms, destroyed offset (or `open`), event count. Then the raw event
timeline (offset, event, url), top N.

## CLI

```text
node scripts/simplify-chrome-trace.mjs <trace.json[.gz]> [options]

  --top N               rows per table (default 25)
  --long-task-ms MS     long-task threshold (default 50)
  --window A-B          scope to offsets A..B ms; A- and -B allowed;
                        'breadcrumb' uses the DevTools saved selection
  --bucket MS           timeline bucket size (default 1000)
  --thread T            main thread override: name, pid:tid, or 'all'
  --only a,b            emit only these sections
  --except a,b          drop these sections from the selection
  --all                 every section
  --match TEXT          case-insensitive substring filter on row labels;
                        /regex/flags form also accepted
  --wall-clock          add UTC columns (needs metadata.startTime)
  --format md|json      output format (default md)
  --out FILE            write to FILE, print a one-line note to stderr
  --list                print section keys and descriptions, exit 0
  -h, --help            usage, exit 0
```

* Both `--flag value` and `--flag=value` forms.
* Unknown flags, missing values, non-numeric or non-positive numbers,
  unknown section keys, bad window syntax (`B < A`) are user errors: one
  line on stderr plus `Run with --help`, exit code 2.
* `--out` stderr note: `Wrote <file> (<bytes> bytes) from <size> MB trace in
  <secs>s`.

## Output formatting

* Markdown tables in compact style (`| a | b |`, separator `| --- | --- |`,
  empty cells as a single space) so they pass markdownlint. Cell contents escaped:
  `|` becomes `\|`, newlines become spaces, and very long cells are
  truncated at 120 chars with `...`.
* Numbers: ms with one decimal (`12.3`), counts with `,` thousands separators
  regardless of the system locale.
* No more than one blank line in a row. Output ends with a single newline.
* `--format json`: one JSON document `{ file, meta, warnings, sections: { key:
  data } }` where each section's data is plain rows (numbers in ms, not
  strings). Same section selection and filters apply.
* Deterministic: same input and flags give byte-identical output (stable
  sorts with name as a tie-breaker).

## Testing requirements

* `node --test` with only built-ins. A fixture builder in
  `tests/helpers/` produces small synthetic traces in memory (helpers for
  thread names, X, B/E, instant, async, profile + chunks, network,
  EventTiming, user timing).
* Cover at least: streaming tokenizer under every chunk size from 1 to 17
  bytes including strings with braces and escaped quotes; metadata after
  events; bare array; truncated array; gzip detection; self-time nesting
  including overrun children and ties; B/E pairing and unclosed B; main
  thread detection order; window overlap clipping; per-sample window
  filtering; sample duration semantics and median last sample; 0-based to
  1-based line numbers; recursion not double counting totals; long task
  artifact subtraction; TBT; timeline split across buckets never exceeding
  100%; quiet bucket collapsing; interactions phases and INP rule; marks;
  network rollup and URL truncation; websocket grouping; markdown escaping;
  JSON output shape; CLI arg errors and exit codes; `--list` and `--help`;
  empty-section notes; determinism (two runs identical).
* One end-to-end CLI test that writes a fixture (plain and gzipped) to a temp
  dir and runs the script as a child process.
