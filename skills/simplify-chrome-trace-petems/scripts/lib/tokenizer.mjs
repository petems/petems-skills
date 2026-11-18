// Streaming tokenizer for trace files.
//
// Feed it string chunks of any size with push(); it splits out each
// top-level element of the `traceEvents` array (or of a bare top-level
// array) and JSON.parses it on its own, so the file never has to fit in a
// single JS string. The `metadata` object is captured too, wherever it
// appears. State is carried across chunks, so chunk boundaries can fall
// anywhere (inside strings, escapes, keys, numbers).
//
// Each chunk is scanned once. A value that spans chunks is kept as a list of
// pieces and joined only when it is complete, so a huge value (DevTools can
// store multi-MB source maps in `metadata`) costs linear time rather than
// re-copying a growing prefix on every chunk.
//
// Memory is bounded: a captured value (one event, the metadata object, or a
// top-level key) may not grow past `maxValueChars` while its pieces are
// being collected, and at most `maxEvents` events are accepted. Either limit
// is a single-line UserError, so a small but highly compressible file cannot
// make the tokenizer buffer gigabytes.
//
// The top-level structure is validated strictly (commas between elements,
// no trailing commas, nothing after the end); event contents are validated
// by JSON.parse.

import { UserError } from './errors.mjs';

const START = 0;
const OBJ_FIRST = 1; // top-level object just opened: a key or `}`
const OBJ_KEY = 2; // inside a top-level key string
const OBJ_COLON = 3;
const OBJ_VALUE_WAIT = 4;
const VALUE = 5; // scanning a JSON value
const ARR_FIRST = 6; // events array just opened: an element or `]`
const DONE = 7;
const OBJ_AFTER_VALUE = 8; // `,` or `}`
const OBJ_AFTER_COMMA = 9; // a key (a `}` here is a trailing comma)
const ARR_AFTER_ELEM = 10; // `,` or `]`
const ARR_AFTER_COMMA = 11; // an element (a `]` here is a trailing comma)

const KIND_CONTAINER = 0;
const KIND_STRING = 1;
const KIND_PRIMITIVE = 2;

const TARGET_DISCARD = 0;
const TARGET_EVENT = 1;
const TARGET_METADATA = 2;
const TARGET_KEY = 3; // only used to name a top-level key in errors

/** Largest single value (event, metadata object or key), in UTF-16 code units. */
export const DEFAULT_MAX_VALUE_CHARS = 256 * 1024 * 1024;
/** Most events accepted from one trace. */
export const DEFAULT_MAX_EVENTS = 50_000_000;

function isWs(c) {
  return c === 32 || c === 10 || c === 13 || c === 9 || c === 0xfeff;
}

export class TraceTokenizer {
  /**
   * @param {(event: any) => void} onEvent
   * @param {{maxValueChars?: number, maxEvents?: number}} [limits]
   */
  constructor(onEvent, limits = {}) {
    this.onEvent = onEvent;
    this.maxValueChars = limits.maxValueChars || DEFAULT_MAX_VALUE_CHARS;
    this.maxEvents = limits.maxEvents || DEFAULT_MAX_EVENTS;
    this.state = START;
    this.topIsArray = false;
    this.eventsInObject = false;
    this.foundEvents = false;
    this.eventsClosed = false;
    this.metadata = null;
    this.eventCount = 0;
    this.key = '';
    this.keyStart = 0;
    this.keyEsc = false;
    this.keyParts = []; // pieces of a key that spans chunks
    this.keyLen = 0; // total length of keyParts
    // value scanner
    this.vStart = 0;
    this.vDepth = 0;
    this.vInStr = false;
    this.vEsc = false;
    this.vKind = KIND_CONTAINER;
    this.vTarget = TARGET_DISCARD;
    this.vReturn = OBJ_AFTER_VALUE;
    this.vParts = []; // pieces of a captured value that spans chunks
    this.vLen = 0; // total length of vParts
    this.warnings = [];
  }

  _beginValue(i, c, target, ret) {
    this.vStart = i;
    this.vTarget = target;
    this.vReturn = ret;
    this.vEsc = false;
    if (c === 123 || c === 91) {
      this.vKind = KIND_CONTAINER;
      this.vDepth = 1;
      this.vInStr = false;
    } else if (c === 34) {
      this.vKind = KIND_STRING;
      this.vDepth = 0;
      this.vInStr = true;
    } else {
      this.vKind = KIND_PRIMITIVE;
      this.vDepth = 0;
      this.vInStr = false;
    }
  }

