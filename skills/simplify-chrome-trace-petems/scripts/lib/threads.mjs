// Main thread detection and --thread resolution.

import { UserError } from './errors.mjs';
import { cleanText } from './format.mjs';

export function threadLabel(th) {
  const name = th.name || '(unnamed)';
  return `${name} (pid ${th.pid}, tid ${th.tid})`;
}

export function threadShort(th) {
  return th.name || `${th.pid}:${th.tid}`;
}

/** Frame ids and pids of the outermost main frame(s). */
export function mainFrameInfo(model) {
  const frames = model.frames || [];
  let picked = frames.filter((f) => f.isOutermostMainFrame);
  if (picked.length === 0) picked = frames.filter((f) => f.isInPrimaryMainFrame);
  if (picked.length === 0) picked = frames.filter((f) => !f.parent);
  const frameIds = new Set();
  const pids = new Set();
  for (const f of picked) {
    if (f.frame !== undefined) frameIds.add(f.frame);
    if (f.processId !== undefined) pids.add(f.processId);
  }
  for (const fp of model.frameProcesses || []) {
    if (frameIds.has(fp.frame) && fp.processId !== undefined) pids.add(fp.processId);
  }
  return { frameIds, pids };
}

function withEventsFirst(list) {
  const busy = list.filter((t) => t.events.length > 0);
  return busy.length > 0 ? busy : list;
}

/**
 * Pick the main thread(s).
 * @returns {{threads:any[], reason:string}}
 */
export function detectMainThreads(model) {
  const threads = model.threads;
  const { pids } = mainFrameInfo(model);
  if (pids.size > 0) {
    const hit = threads.filter((t) => pids.has(t.pid) && t.name === 'CrRendererMain');
    if (hit.length > 0) {
      return {
        threads: withEventsFirst(hit),
        reason: `CrRendererMain of the main frame's renderer process (pid ${[...pids].join(', ')}) from TracingStartedInBrowser`,
      };
    }
  }
  const renderers = threads.filter((t) => t.name === 'CrRendererMain');
  if (renderers.length > 0) {
    return { threads: withEventsFirst(renderers), reason: 'every CrRendererMain thread (no main frame info in trace)' };
  }
  const browser = threads.filter((t) => t.name === 'CrBrowserMain');
  if (browser.length > 0) {
    return { threads: withEventsFirst(browser), reason: 'CrBrowserMain (no renderer main thread found)' };
  }
  let best = null;
  for (const t of threads) {
    if (t.durSum > 0 && (best === null || t.durSum > best.durSum)) best = t;
  }
  if (best) return { threads: [best], reason: 'thread with the most duration-event time (no named main thread)' };
  return { threads: [], reason: 'no thread with duration events found' };
}

/**
 * Resolve the scope threads, honouring --thread.
 * @param {any} model
 * @param {string|undefined} opt
 */
export function resolveThreads(model, opt) {
  if (opt === undefined || opt === null || opt === '') {
    return { ...detectMainThreads(model), all: false };
  }
  if (opt === 'all') {
    const threads = model.threads.filter((t) => t.events.length > 0);
    return { threads, reason: '--thread all (every thread aggregated)', all: true };
  }
  const m = /^(-?\d+):(-?\d+)$/.exec(opt);
  if (m) {
    const pid = Number(m[1]);
    const tid = Number(m[2]);
    const hit = model.threads.filter((t) => t.pid === pid && t.tid === tid);
    if (hit.length === 0) throw new UserError(`no thread ${opt} in trace. Threads: ${availableThreads(model)}`);
    return { threads: hit, reason: `--thread ${opt}`, all: false };
  }
  // Stored thread names are cleaned (see collect.mjs), so clean the
  // requested name the same way before comparing.
  const lower = cleanText(opt).toLowerCase();
  const hit = model.threads.filter((t) => t.name.toLowerCase() === lower);
  if (hit.length === 0) throw new UserError(`no thread named "${opt}" in trace. Threads: ${availableThreads(model)}`);
  return { threads: withEventsFirst(hit), reason: `--thread "${opt}"`, all: false };
}

function availableThreads(model) {
  const names = [...new Set(model.threads.filter((t) => t.name).map((t) => t.name))].sort();
  const shown = names.slice(0, 15).join(', ');
  return names.length > 15 ? `${shown}, ...` : shown || '(none named)';
}
