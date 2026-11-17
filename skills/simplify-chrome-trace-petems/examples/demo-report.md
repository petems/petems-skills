# Trace summary: demo-trace.json.gz

- File: 750.5 KB, 51,666 events
- Recording: source record-demo-trace.mjs, started 2026-11-17T21:24:23.264Z
- Span: 4288.3 ms
- Main thread: CrRendererMain (pid 82873, tid 11855784), chosen by every CrRendererMain thread (no main frame info in trace)
- CPU profile CrRendererMain (82873:11855784): sampled 3821.3 ms, busy 1135.4 ms, idle 2686.0 ms, program 150.7 ms, GC 1.8 ms
- Main-thread tasks in scope: 1,274 tasks, busy 1125.4 ms (26.2% of 4288.3 ms), 3 over 50 ms, TBT (all tasks in scope) 813.3 ms
- Warnings:
  - 4 unclosed B event(s) at end of trace were dropped

## Vitals

| metric | offset (ms) | since nav (ms) | detail |
| --- | --- | --- | --- |
| Navigation start | 453.7 | 0.0 | 127.0.0.1:8080/ |
| First Contentful Paint | 670.0 | 216.3 | |
| Largest Contentful Paint | 670.0 | 216.3 | size 12408, type text, node 5, 1 candidate |
| DOMContentLoaded | 644.9 | 191.1 | |
| Load | 645.4 | 191.7 | |

2 navigations in scope; times are relative to the one that preceded the first paint.

## Long tasks (>= 50.0 ms)

3 long task(s) in scope.

| # | dur (ms) | offset (ms) | name | inside | top JS |
| --- | --- | --- | --- | --- | --- |
| 1 | 396.5 | 1470.1 | RunTask | Layout 351.1, FunctionCall 24.7, UpdateLayoutTree 19.8 | resizeBoxes (127.0.0.1:8080:43) 395.2 |
| 2 | 385.0 | 3101.7 | RunTask | Layout 344.2, FunctionCall 21.9, UpdateLayoutTree 18.6 | resizeBoxes (127.0.0.1:8080:43) 384.4 |
| 3 | 181.9 | 461.1 | RunTask | v8.run 179.6, MinorGC 0.3, ParseHTML 0.3 | parseConfig (127.0.0.1:8080:24) 176.5, (anonymous) (127.0.0.1:8080) 2.2 |

## Interactions

INP estimate: 399.3 ms (worst interaction, 3 interactions).

| # | offset (ms) | type | dur (ms) | input delay (ms) | processing (ms) | presentation (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1469.0 | pointerdown, pointerup, click | 399.3 | 0.3 | 396.7 | 2.4 |
| 2 | 3101.0 | pointerdown, pointerup, click | 386.7 | 0.1 | 385.2 | 1.4 |
| 3 | 2484.7 | pointerdown, pointerup, click | 32.6 | 0.3 | 5.8 | 26.6 |

## Marks and measures

11 entries in scope.

| offset (ms) | kind | name | dur (ms) |
| --- | --- | --- | --- |
| 463.1 | mark | demo:boot-start | - |
| 463.1 | measure | demo:boot | 180.1 |
| 643.2 | mark | demo:boot-end | - |
| 1470.5 | mark | demo:thrash-start | - |
| 1470.5 | measure | demo:thrash | 395.4 |
| 1470.5 | timeStamp | demo: resize clicked | - |
| 1865.8 | mark | demo:thrash-end | - |
| 3101.8 | mark | demo:thrash-start | - |
| 3101.8 | measure | demo:thrash | 384.5 |
| 3101.8 | timeStamp | demo: resize clicked | - |
| 3486.3 | mark | demo:thrash-end | - |

## Hottest events by self time (main thread)

| name | count | self (ms) | total (ms) | avg (ms) | max (ms) |
| --- | --- | --- | --- | --- | --- |
| Layout | 4,974 | 716.3 | 716.3 | 0.1 | 7.1 |
| v8.run | 1 | 179.6 | 182.6 | 182.6 | 182.6 |
| FunctionCall | 360 | 68.6 | 802.4 | 2.2 | 395.5 |
| UpdateLayoutTree | 5,112 | 45.6 | 45.6 | 0.0 | 0.5 |
| Paint | 347 | 28.9 | 28.9 | 0.2 | 0.4 |
| ThreadControllerImpl::RunTask | 1,195 | 27.4 | 1122.2 | 0.9 | 396.5 |
| Layerize | 177 | 16.8 | 16.8 | 0.1 | 0.2 |
| PrePaint | 321 | 14.0 | 14.0 | 0.0 | 0.5 |
| Commit | 177 | 5.4 | 5.9 | 0.0 | 0.1 |
| Receive mojo message | 57 | 3.7 | 5.9 | 0.1 | 2.1 |
| RunTask | 1,274 | 3.6 | 1126.7 | 0.9 | 396.5 |
| v8.callFunction | 360 | 2.4 | 804.9 | 2.2 | 395.5 |
| FireAnimationFrame | 177 | 1.8 | 12.4 | 0.1 | 0.2 |
| TimerFire | 180 | 1.7 | 10.6 | 0.1 | 0.1 |
| LatencyInfo.Flow | 22 | 1.4 | 788.6 | 35.8 | 396.5 |
| HitTest | 141 | 1.3 | 1.3 | 0.0 | 0.0 |
| BlinkScheduler_PerformMicrotaskCheckpoint | 633 | 0.8 | 0.9 | 0.0 | 0.1 |
| EvaluateScript | 4 | 0.5 | 183.5 | 45.9 | 182.8 |
| UpdateLayer | 177 | 0.5 | 0.5 | 0.0 | 0.0 |
| DocumentLoader::CommitNavigation | 2 | 0.4 | 1.4 | 0.7 | 1.1 |
| V8.BytecodeBudgetInterrupt | 245 | 0.4 | 0.4 | 0.0 | 0.0 |
| SimpleWatcher::OnHandleReady | 25 | 0.3 | 2.3 | 0.1 | 1.6 |
| ParseHTML | 4 | 0.3 | 183.2 | 45.8 | 183.1 |
| MinorGC | 13 | 0.3 | 1.5 | 0.1 | 0.4 |
| EventDispatch | 50 | 0.3 | 785.5 | 15.7 | 395.7 |