  /** Throw when a captured value of `len` code units is over the limit. */
  _checkValueSize(len, target) {
    if (len <= this.maxValueChars) return;
    const mb = Math.round(this.maxValueChars / (1024 * 1024));
    const what = target === TARGET_EVENT ? `trace event #${this.eventCount + 1}` : target === TARGET_METADATA ? 'the metadata object' : 'a top-level key';
    throw new UserError(`${what} is larger than the ${mb} MB limit for a single value; the trace is malformed or hostile`);
  }

  _finishValue(text) {
    if (this.vTarget === TARGET_EVENT) {
      if (this.eventCount >= this.maxEvents) {
        throw new UserError(`trace has more than ${this.maxEvents.toLocaleString('en-US')} events, the most this tool accepts; record a shorter trace`);
      }
      let ev;
      try {
        ev = JSON.parse(text);
      } catch {
        throw new UserError(`not valid JSON (could not parse trace event #${this.eventCount + 1})`);
      }
      this.eventCount++;
      this.onEvent(ev);
    } else if (this.vTarget === TARGET_METADATA) {
      try {
        const m = JSON.parse(text);
        if (m && typeof m === 'object' && !Array.isArray(m)) this.metadata = m;
      } catch {
        this.warnings.push('metadata object is not valid JSON; ignored');
      }
    }
  }

  /** @param {string} chunk */
  push(chunk) {
    if (!chunk) return;
    const buf = chunk;
    const n = buf.length;
    let i = 0;
    let state = this.state;

    while (i < n) {
      if (state === VALUE) {
        // Hot path: tight scan of the current value.
        let d = this.vDepth;
        let s = this.vInStr;
        let e = this.vEsc;
        const kind = this.vKind;
        let ended = -1; // exclusive end index of the value
        let reprocess = false;
        for (; i < n; i++) {
          const c = buf.charCodeAt(i);
          if (s) {
            if (e) e = false;
            else if (c === 92) e = true;
            else if (c === 34) {
              s = false;
              if (kind === KIND_STRING) {
                ended = i + 1;
                i++;
                break;
              }
            }
            continue;
          }
          if (kind === KIND_PRIMITIVE) {
            if (c === 44 || c === 125 || c === 93 || isWs(c)) {
              ended = i;
              reprocess = true;
              break;
            }
            continue;
          }
          if (c === 34) s = true;
          else if (c === 123 || c === 91) d++;
          else if (c === 125 || c === 93) {
            d--;
            if (d === 0) {
              ended = i + 1;
              i++;
              break;
            }
          }
        }
        this.vDepth = d;
        this.vInStr = s;
        this.vEsc = e;
        if (ended >= 0) {
          if (this.vTarget !== TARGET_DISCARD) {
            this._checkValueSize(this.vLen + (ended - this.vStart), this.vTarget);
            const tail = buf.slice(this.vStart, ended);
            this._finishValue(this.vParts.length ? this.vParts.join('') + tail : tail);
            this.vParts = [];
            this.vLen = 0;
          }
          state = this.vReturn;
          if (reprocess) continue;
        }
        continue;
      }

      const c = buf.charCodeAt(i);
      switch (state) {
        case START:
          if (isWs(c)) break;
          if (c === 91) {
            this.topIsArray = true;
            this.foundEvents = true;
            state = ARR_FIRST;
          } else if (c === 123) {
            state = OBJ_FIRST;
          } else if (c === 34 || c === 45 || (c >= 48 && c <= 57)) {
            throw new UserError('no traceEvents array and not an array');
          } else {
            throw new UserError('not JSON (expected an object or array)');
          }
          break;
        case OBJ_FIRST:
        case OBJ_AFTER_COMMA:
          if (isWs(c)) break;
          if (c === 34) {
            state = OBJ_KEY;
            this.keyStart = i + 1;
            this.keyEsc = false;
          } else if (c === 125 && state === OBJ_FIRST) {
            state = DONE;
          } else if (c === 125) {
            throw new UserError('not JSON (trailing comma in top-level object)');
          } else {
            throw new UserError('not JSON (unexpected character in top-level object)');
          }
          break;
        case OBJ_AFTER_VALUE:
          if (isWs(c)) break;
          if (c === 44) state = OBJ_AFTER_COMMA;
          else if (c === 125) state = DONE;
          else throw new UserError('not JSON (expected "," or "}" in top-level object)');
          break;
        case OBJ_KEY:
          if (this.keyEsc) this.keyEsc = false;
          else if (c === 92) this.keyEsc = true;
          else if (c === 34) {
            this._checkValueSize(this.keyLen + (i + 2 - this.keyStart), TARGET_KEY);
            const tail = buf.slice(this.keyStart - 1, i + 1);
            try {
              this.key = JSON.parse(this.keyParts.length ? this.keyParts.join('') + tail : tail);
            } catch {
              this.key = '';
            }
            this.keyParts = [];
            this.keyLen = 0;
            state = OBJ_COLON;
          }
          break;
        case OBJ_COLON:
          if (isWs(c)) break;
          if (c !== 58) throw new UserError('not JSON (expected ":" in top-level object)');
          state = OBJ_VALUE_WAIT;
          break;
        case OBJ_VALUE_WAIT:
          if (isWs(c)) break;
          // `}`, `,` or `]` here would be an empty member value.
          if (c === 125 || c === 44 || c === 93) throw new UserError('not JSON (missing value in top-level object)');
          if (this.key === 'traceEvents' && c === 91 && !this.foundEvents) {
            this.foundEvents = true;
            this.eventsInObject = true;
            state = ARR_FIRST;
          } else {
            const target = this.key === 'metadata' ? TARGET_METADATA : TARGET_DISCARD;
            this._beginValue(i, c, target, OBJ_AFTER_VALUE);
            state = VALUE;
            if (this.vKind === KIND_PRIMITIVE) continue; // rescan this char as part of value
          }
          break;
        case ARR_FIRST:
        case ARR_AFTER_COMMA:
          if (isWs(c)) break;
          if (c === 93 && state === ARR_FIRST) {
            this.eventsClosed = true;
            state = this.eventsInObject ? OBJ_AFTER_VALUE : DONE;
          } else if (c === 93) {
            throw new UserError('not JSON (trailing comma in traceEvents)');
          } else if (c === 44) {
            throw new UserError('not JSON (unexpected "," in traceEvents)');
          } else {
            this._beginValue(i, c, TARGET_EVENT, ARR_AFTER_ELEM);
            state = VALUE;
            if (this.vKind === KIND_PRIMITIVE) continue;
          }
          break;
        case ARR_AFTER_ELEM:
          if (isWs(c)) break;
          if (c === 44) {
            state = ARR_AFTER_COMMA;
          } else if (c === 93) {
            this.eventsClosed = true;
            state = this.eventsInObject ? OBJ_AFTER_VALUE : DONE;
          } else {
            throw new UserError(`not JSON (expected "," or "]" after trace event #${this.eventCount})`);
          }
          break;
        case DONE:
        default:
          if (!isWs(c)) throw new UserError('not JSON (unexpected data after the end of the trace)');
          break;
      }
      i++;
    }

    // Keep the piece of any partial token; the next chunk continues it from
    // index 0.
    // A captured value is checked against the size limit before its piece is
    // kept, so an oversized value is rejected before it is fully buffered.
    if (state === VALUE && this.vTarget !== TARGET_DISCARD) {
      this._checkValueSize(this.vLen + (n - this.vStart), this.vTarget);
      this.vParts.push(buf.slice(this.vStart));
      this.vLen += n - this.vStart;
      this.vStart = 0;
    } else if (state === OBJ_KEY) {
      this._checkValueSize(this.keyLen + (n - this.keyStart + 1), TARGET_KEY);
      this.keyParts.push(buf.slice(this.keyStart - 1));
      this.keyLen += n - this.keyStart + 1;
      this.keyStart = 1;
    } else {
      this.vStart = 0;
    }
    this.state = state;
  }

