// File loading: gzip detection by magic bytes, streaming decode, tokenizer.

import { createReadStream, promises as fsp } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import { TraceTokenizer } from './tokenizer.mjs';
import { UserError } from './errors.mjs';

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
 * @returns {Promise<{metadata:any,eventCount:number,truncated:boolean,warnings:string[],fileSize:number,gzip:boolean}>}
 */
export async function loadTraceFile(path, onEvent) {
  let st;
  try {
    st = await fsp.stat(path);
  } catch {
    throw new UserError(`file not found: ${path}`);
  }
  if (!st.isFile()) throw new UserError(`not a file: ${path}`);
  const gzip = isGzipMagic(await readMagic(path));

  const tok = new TraceTokenizer(onEvent);
  const decoder = new StringDecoder('utf8');
  const raw = createReadStream(path, { highWaterMark: 1 << 20 });
  let stream = raw;
  if (gzip) {
    const gunzip = createGunzip();
    raw.on('error', (err) => gunzip.destroy(err));
    stream = raw.pipe(gunzip);
  }
  const extraWarnings = [];
  try {
    for await (const chunk of stream) tok.push(decoder.write(chunk));
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
