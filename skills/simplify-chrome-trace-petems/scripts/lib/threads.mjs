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

/**
 * The inspected page's root frame, its frame tree and its renderer pid(s).
 *
 * DevTools lists only the inspected tab's frame tree in
 * TracingStartedInBrowser, but other recorders (chrome://tracing, hand-made
 * traces) can list several tabs. Tabs are never combined: one root is chosen
 * (the primary main frame if that settles it, else the first listed, which
 * is the inspected tab's root in DevTools traces and what Lighthouse uses),
 * and `ambiguous` records that a choice was made so the caller can warn.
 * Chrome can put several tabs in one renderer process, so `sharedRoots`
 * counts the other top-level frames listed in the chosen root's process(es).
 *
 * With `inPids` (an explicit --thread on another renderer), only roots that
 * live in those processes (listed there, or moved there by a later
 * FrameCommittedInBrowser / ProcessReadyInBrowser) are candidates, so the
 * selected tab gets its own frame tree. If none does, the frame sets are
 * empty (process-only attribution), never the default tab's frames.
 *
 * @param {any} model
 * @param {Set<any>} [inPids]
 * @returns {{frameIds:Set<string>, treeFrameIds:Set<string>, pids:Set<any>, ambiguous:null|{count:number, pids:any[]}, sharedRoots:number}}
 */
export function mainFrameInfo(model, inPids) {
  const frames = model.frames || [];
  let roots = frames.filter((f) => f.isOutermostMainFrame);
  if (roots.length === 0) roots = frames.filter((f) => f.isInPrimaryMainFrame);
  if (roots.length === 0) roots = frames.filter((f) => !f.parent);
  const allRoots = roots;
  if (inPids) {
    const lives = (pid) => pid !== undefined && inPids.has(pid);
    const moved = new Set((model.frameProcesses || []).filter((fp) => lives(fp.processId)).map((fp) => fp.frame));
    roots = roots.filter((f) => lives(f.processId) || moved.has(f.frame));
  }
  let ambiguous = null;
  if (roots.length > 1) {
    const primary = roots.filter((f) => f.isInPrimaryMainFrame);
    const candidates = primary.length > 0 ? primary : roots;
    if (candidates.length > 1) {
      ambiguous = { count: candidates.length, pids: [...new Set(candidates.map((f) => f.processId).filter((x) => x !== undefined))] };
    }
    roots = candidates.slice(0, 1);
  }
  const root = roots[0];
  const frameIds = new Set();
  const treeFrameIds = new Set();
  const pids = new Set();
  if (root) {
    if (root.frame !== undefined) frameIds.add(root.frame);
    if (root.processId !== undefined) pids.add(root.processId);
    // The root's iframes (any depth) belong to the same page, including
    // iframes committed after tracing started.
    const byParent = new Map();
    for (const f of [...frames, ...(model.frameProcesses || [])]) {
      if (!f.parent) continue;
      if (!byParent.has(f.parent)) byParent.set(f.parent, []);
      byParent.get(f.parent).push(f.frame);
    }
    const stack = [...frameIds];
    while (stack.length) {
      const id = stack.pop();
      if (treeFrameIds.has(id)) continue;
      treeFrameIds.add(id);
      for (const c of byParent.get(id) || []) stack.push(c);
    }
  }
  // Cross-process navigations of the same root frame stay on the same page.
  for (const fp of model.frameProcesses || []) {
    if (frameIds.has(fp.frame) && fp.processId !== undefined) pids.add(fp.processId);
  }
  const sharedRoots = allRoots.filter((f) => f !== root && pids.has(f.processId)).length;
  return { frameIds, treeFrameIds, pids, ambiguous, sharedRoots };
}

function sharedRootsWarning(n, pids) {
  return `${n} other top-level frame${n === 1 ? '' : 's'} (another tab) share${n === 1 ? 's' : ''} the analysed renderer process (pid ${[...pids].join(', ')}); network and WebSocket records are limited to this page's frames, but thread data (tasks, events, CPU profile, interactions, marks) cannot be split per tab and includes the other tab's work.`;
}

/**
 * Page selection for an explicit --thread (name or pid:tid): the default
 * root when the selected threads are in its process, else the root that
 * lives in the selected process (or none). Never the default tab's frames
 * for another renderer.
 */
function overrideScope(model, threads, reason) {
  const pids = new Set(threads.map((t) => t.pid));
  const def = mainFrameInfo(model);
  const mainFrame = [...pids].some((p) => def.pids.has(p)) ? def : mainFrameInfo(model, pids);
  const warnings = mainFrame.sharedRoots > 0 ? [sharedRootsWarning(mainFrame.sharedRoots, mainFrame.pids)] : [];
  return { threads, reason, all: false, mainFrame, warnings };
}