  /**
   * Signal end of input. Throws UserError for unusable input, returns a
   * summary otherwise.
   */
  end() {
    const state = this.state;
    if (state === START) throw new UserError('not JSON (file is empty)');
    if (!this.foundEvents) throw new UserError('no traceEvents array and not an array');
    let truncated = false;
    if (state !== DONE) {
      truncated = true;
      if (state === VALUE && this.vTarget === TARGET_EVENT) {
        this.warnings.push(`trace is truncated: dropped a partial event after ${this.eventCount} complete events`);
      } else if (!this.eventsClosed) {
        this.warnings.push(`trace is truncated (missing closing ]); parsed ${this.eventCount} events`);
      } else {
        this.warnings.push('trace is truncated after the traceEvents array');
      }
    }
    return {
      metadata: this.metadata,
      eventCount: this.eventCount,
      truncated,
      warnings: this.warnings.slice(),
    };
  }
}

/**
 * Tokenize a whole string (convenience for tests and small inputs).
 * @param {string} text
 * @param {(event:any)=>void} onEvent
 * @param {number} [chunkSize]
 * @param {{maxValueChars?: number, maxEvents?: number}} [limits]
 */
export function tokenizeString(text, onEvent, chunkSize = 1 << 20, limits = {}) {
  const tok = new TraceTokenizer(onEvent, limits);
  for (let i = 0; i < text.length; i += chunkSize) tok.push(text.slice(i, i + chunkSize));
  return tok.end();
}
