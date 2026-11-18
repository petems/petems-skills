// File loading: gzip detection by magic bytes, streaming decode, tokenizer.

import { createReadStream, promises as fsp } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import { TraceTokenizer } from './tokenizer.mjs';
import { UserError } from './errors.mjs';

/**
 * Default cap on input bytes: bytes read for a plain file, bytes produced by
 * the decompressor for gzip. About 15x the largest real traces seen (263 MB),
 * and it stops a small gzip bomb from expanding without end. `--max-input-mb`
 * raises or lowers it.
 */
export const DEFAULT_MAX_INPUT_MB = 4096;

function tooLarge(limitBytes, gzip) {
  const x = limitBytes / (1024 * 1024);
  const mb = x >= 1 ? Math.round(x * 100) / 100 : Number(x.toPrecision(2));
  const what = gzip ? 'decompressed trace' : 'trace';
  return new UserError(`${what} is larger than the ${mb} MB input limit; if the file is genuine, raise it with --max-input-mb`);
}

/** True when the buffer starts with the gzip magic bytes 1f 8b. */
export function isGzipMagic(buf) {
  return !!buf && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

async function readMagic(path) {
  const fh = await fsp.open(path, 'r');
  try {
    const b = Buffer.alloc(2);
    const { bytesRead } = await fh.read(b, 0, 2, 0);
    return b.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Stream a trace file into onEvent.
 * @param {string} path
 * @param {(event:any)=>void} onEvent
 * @param {{maxInputBytes?: number, maxValueChars?: number, maxEvents?: number}} [limits]
 *   maxInputBytes caps bytes read (plain) or decompressed (gzip); the others
 *   are passed to the tokenizer
 * @returns {Promise<{metadata:any,eventCount:number,truncated:boolean,warnings:string[],fileSize:number,gzip:boolean}>}
 */
export async function loadTraceFile(path, onEvent, limits = {}) {
  let st;
  try {
    st = await fsp.stat(path);
  } catch {
    throw new UserError(`file not found: ${path}`);
  }
  if (!st.isFile()) throw new UserError(`not a file: ${path}`);
  const gzip = isGzipMagic(await readMagic(path));
  const maxInputBytes = limits.maxInputBytes || DEFAULT_MAX_INPUT_MB * 1024 * 1024;
  if (!gzip && st.size > maxInputBytes) throw tooLarge(maxInputBytes, false);

  const tok = new TraceTokenizer(onEvent, limits);
  const decoder = new StringDecoder('utf8');
  const raw = createReadStream(path, { highWaterMark: 1 << 20 });
  let stream = raw;
  if (gzip) {
    const gunzip = createGunzip();
    raw.on('error', (err) => gunzip.destroy(err));
    stream = raw.pipe(gunzip);
  }
  const extraWarnings = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      // Counted before the chunk is used; throwing here ends the loop, which
      // destroys the stream (and the decompressor) straight away.
      total += chunk.length;
      if (total > maxInputBytes) throw tooLarge(maxInputBytes, gzip);
      tok.push(decoder.write(chunk));
    }
  } catch (err) {
    if (err instanceof UserError) throw err;
    if (gzip && err && err.code === 'Z_BUF_ERROR') {
      extraWarnings.push('gzip stream ended early (file truncated); parsed what was there');
    } else if (gzip && err && typeof err.code === 'string' && err.code.startsWith('Z_')) {
      throw new UserError(`not valid gzip data: ${path} (${err.message})`);
    } else {
      throw err;
    }
  } finally {
    if (stream !== raw) raw.destroy();
  }
  tok.push(decoder.end());
  const res = tok.end();
  return { ...res, warnings: extraWarnings.concat(res.warnings), fileSize: st.size, gzip };
}
