// Output formatting helpers (pure).

/** ms with one decimal; '-' for missing values. */
export function fmtMs(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '-';
  const s = (Math.round(x * 10) / 10).toFixed(1);
  return s === '-0.0' ? '0.0' : s;
}

/** µs -> ms number (rounded to 3 decimals for stable JSON). */
export function usToMs(us) {
  return round3(us / 1000);
}

export function round3(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const r = Math.round(x * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

/** Integer with `,` thousands separators, locale independent. */
export function fmtCount(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  const neg = n < 0;
  const s = String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? '-' + s : s;
}

export function fmtPct(x) {
  if (!Number.isFinite(x)) return '-';
  return `${fmtMs(x)}%`;
}

/** Bucket bounds: integers stay integers, otherwise one decimal. */
export function fmtBound(x) {
  return Number.isInteger(x) ? String(x) : fmtMs(x);
}

export const MAX_CELL = 120;

/** Escape a markdown table cell. */
export function escapeCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  s = s.replace(/\r\n|\r|\n/g, ' ');
  if (s.length > MAX_CELL) s = s.slice(0, MAX_CELL - 3) + '...';
  return s.replace(/\|/g, '\\|');
}

/** Render a markdown table. */
export function mdTable(headers, rows) {
  const out = [];
  out.push('| ' + headers.map(escapeCell).join(' | ') + ' |');
  out.push('|' + headers.map(() => '---').join('|') + '|');
  for (const r of rows) out.push('| ' + r.map(escapeCell).join(' | ') + ' |');
  return out.join('\n');
}

export function note(text) {
  return `_${text}_`;
}

/** Drop the URL scheme and middle-truncate to `max` chars (`start...end`). */
export function shortUrl(url, max = 90) {
  let s = String(url || '').replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  if (s.length > max) {
    const keep = max - 3;
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    s = s.slice(0, head) + '...' + s.slice(s.length - tail);
  }
  return s;
}

/** Last path segment of a URL, query/hash stripped. */
export function urlBasename(url) {
  const s = String(url || '').split(/[?#]/)[0];
  const parts = s.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

export function stripQuery(url) {
  return String(url || '').split(/[?#]/)[0];
}

/**
 * Wall clock formatter for an ISO start time. Returns null when unusable.
 * @returns {((offsetMs:number)=>string)|null}
 */
export function makeUtc(startTimeIso) {
  if (typeof startTimeIso !== 'string') return null;
  const base = Date.parse(startTimeIso);
  if (!Number.isFinite(base)) return null;
  return (offsetMs) => {
    if (!Number.isFinite(offsetMs)) return '-';
    return new Date(base + Math.round(offsetMs)).toISOString().slice(11, 23);
  };
}

/** Join markdown blocks, collapse blank-line runs, end with one newline. */
export function joinBlocks(blocks) {
  const text = blocks.filter((b) => b !== null && b !== undefined && b !== '').join('\n\n');
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

/** Stable sort with comparator, returns new array. */
export function sortBy(arr, cmp) {
  return arr.slice().sort(cmp);
}

export function byStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
