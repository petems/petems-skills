// Command-line parsing (pure: argv in, options out, UsageError on mistakes).

import { UsageError } from './errors.mjs';
import { SECTIONS, SECTION_KEYS, DEFAULT_SECTION_KEYS } from './sections/index.mjs';
import { parseWindowSpec } from './window.mjs';
import { makeMatcher } from './match.mjs';

export const USAGE = `Usage: node scripts/simplify-chrome-trace.mjs <trace.json[.gz]> [options]

Summarise a Chrome DevTools performance trace into a compact markdown report.

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
  --max-input-mb N      refuse input (after gunzip) over N MB (default 4096)
  --list                print section keys and descriptions, exit 0
  -h, --help            usage, exit 0
`;

export function listText() {
  const w = Math.max(...SECTION_KEYS.map((k) => k.length));
  const lines = ['Sections (* = default):'];
  for (const s of SECTIONS) lines.push(`  ${s.isDefault ? '*' : ' '} ${s.key.padEnd(w)}  ${s.description}`);
  return lines.join('\n') + '\n';
}

const VALUE_FLAGS = new Set(['--top', '--long-task-ms', '--window', '--bucket', '--thread', '--only', '--except', '--match', '--format', '--out', '--max-input-mb']);
const BOOL_FLAGS = new Set(['--all', '--wall-clock', '--list', '--help', '-h']);

function positiveNumber(flag, v, integer = false) {
  const n = Number(v);
  if (v === '' || !Number.isFinite(n)) throw new UsageError(`${flag} expects a number, got "${v}"`);
  if (n <= 0) throw new UsageError(`${flag} must be positive, got ${v}`);
  if (integer && !Number.isInteger(n)) throw new UsageError(`${flag} must be a whole number, got ${v}`);
  return n;
}

function sectionList(flag, v) {
  const keys = v.split(',').map((s) => s.trim()).filter(Boolean);
  if (!keys.length) throw new UsageError(`${flag} needs at least one section key`);
  for (const k of keys) {
    if (!SECTION_KEYS.includes(k)) throw new UsageError(`unknown section "${k}" for ${flag} (valid: ${SECTION_KEYS.join(', ')})`);
  }
  return keys;
}

/**
 * @param {string[]} argv
 * @returns {{help?:boolean,list?:boolean,file?:string,out?:string,options:object}}
 */
export function parseArgs(argv) {
  const raw = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('-') || a === '-') {
      positionals.push(a);
      continue;
    }
    let value;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      value = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    if (BOOL_FLAGS.has(a)) {
      if (value !== undefined) throw new UsageError(`${a} does not take a value`);
      raw[a === '-h' ? '--help' : a] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(a)) throw new UsageError(`unknown flag ${a}`);
    if (value === undefined) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      // `--out --all` means the value is missing, not a file called --all.
      // Only exact known flags count, so `--window -100` still works and an
      // odd literal can be passed as `--out=--all`.
      const next = argv[i + 1];
      const nextFlag = next.startsWith('--') && next.includes('=') ? next.slice(0, next.indexOf('=')) : next;
      if (VALUE_FLAGS.has(nextFlag) || BOOL_FLAGS.has(nextFlag)) throw new UsageError(`${a} needs a value (got the flag ${next})`);
      value = argv[++i];
    }
    if (value === '') throw new UsageError(`${a} needs a value`);
    raw[a] = value;
  }

  if (raw['--help']) return { help: true, options: {} };
  if (raw['--list']) return { list: true, options: {} };

  const options = {};
  if (raw['--top'] !== undefined) options.top = positiveNumber('--top', raw['--top'], true);
  if (raw['--long-task-ms'] !== undefined) options.longTaskMs = positiveNumber('--long-task-ms', raw['--long-task-ms']);
  if (raw['--bucket'] !== undefined) {
    options.bucketMs = positiveNumber('--bucket', raw['--bucket']);
    // Timestamps are microseconds; sub-millisecond buckets only multiply rows.
    if (options.bucketMs < 1) throw new UsageError(`--bucket must be at least 1 ms, got ${raw['--bucket']}`);
  }
  if (raw['--window'] !== undefined) options.window = parseWindowSpec(raw['--window']);
  if (raw['--thread'] !== undefined) options.thread = raw['--thread'];
  if (raw['--match'] !== undefined) {
    makeMatcher(raw['--match']); // validate regex early
    options.match = raw['--match'];
  }
  if (raw['--max-input-mb'] !== undefined) {
    options.maxInputMb = positiveNumber('--max-input-mb', raw['--max-input-mb']);
    // Below one byte the limit would reject every file.
    if (options.maxInputMb * 1024 * 1024 < 1) throw new UsageError(`--max-input-mb is too small, got ${raw['--max-input-mb']}`);
  }
  if (raw['--wall-clock']) options.wallClock = true;
  if (raw['--format'] !== undefined) {
    if (raw['--format'] !== 'md' && raw['--format'] !== 'json') throw new UsageError(`--format must be md or json, got "${raw['--format']}"`);
    options.format = raw['--format'];
  }
  let sections = raw['--all'] ? SECTION_KEYS.slice() : DEFAULT_SECTION_KEYS.slice();
  if (raw['--only'] !== undefined) sections = sectionList('--only', raw['--only']);
  if (raw['--except'] !== undefined) {
    const drop = new Set(sectionList('--except', raw['--except']));
    sections = sections.filter((k) => !drop.has(k));
  }
  options.sections = sections;

  if (positionals.length === 0) throw new UsageError('missing trace file');
  if (positionals.length > 1) throw new UsageError(`expected one trace file, got ${positionals.length}`);
  return { file: positionals[0], out: raw['--out'], options };
}