...67 more

Excluded 1 profiler artifact event(s) (CpuProfiler::StartProfiling/StopProfiling, 1.3 ms).

## Most frequent events (main thread)

| name | count | total (ms) | self (ms) | avg (ms) | per sec |
| --- | --- | --- | --- | --- | --- |
| UpdateLayoutTree | 5,112 | 45.6 | 45.6 | 0.0 | 1192.1 |
| Layout | 4,974 | 716.3 | 716.3 | 0.1 | 1159.9 |
| RunTask | 1,274 | 1126.7 | 3.6 | 0.9 | 297.1 |
| ThreadControllerImpl::RunTask | 1,195 | 1122.2 | 27.4 | 0.9 | 278.7 |
| BlinkScheduler_PerformMicrotaskCheckpoint | 633 | 0.9 | 0.8 | 0.0 | 147.6 |
| v8.callFunction | 360 | 804.9 | 2.4 | 2.2 | 84.0 |
| FunctionCall | 360 | 802.4 | 68.6 | 2.2 | 84.0 |
| Paint | 347 | 28.9 | 28.9 | 0.2 | 80.9 |
| PrePaint | 321 | 14.0 | 14.0 | 0.0 | 74.9 |
| V8.BytecodeBudgetInterrupt | 245 | 0.4 | 0.4 | 0.0 | 57.1 |
| TimerFire | 180 | 10.6 | 1.7 | 0.1 | 42.0 |
| Layerize | 177 | 16.8 | 16.8 | 0.1 | 41.3 |
| FireAnimationFrame | 177 | 12.4 | 1.8 | 0.1 | 41.3 |
| Commit | 177 | 5.9 | 5.4 | 0.0 | 41.3 |
| UpdateLayer | 177 | 0.5 | 0.5 | 0.0 | 41.3 |
| HitTest | 141 | 1.3 | 1.3 | 0.0 | 32.9 |
| Receive mojo message | 57 | 5.9 | 3.7 | 0.1 | 13.3 |
| EventDispatch | 50 | 785.5 | 0.3 | 15.7 | 11.7 |
| V8.BytecodeBudgetInterruptWithStackCheck | 27 | 0.1 | 0.1 | 0.0 | 6.3 |
| SimpleWatcher::OnHandleReady | 25 | 2.3 | 0.3 | 0.1 | 5.8 |
| LatencyInfo.Flow | 22 | 788.6 | 1.4 | 35.8 | 5.1 |
| Closed mojo endpoint | 19 | 0.1 | 0.1 | 0.0 | 4.4 |
| MinorGC | 13 | 1.5 | 0.3 | 0.1 | 3.0 |
| V8.GCScavenger | 13 | 1.1 | 0.1 | 0.1 | 3.0 |
| V8.GC_SCAVENGER | 13 | 1.0 | 0.1 | 0.1 | 3.0 |

...67 more

Excluded 1 profiler artifact event(s) (CpuProfiler::StartProfiling/StopProfiling, 1.3 ms).

## Hottest JS functions (CPU profile)

Percentages are of 1135.4 ms non-idle sampled time.

| function | self (ms) | self % | total (ms) | location |
| --- | --- | --- | --- | --- |
| resizeBoxes | 779.6 | 68.7% | 779.6 | 127.0.0.1:8080/:43:25 |
| parseConfig | 176.5 | 15.5% | 176.5 | 127.0.0.1:8080/:24:25 |
| (anonymous) | 14.0 | 1.2% | 14.0 | 127.0.0.1:8080/:73:17 |
| crunchNumbers | 5.0 | 0.4% | 5.0 | 127.0.0.1:8080/:58:27 |
| requestAnimationFrame | 3.1 | 0.3% | 3.1 | JS |
| (anonymous) | 2.2 | 0.2% | 179.2 | 127.0.0.1:8080/ |
| spin | 1.6 | 0.1% | 4.7 | 127.0.0.1:8080/:74:18 |
| (anonymous) | 0.4 | 0.0% | 0.4 | JS |
| fetch | 0.3 | 0.0% | 0.3 | JS |
| getElementById | 0.1 | 0.0% | 0.1 | JS |
| setInterval | 0.0 | 0.0% | 0.0 | JS |
| (anonymous) | 0.0 | 0.0% | 0.4 | JS |

## Self time by work group (main thread)

| group | self (ms) | % |
| --- | --- | --- |
| Style & Layout | 761.9 | 67.7% |
| Script Evaluation | 255.1 | 22.7% |
| Rendering | 66.8 | 5.9% |
| Other | 39.5 | 3.5% |
| Garbage Collection | 1.7 | 0.1% |
| Parse HTML & CSS | 0.3 | 0.0% |
| Script Parsing & Compilation | 0.2 | 0.0% |

Top trace categories (first `cat` token):

| trace category | self (ms) | % |
| --- | --- | --- |
| devtools.timeline | 850.3 | 75.6% |
| v8 | 183.0 | 16.3% |
| blink | 46.9 | 4.2% |
| toplevel | 32.2 | 2.9% |
| disabled-by-default-devtools.timeline | 10.0 | 0.9% |
| input | 1.4 | 0.1% |
| loading | 1.0 | 0.1% |
| v8.execute | 0.7 | 0.1% |
