// Streaming tokenizer for trace files.
//
// Feed it string chunks of any size with push(); it splits out each
// top-level element of the `traceEvents` array (or of a bare top-level
// array) and JSON.parses it on its own, so the file never has to fit in a
// single JS string. The `metadata` object is captured too, wherever it
// appears. State is carried across chunks, so chunk boundaries can fall
// anywhere (inside strings, escapes, keys, numbers).

import { UserError } from './errors.mjs';

const START = 0;
const OBJ_KEY_WAIT = 1; // top-level object, waiting for a key (or `}`)
const OBJ_KEY = 2; // inside a top-level key string
const OBJ_COLON = 3;
const OBJ_VALUE_WAIT = 4;
const VALUE = 5; // scanning a JSON value
const ARR_ELEM_WAIT = 6; // inside the events array, between elements
const DONE = 7;

const KIND_CONTAINER = 0;
const KIND_STRING = 1;
const KIND_PRIMITIVE = 2;

const TARGET_DISCARD = 0;
const TARGET_EVENT = 1;
const TARGET_METADATA = 2;

function isWs(c) {
  return c === 32 || c === 10 || c === 13 || c === 9 || c === 0xfeff;
}

export class TraceTokenizer {
  /** @param {(event: any) => void} onEvent */
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.state = START;
    this.carry = '';
    this.pos = 0;
    this.topIsArray = false;
    this.eventsInObject = false;
    this.foundEvents = false;
    this.eventsClosed = false;
    this.metadata = null;
    this.eventCount = 0;
    this.key = '';
    this.keyStart = 0;
    this.keyEsc = false;
    // value scanner
    this.vStart = 0;
    this.vDepth = 0;
    this.vInStr = false;
    this.vEsc = false;
    this.vKind = KIND_CONTAINER;
    this.vTarget = TARGET_DISCARD;
    this.vReturn = OBJ_KEY_WAIT;
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

  _finishValue(text) {
    if (this.vTarget === TARGET_EVENT) {
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
    const buf = this.carry ? this.carry + chunk : chunk;
    const n = buf.length;
    let i = this.pos;
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
          if (this.vTarget !== TARGET_DISCARD) this._finishValue(buf.slice(this.vStart, ended));
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
            state = ARR_ELEM_WAIT;
          } else if (c === 123) {
            state = OBJ_KEY_WAIT;
          } else if (c === 34 || c === 45 || (c >= 48 && c <= 57)) {
            throw new UserError('no traceEvents array and not an array');
          } else {
            throw new UserError('not JSON (expected an object or array)');
          }
          break;
        case OBJ_KEY_WAIT:
          if (isWs(c) || c === 44) break;
          if (c === 34) {
            state = OBJ_KEY;
            this.keyStart = i + 1;
            this.keyEsc = false;
          } else if (c === 125) {
            state = DONE;
          } else {
            throw new UserError('not JSON (unexpected character in top-level object)');
          }
          break;
        case OBJ_KEY:
          if (this.keyEsc) this.keyEsc = false;
          else if (c === 92) this.keyEsc = true;
          else if (c === 34) {
            try {
              this.key = JSON.parse(buf.slice(this.keyStart - 1, i + 1));
            } catch {
              this.key = '';
            }
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
          if (this.key === 'traceEvents' && c === 91 && !this.foundEvents) {
            this.foundEvents = true;
            this.eventsInObject = true;
            state = ARR_ELEM_WAIT;
          } else {
            const target = this.key === 'metadata' ? TARGET_METADATA : TARGET_DISCARD;
            this._beginValue(i, c, target, OBJ_KEY_WAIT);
            state = VALUE;
            if (this.vKind === KIND_PRIMITIVE) continue; // rescan this char as part of value
          }
          break;
        case ARR_ELEM_WAIT:
          if (isWs(c) || c === 44) break;
          if (c === 93) {
            this.eventsClosed = true;
            state = this.eventsInObject ? OBJ_KEY_WAIT : DONE;
          } else {
            this._beginValue(i, c, TARGET_EVENT, ARR_ELEM_WAIT);
            state = VALUE;
            if (this.vKind === KIND_PRIMITIVE) continue;
          }
          break;
        case DONE:
        default:
          break;
      }
      i++;
    }

    // Keep any partial token for the next chunk.
    if (state === VALUE && this.vTarget !== TARGET_DISCARD) {
      this.carry = buf.slice(this.vStart);
      this.pos = this.carry.length;
      this.vStart = 0;
    } else if (state === OBJ_KEY) {
      const from = this.keyStart - 1;
      this.carry = buf.slice(from);
      this.pos = this.carry.length;
      this.keyStart = 1;
    } else {
      this.carry = '';
      this.pos = 0;
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
 */
export function tokenizeString(text, onEvent, chunkSize = 1 << 20) {
  const tok = new TraceTokenizer(onEvent);
  for (let i = 0; i < text.length; i += chunkSize) tok.push(text.slice(i, i + chunkSize));
  return tok.end();
}
