# Trace summary: demo-trace.json.gz

- File: 1.1 MB, 87,222 events
- Recording: source record-demo-trace.mjs, started 2026-11-17T21:38:50.664Z
- Span: 10085.6 ms
- Main thread: CrRendererMain (pid 31077, tid 12039599), chosen by every CrRendererMain thread (no main frame info in trace)
- CPU profile CrRendererMain (31077:12039599): sampled 9625.8 ms, busy 3755.0 ms, idle 5870.8 ms, program 1033.0 ms, GC 2.0 ms
- Main-thread tasks in scope: 3,426 tasks, busy 3732.5 ms (37.0% of 10085.6 ms), 3 over 50 ms, TBT (all tasks in scope) 2519.7 ms
- Warnings:
  - 8 unclosed B event(s) at end of trace were dropped

## Vitals

| metric | offset (ms) | since nav (ms) | detail |
| --- | --- | --- | --- |
| Navigation start | 440.3 | 0.0 | 127.0.0.1:8080/ |
| First Contentful Paint | 1089.8 | 649.5 | |
| Largest Contentful Paint | 1089.8 | 649.5 | size 22824, type text, node 7, 1 candidate |
| DOMContentLoaded | 1068.2 | 627.9 | |
| Load | 1068.4 | 628.0 | |
| Cumulative Layout Shift | 1169.2 | 728.8 | total 0.0010 over 2 shifts; largest session window 0.0010 (2 shifts) starting here |

2 navigations in scope; times are relative to the one that preceded the first paint.

## Long tasks (>= 50.0 ms)

3 long task(s) in scope.

| # | dur (ms) | offset (ms) | name | inside | top JS |
| --- | --- | --- | --- | --- | --- |
| 1 | 1160.7 | 7122.1 | RunTask | Layout 1112.1, FunctionCall 31.0, UpdateLayoutTree 16.3 | resizeBoxes (127.0.0.1:8080:61) 1158.1 |
| 2 | 906.3 | 2888.7 | RunTask | Layout 860.7, FunctionCall 28.2, UpdateLayoutTree 16.1 | resizeBoxes (127.0.0.1:8080:61) 903.8 |
| 3 | 602.8 | 448.1 | RunTask | v8.run 601.9, ParseHTML 0.3, v8.compile 0.2 | parseConfig (127.0.0.1:8080:39) 595.8, (anonymous) (127.0.0.1:8080) 4.6 |

## Interactions

INP estimate: 1182.3 ms (worst interaction, 3 interactions).

| # | offset (ms) | type | dur (ms) | input delay (ms) | processing (ms) | presentation (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 7118.6 | pointerdown, pointerup, click | 1182.3 | 1.3 | 1160.5 | 20.5 |
| 2 | 2887.3 | pointerdown, pointerup, click | 913.9 | 0.4 | 905.2 | 8.3 |
| 3 | 5601.6 | pointerdown, pointerup, click | 49.3 | 1.3 | 6.3 | 41.7 |

## Marks and measures

11 entries in scope.

| offset (ms) | kind | name | dur (ms) |
| --- | --- | --- | --- |
| 450.1 | mark | demo:boot-start | - |
| 450.1 | measure | demo:boot | 600.1 |
| 1050.2 | mark | demo:boot-end | - |
| 2889.1 | mark | demo:thrash-start | - |
| 2889.1 | measure | demo:thrash | 903.8 |
| 2889.1 | timeStamp | demo: resize clicked | - |
| 3792.8 | mark | demo:thrash-end | - |
| 7122.2 | mark | demo:thrash-start | - |
| 7122.2 | measure | demo:thrash | 1158.1 |
| 7122.2 | timeStamp | demo: resize clicked | - |
| 8280.3 | mark | demo:thrash-end | - |

## Hottest events by self time (main thread)

