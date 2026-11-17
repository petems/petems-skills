// CLI wrapper: args -> analyzeFile -> render -> stdout or --out.

import { writeFileSync, statSync, lstatSync, openSync, fstatSync, ftruncateSync, closeSync, constants } from 'node:fs';
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
    // Fast checks before the (possibly long) analysis. writeOutputSafely
    // repeats them race-free at write time.
    let inputId = null;
    if (parsed.out) {
      if (sameFile(parsed.out, parsed.file)) throw overInput(parsed.out);
      if (isSymlink(parsed.out)) throw throughSymlink(parsed.out);
      inputId = identity(parsed.file);
    }
    const report = await analyzeFile(parsed.file, parsed.options);
    const text = render(report, { format: parsed.options.format || 'md' });
    if (parsed.out) {
      writeOutputSafely(parsed.out, inputId || identity(parsed.file), text);
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

const overInput = (out) => new UserError(`refusing to write the report over the input trace (${out})`);
const throughSymlink = (out) => new UserError(`refusing to write the report through a symlink (${out}); remove it or choose another path`);

/** { dev, ino } of a path, or null when it cannot be stat'ed. */
function identity(path) {
  try {
    const st = statSync(path);
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Write `text` to `outPath` without ever truncating the input trace, even if
 * the path was swapped during analysis. The file is opened without O_TRUNC
 * and with O_NOFOLLOW (a symlink as the last component is refused, so a
 * planted link, for example in a shared /tmp, cannot redirect the write),
 * then the opened file itself is compared with the input's identity before
 * anything is truncated or written.
 * @param {string} outPath
 * @param {{dev:number, ino:number}|null} inputId identity of the input, taken before analysis
 * @param {string} text
 */
export function writeOutputSafely(outPath, inputId, text) {
  let fd;
  try {
    fd = openSync(outPath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o666);
  } catch (err) {
    if (err && (err.code === 'ELOOP' || err.code === 'EMLINK')) throw throughSymlink(outPath);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (inputId && st.dev === inputId.dev && st.ino === inputId.ino) throw overInput(outPath);
    ftruncateSync(fd, 0);
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
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
