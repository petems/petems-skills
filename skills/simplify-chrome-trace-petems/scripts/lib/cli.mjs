// CLI wrapper: args -> analyzeFile -> render -> stdout or --out.

import { writeFileSync, statSync } from 'node:fs';
import { parseArgs, USAGE, listText } from './args.mjs';
import { analyzeFile, render } from './analyze.mjs';
import { UserError, UsageError } from './errors.mjs';

const PROG = 'simplify-chrome-trace';

/**
 * Run the CLI. Returns the exit code.
 * @param {string[]} argv
 * @param {{stdout?:NodeJS.WritableStream, stderr?:NodeJS.WritableStream}} [io]
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`${PROG}: ${err.message}. Run with --help\n`);
      return 2;
    }
    throw err;
  }
  if (parsed.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (parsed.list) {
    stdout.write(listText());
    return 0;
  }
  const started = Date.now();
  try {
    if (parsed.out && sameFile(parsed.out, parsed.file)) {
      throw new UserError(`refusing to write the report over the input trace (${parsed.out})`);
    }
    const report = await analyzeFile(parsed.file, parsed.options);
    const text = render(report, { format: parsed.options.format || 'md' });
    if (parsed.out) {
      writeFileSync(parsed.out, text);
      const bytes = Buffer.byteLength(text);
      const mb = (statSync(parsed.file).size / (1024 * 1024)).toFixed(1);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      stderr.write(`Wrote ${parsed.out} (${bytes} bytes) from ${mb} MB trace in ${secs}s\n`);
    } else {
      stdout.write(text);
    }
    return 0;
  } catch (err) {
    if (err instanceof UserError) {
      stderr.write(`${PROG}: error: ${err.message}\n`);
      return 1;
    }
    if (err instanceof UsageError) {
      stderr.write(`${PROG}: ${err.message}. Run with --help\n`);
      return 2;
    }
    if (err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EISDIR')) {
      stderr.write(`${PROG}: error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

/** True when both paths name the same existing file (symlinks and hard links included). */
function sameFile(a, b) {
  try {
    const x = statSync(a);
    const y = statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false; // either does not exist yet, so they cannot be the same file
  }
}