| name | count | self (ms) | total (ms) | avg (ms) | max (ms) |
| --- | --- | --- | --- | --- | --- |
| Layout | 2,225 | 2041.4 | 2041.4 | 0.9 | 13.3 |
| v8.run | 1 | 601.9 | 603.4 | 603.4 | 603.4 |
| Paint | 842 | 395.4 | 395.4 | 0.9 | 1.9 |
| Layerize | 421 | 242.0 | 242.0 | 0.6 | 0.9 |
| FunctionCall | 861 | 118.1 | 2121.6 | 2.5 | 1158.2 |
| PrePaint | 756 | 97.6 | 97.6 | 0.1 | 1.3 |
| ThreadControllerImpl::RunTask | 3,192 | 95.9 | 3720.0 | 1.2 | 1160.7 |
| UpdateLayoutTree | 2,743 | 69.5 | 69.6 | 0.0 | 2.0 |
| Commit | 421 | 19.2 | 22.7 | 0.1 | 0.2 |
| RunTask | 3,419 | 10.6 | 3733.0 | 1.1 | 1160.7 |
| v8.callFunction | 861 | 7.3 | 2128.9 | 2.5 | 1158.2 |
| HitTest | 336 | 6.3 | 6.3 | 0.0 | 0.1 |
| TimerFire | 436 | 5.0 | 29.4 | 0.1 | 0.2 |
| Receive mojo message | 94 | 4.5 | 6.4 | 0.1 | 2.0 |
| FireAnimationFrame | 422 | 4.3 | 41.5 | 0.1 | 0.5 |
| UpdateLayer | 990 | 3.4 | 3.4 | 0.0 | 0.0 |
| BlinkScheduler_PerformMicrotaskCheckpoint | 1,699 | 2.3 | 2.5 | 0.0 | 0.1 |
| LatencyInfo.Flow | 22 | 1.5 | 2074.0 | 94.3 | 1160.6 |
| EvaluateScript | 4 | 0.5 | 604.1 | 151.0 | 603.6 |
| ParseHTML | 4 | 0.4 | 604.0 | 151.0 | 604.0 |
| DocumentLoader::CommitNavigation | 2 | 0.3 | 1.4 | 0.7 | 1.1 |
| EventDispatch | 48 | 0.3 | 2067.6 | 43.1 | 1158.2 |
| SimpleWatcher::OnHandleReady | 27 | 0.3 | 2.4 | 0.1 | 1.7 |
| V8.DeserializeContext | 1 | 0.3 | 0.3 | 0.3 | 0.3 |
| v8.compile | 1 | 0.2 | 0.2 | 0.2 | 0.2 |

...124 more

Excluded 1 profiler artifact event(s) (CpuProfiler::StartProfiling/StopProfiling, 1.3 ms).

## Most frequent events (main thread)