function withEventsFirst(list) {
  const busy = list.filter((t) => t.events.length > 0);
  return busy.length > 0 ? busy : list;
}

const PICK_HINT = 'Use --thread pid:tid to choose another, or --thread all to combine them.';

/**
 * Pick the main thread(s) of one page. Never silently combines tabs: when
 * the trace leaves a choice, one is picked and a warning says so.
 * @returns {{threads:any[], reason:string, warnings:string[]}}
 */
export function detectMainThreads(model) {
  const threads = model.threads;
  const warnings = [];
  const { pids, ambiguous, sharedRoots } = mainFrameInfo(model);
  if (pids.size > 0) {
    const hit = threads.filter((t) => pids.has(t.pid) && t.name === 'CrRendererMain');
    if (hit.length > 0) {
      if (ambiguous) {
        warnings.push(
          `trace lists ${ambiguous.count} top-level frames (renderer pids ${ambiguous.pids.join(', ')}); analysed the first listed (pid ${[...pids].join(', ')}). ${PICK_HINT}`,
        );
      }
      if (sharedRoots > 0) warnings.push(sharedRootsWarning(sharedRoots, pids));
      return {
        threads: withEventsFirst(hit),
        reason: `CrRendererMain of the main frame's renderer process (pid ${[...pids].join(', ')}) from TracingStartedInBrowser`,
        warnings,
      };
    }
  }
  const renderers = withEventsFirst(threads.filter((t) => t.name === 'CrRendererMain'));
  if (renderers.length > 0) {
    if (renderers.length === 1) {
      return { threads: renderers, reason: 'the only CrRendererMain thread (no main frame info in trace)', warnings };
    }
    // Several renderers and no frame info: likely several tabs. Pick the
    // busiest rather than mixing them.
    const busiest = renderers.reduce((a, t) => (t.durSum > a.durSum ? t : a));
    warnings.push(
      `trace has ${renderers.length} renderer main threads (pids ${renderers.map((t) => t.pid).join(', ')}) and no main frame info; analysed the busiest (pid ${busiest.pid}, tid ${busiest.tid}). ${PICK_HINT}`,
    );
    return { threads: [busiest], reason: 'the busiest CrRendererMain thread (no main frame info in trace)', warnings };
  }
  const browser = threads.filter((t) => t.name === 'CrBrowserMain');
  if (browser.length > 0) {
    return { threads: withEventsFirst(browser), reason: 'CrBrowserMain (no renderer main thread found)', warnings };
  }
  let best = null;
  for (const t of threads) {
    if (t.durSum > 0 && (best === null || t.durSum > best.durSum)) best = t;
  }
  if (best) return { threads: [best], reason: 'thread with the most duration-event time (no named main thread)', warnings };
  return { threads: [], reason: 'no thread with duration events found', warnings };
}

/**
 * Resolve the scope threads, honouring --thread. An explicit name or
 * pid:tid also returns `mainFrame`, the selected page's frame info.
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
    return overrideScope(model, hit, `--thread ${opt}`);
  }
  // Stored thread names are cleaned (see collect.mjs), so clean the
  // requested name the same way before comparing.
  const lower = cleanText(opt).toLowerCase();
  const hit = model.threads.filter((t) => t.name.toLowerCase() === lower);
  if (hit.length === 0) throw new UserError(`no thread named "${opt}" in trace. Threads: ${availableThreads(model)}`);
  // Each renderer process is a tab (or an out-of-process iframe), so a name
  // that matches threads in several processes would combine tabs. Refuse and
  // list the candidates rather than guess. Several matches in one process
  // (a thread pool, a page's workers) are one page and are combined.
  const pids = new Set(hit.map((t) => t.pid));
  if (pids.size > 1) {
    const ids = [...hit].sort((a, b) => a.pid - b.pid || a.tid - b.tid).map((t) => `${t.pid}:${t.tid}`);
    const shown = ids.length > 15 ? `${ids.slice(0, 15).join(', ')}, ...` : ids.join(', ');
    throw new UserError(
      `thread name "${cleanText(opt)}" matches threads in ${pids.size} processes (${shown}); choose one with --thread pid:tid, or use --thread all to combine everything.`,
    );
  }
  const threads = withEventsFirst(hit);
  const count = threads.length > 1 ? ` (${threads.length} threads in pid ${threads[0].pid})` : '';
  return overrideScope(model, threads, `--thread "${opt}"${count}`);
}

function availableThreads(model) {
  const names = [...new Set(model.threads.filter((t) => t.name).map((t) => t.name))].sort();
  const shown = names.slice(0, 15).join(', ');
  return names.length > 15 ? `${shown}, ...` : shown || '(none named)';
}
