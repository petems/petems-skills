# Example trace

A real DevTools-style recording of [`demo/index.html`](demo/index.html), a
small page with deliberate performance problems, plus a screen recording of
the same session.

![Screen recording of the demo page](demo-recording.gif)

([MP4 version](demo-recording.mp4))

The red ball is moved by JavaScript on the main thread. The green ball is a
CSS animation that runs on the compositor. When the main thread is blocked,
the red ball and the clock freeze while the green ball keeps going, and the
"worst frame gap" readout turns red.

## What happens in the recording

| when | what you see | what the report says |
| --- | --- | --- |
| page load | blank page for about 0.6 s | long task in `parseConfig`, 600 ms of script |
| first "Resize boxes" click | red ball and clock freeze for about 0.9 s | long task in `resizeBoxes`, almost all `Layout` (layout thrashing); a slow click interaction, nearly all processing |
| "Crunch numbers" click | nothing noticeable | a short interaction, for contrast |
| second "Resize boxes" click | a longer freeze, about 1.2 s | the worst long task and the INP estimate |
| throughout | smooth motion | `TimerFire` and `FireAnimationFrame` each run about 42 times a second, with the `Paint`, `Layerize` and `Commit` they trigger (in the frequent table, or try `--match timer`) |

See [`demo-report.md`](demo-report.md) for the full default report, or run it
yourself:

```bash
node scripts/simplify-chrome-trace.mjs examples/demo-trace.json.gz
```

## Re-recording

```bash
node examples/record-demo-trace.mjs
```

The recorder uses a throwaway headless Chrome profile and the Chrome DevTools
Protocol, with no npm dependencies. It needs Node 22+, Chrome or Chromium,
and `ffmpeg` for the video (or pass `--no-video`). It keeps only the demo
page's renderer process and refuses to write the trace if it finds non-demo
URLs, extension URLs, or local paths. The video comes from the CDP screencast
in the same session, which adds a little browser-side overhead.

Timings vary from run to run and machine to machine, so re-recording changes
the exact numbers but not the shape of the problems.
