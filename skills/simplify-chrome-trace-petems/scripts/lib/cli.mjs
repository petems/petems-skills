// CLI wrapper: args -> analyzeFile -> render -> stdout or --out.

import { writeFileSync, statSync, lstatSync, openSync, fstatSync, fsyncSync, closeSync, renameSync, unlinkSync, realpathSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, parse, sep } from 'node:path';
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
    // repeats them at write time against the directory resolved here.
    let inputId = null;
    let target = null;
    if (parsed.out) {
      if (sameFile(parsed.out, parsed.file)) throw overInput(parsed.out);
      if (isSymlink(parsed.out)) throw throughSymlink(parsed.out);
      target = resolveOutput(parsed.out);
      inputId = identity(parsed.file);
    }
    const report = await analyzeFile(parsed.file, parsed.options);
    const text = render(report, { format: parsed.options.format || 'md' });
    if (parsed.out) {
      writeOutputSafely(target, inputId || identity(parsed.file), text);
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

function isDirectory(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
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
 * Resolve `--out` once, before analysis: the parent directory through
 * realpath (so a symlinked parent such as macOS /tmp works) and its identity,
 * which writeOutputSafely re-checks before it puts the report in place.
 * @param {string} outPath
 * @returns {{display:string, dir:string, dirId:{dev:number, ino:number}, name:string}}
 */
export function resolveOutput(outPath) {
  const name = basename(outPath);
  if (!name || name === '.' || name === '..' || outPath.endsWith('/') || outPath.endsWith(sep) || isDirectory(outPath)) {
    throw new UserError(`--out must name a file, not a directory (${outPath})`);
  }
  let dir;
  let st;
  try {
    dir = realpathSync(dirname(outPath));
    st = statSync(dir);
  } catch (err) {
    throw new UserError(`cannot use the directory of --out (${outPath}): ${err.code || err.message}`);
  }
  if (!st.isDirectory()) throw new UserError(`the parent of --out is not a directory (${outPath})`);
  return { display: outPath, dir, dirId: { dev: st.dev, ino: st.ino }, name };
}

/**
 * Write `text` to the resolved output without ever opening an existing file
 * for writing. The report goes into a fresh temp file in the resolved
 * directory (O_CREAT|O_EXCL|O_NOFOLLOW, random name), then, after checking
 * that no component of that directory has become a symlink, that the
 * directory is still the one resolved at startup, and that the destination is
 * absent or a regular file that is not the input, it is renamed into place.
 * rename replaces the directory entry and never follows a symlink there.
 * Any refusal or error removes the temp file and is a one-line UserError.
 * @param {{display:string, dir:string, dirId:{dev:number, ino:number}, name:string}} target from resolveOutput
 * @param {{dev:number, ino:number}|null} inputId identity of the input, taken before analysis
 * @param {string} text
 */
export function writeOutputSafely(target, inputId, text) {
  const { display, dir, dirId, name } = target;
  const final = join(dir, name);
  const temp = join(dir, `.${name}.${randomBytes(12).toString('hex')}.tmp`);
  let created = false;
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
    created = true;
    let tempId;
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
      const st = fstatSync(fd);
      tempId = { dev: st.dev, ino: st.ino };
    } finally {
      closeSync(fd);
    }
    checkDirectory(dir, dirId, display);
    const t = lstatSync(temp);
    if (!t.isFile() || t.dev !== tempId.dev || t.ino !== tempId.ino) throw movedDir(display);
    let dest = null;
    try {
      dest = lstatSync(final);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (dest) {
      if (dest.isSymbolicLink()) throw throughSymlink(display);
      if (inputId && dest.dev === inputId.dev && dest.ino === inputId.ino) throw overInput(display);
      if (!dest.isFile()) throw new UserError(`refusing to replace something that is not a regular file (${display})`);
    }
    renameSync(temp, final);
    created = false;
  } catch (err) {
    if (created) {
      try {
        unlinkSync(temp);
      } catch {
        // already gone; nothing else to clean up
      }
    }
    if (err instanceof UserError) throw err;
    if (err && err.code === 'ELOOP') throw movedDir(display);
    throw new UserError(`cannot write the report to ${display}: ${String(err && err.message).split('\n')[0]}`);
  }
}

const movedDir = (out) => new UserError(`refusing to write the report: the directory of ${out} changed during analysis`);

/**
 * Refuse unless every component of the realpath'd `dir`, from the root down,
 * is a real directory (no symlinks) and `dir` itself still has identity `id`.
 */
function checkDirectory(dir, id, display) {
  const { root } = parse(dir);
  const parts = dir.slice(root.length).split(sep).filter(Boolean);
  let cur = root;
  let st = lstatSync(cur);
  for (const part of parts) {
    cur = join(cur, part);
    try {
      st = lstatSync(cur);
    } catch {
      throw movedDir(display);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw movedDir(display);
  }
  if (st.dev !== id.dev || st.ino !== id.ino) throw movedDir(display);
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
