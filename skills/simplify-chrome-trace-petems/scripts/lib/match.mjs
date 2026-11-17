// --match: case-insensitive substring, or /regex/flags.

import { UsageError } from './errors.mjs';

/** @returns {((...labels:any[])=>boolean)|null} null means "no filter" */
export function makeMatcher(text) {
  if (text === undefined || text === null || text === '') return null;
  const m = /^\/(.*)\/([a-z]*)$/s.exec(text);
  if (m) {
    let re;
    try {
      re = new RegExp(m[1], m[2].replace(/[gy]/g, ''));
    } catch (err) {
      throw new UsageError(`invalid --match regex ${text}: ${err.message}`);
    }
    return (...labels) => labels.some((l) => l !== null && l !== undefined && re.test(String(l)));
  }
  const needle = text.toLowerCase();
  return (...labels) => labels.some((l) => l !== null && l !== undefined && String(l).toLowerCase().includes(needle));
}