| name | count | total (ms) | self (ms) | avg (ms) | per sec |
| --- | --- | --- | --- | --- | --- |
| RunTask | 3,419 | 3733.0 | 10.6 | 1.1 | 339.0 |
| ThreadControllerImpl::RunTask | 3,192 | 3720.0 | 95.9 | 1.2 | 316.5 |
| UpdateLayoutTree | 2,743 | 69.6 | 69.5 | 0.0 | 272.0 |
| Layout | 2,225 | 2041.4 | 2041.4 | 0.9 | 220.6 |
| BlinkScheduler_PerformMicrotaskCheckpoint | 1,699 | 2.5 | 2.3 | 0.0 | 168.5 |
| UpdateLayer | 990 | 3.4 | 3.4 | 0.0 | 98.2 |
| v8.callFunction | 861 | 2128.9 | 7.3 | 2.5 | 85.4 |
| FunctionCall | 861 | 2121.6 | 118.1 | 2.5 | 85.4 |
| Paint | 842 | 395.4 | 395.4 | 0.9 | 83.5 |
| PrePaint | 756 | 97.6 | 97.6 | 0.1 | 75.0 |
| TimerFire | 436 | 29.4 | 5.0 | 0.1 | 43.2 |
| FireAnimationFrame | 422 | 41.5 | 4.3 | 0.1 | 41.8 |
| Layerize | 421 | 242.0 | 242.0 | 0.6 | 41.7 |
| Commit | 421 | 22.7 | 19.2 | 0.1 | 41.7 |
| HitTest | 336 | 6.3 | 6.3 | 0.0 | 33.3 |
| V8.BytecodeBudgetInterrupt | 155 | 0.2 | 0.2 | 0.0 | 15.4 |
| Receive mojo message | 94 | 6.4 | 4.5 | 0.1 | 9.3 |
| EventDispatch | 48 | 2067.6 | 0.3 | 43.1 | 4.8 |
| SimpleWatcher::OnHandleReady | 27 | 2.4 | 0.3 | 0.1 | 2.7 |
| V8.BytecodeBudgetInterruptWithStackCheck | 25 | 0.1 | 0.1 | 0.0 | 2.5 |
| LatencyInfo.Flow | 22 | 2074.0 | 1.5 | 94.3 | 2.2 |
| Closed mojo endpoint | 15 | 0.1 | 0.1 | 0.0 | 1.5 |
| PageTimingMetricsSender::SendNow | 12 | 0.2 | 0.2 | 0.0 | 1.2 |
| v8.newInstance | 11 | 0.0 | 0.0 | 0.0 | 1.1 |
| V8.GC_HEAP_ENSURE_SWEEPING_COMPLETED | 9 | 0.0 | 0.0 | 0.0 | 0.9 |

...124 more

Excluded 1 profiler artifact event(s) (CpuProfiler::StartProfiling/StopProfiling, 1.3 ms).

## Hottest JS functions (CPU profile)

Percentages are of 3755.0 ms non-idle sampled time.

| function | self (ms) | self % | total (ms) | location |
| --- | --- | --- | --- | --- |
| resizeBoxes | 2062.0 | 54.9% | 2062.0 | 127.0.0.1:8080/:61:25 |
| parseConfig | 595.8 | 15.9% | 595.8 | 127.0.0.1:8080/:39:25 |
| (anonymous) | 30.5 | 0.8% | 30.5 | 127.0.0.1:8080/:112:17 |
| requestAnimationFrame | 11.8 | 0.3% | 11.8 | JS |
| frame | 9.6 | 0.3% | 21.3 | 127.0.0.1:8080/:96:19 |
| crunchNumbers | 4.9 | 0.1% | 4.9 | 127.0.0.1:8080/:76:27 |
| (anonymous) | 4.6 | 0.1% | 601.1 | 127.0.0.1:8080/ |
| fetch | 0.3 | 0.0% | 0.3 | JS |
| getElementById | 0.3 | 0.0% | 0.3 | JS |
| querySelector | 0.1 | 0.0% | 0.1 | JS |
| setInterval | 0.1 | 0.0% | 0.1 | JS |
| (anonymous) | 0.0 | 0.0% | 0.2 | JS |
| (anonymous) | 0.0 | 0.0% | 0.2 | JS |

## Self time by work group (main thread)

| group | self (ms) | % |
| --- | --- | --- |
| Style & Layout | 2110.9 | 56.6% |
| Rendering | 763.9 | 20.5% |
| Script Evaluation | 737.6 | 19.8% |
| Other | 117.3 | 3.1% |
| Garbage Collection | 2.1 | 0.1% |
| Parse HTML & CSS | 0.4 | 0.0% |
| Script Parsing & Compilation | 0.2 | 0.0% |

Top trace categories (first `cat` token):

| trace category | self (ms) | % |
| --- | --- | --- |
| devtools.timeline | 2906.6 | 77.9% |
| v8 | 610.2 | 16.3% |
| toplevel | 103.1 | 2.8% |
| blink | 75.9 | 2.0% |
| disabled-by-default-devtools.timeline | 33.6 | 0.9% |
| input | 1.5 | 0.0% |
| loading | 1.0 | 0.0% |
| v8.execute | 0.5 | 0.0% |
