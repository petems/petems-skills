// --window parsing and resolution.

import { UsageError, UserError } from './errors.mjs';
import { fmtMs } from './format.mjs';

const NUM = '(\\d+(?:\\.\\d+)?|\\.\\d+)';
const RANGE = new RegExp(`^\\s*${NUM}?\\s*-\\s*${NUM}?\\s*$`);

/**
 * Parse a --window value.
 * @returns {{kind:'breadcrumb'}|{kind:'range',startMs:number|null,endMs:number|null}}
 */
export function parseWindowSpec(text) {
  if (text === 'breadcrumb') return { kind: 'breadcrumb' };
  const m = RANGE.exec(String(text));
  if (!m || (m[1] === undefined && m[2] === undefined)) {
    throw new UsageError(`bad --window "${text}" (expected START-END, START-, -END or breadcrumb)`);
  }
  const startMs = m[1] !== undefined ? Number(m[1]) : null;
  const endMs = m[2] !== undefined ? Number(m[2]) : null;
  if (startMs !== null && endMs !== null && endMs < startMs) {
    throw new UsageError(`bad --window "${text}" (end is before start)`);
  }
  return { kind: 'range', startMs, endMs };
}

/**
 * Turn a window spec into absolute µs bounds.
 * @returns {{set:boolean,start:number,end:number,source:string}}
 */
export function resolveWindow(spec, origin, metadata) {
  if (!spec) return { set: false, start: -Infinity, end: Infinity, source: '' };
  if (spec.kind === 'breadcrumb') {
    const w = metadata && metadata.modifications && metadata.modifications.initialBreadcrumb && metadata.modifications.initialBreadcrumb.window;
    if (!w || typeof w.min !== 'number' || typeof w.max !== 'number') {
      throw new UserError('--window breadcrumb: trace metadata has no modifications.initialBreadcrumb.window');
    }
    return { set: true, start: w.min, end: w.max, source: 'DevTools breadcrumb' };
  }
  return {
    set: true,
    start: spec.startMs === null ? -Infinity : origin + spec.startMs * 1000,
    end: spec.endMs === null ? Infinity : origin + spec.endMs * 1000,
    source: '--window',
  };
}

/**
 * Fail when a set window does not overlap the trace span [origin, traceEnd]
 * at all (it would otherwise report inverted bounds). A window that partly
 * overlaps is fine: it is clipped to the trace.
 */
export function checkWindowOverlap(spec, win, origin, traceEnd) {
  if (!win.set || (win.start <= traceEnd && win.end >= origin)) return;
  const off = (us) => fmtMs((us - origin) / 1000);
  const span = `(${fmtMs(0)}-${off(traceEnd)} ms)`;
  const asked =
    spec.kind === 'breadcrumb'
      ? `breadcrumb ${off(win.start)}-${off(win.end)} ms`
      : `${spec.startMs === null ? '' : spec.startMs}-${spec.endMs === null ? '' : spec.endMs} ms`;
  throw new UserError(`--window ${asked} is outside the trace ${span}`);
}
