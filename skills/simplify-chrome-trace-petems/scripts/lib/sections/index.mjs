// Section registry, in canonical output order.

import * as summary from './summary.mjs';
import * as timeline from './timeline.mjs';
import * as vitals from './vitals.mjs';
import * as longtasks from './longtasks.mjs';
import * as interactions from './interactions.mjs';
import * as marks from './marks.mjs';
import { events, frequent, categories } from './events.mjs';
import { functions, scripts } from './functions.mjs';
import * as network from './network.mjs';
import * as websocket from './websocket.mjs';

const def = (key, title, description, isDefault, mod) => ({ key, title, description, isDefault, compute: mod.compute, md: mod.md });

export const SECTIONS = [
  def('summary', 'Trace summary', 'header: file, span, window, main thread, profile and task stats, warnings', true, summary),
  def('timeline', 'Timeline', 'main-thread busy time per bucket over the whole trace', false, timeline),
  def('vitals', 'Vitals', 'navigation, FCP, LCP, CLS, DOMContentLoaded, load, if present', true, vitals),
  def('longtasks', 'Long tasks', 'top-level main-thread tasks over the threshold, with what is inside', true, longtasks),
  def('interactions', 'Interactions', 'slow user interactions (EventTiming) and an INP estimate', true, interactions),
  def('marks', 'Marks and measures', 'performance.mark/measure and console.timeStamp', true, marks),
  def('events', 'Hottest events', 'hottest event types by self time', true, events),
  def('frequent', 'Most frequent events', 'most frequent event types by count', true, frequent),
  def('functions', 'Hottest JS functions', 'hottest JS functions from the CPU profile', true, functions),
  def('scripts', 'Scripts', 'sampled self time grouped by script URL', false, scripts),
  def('categories', 'Work groups', 'main-thread self time by work group', true, categories),
  def('network', 'Network', 'request waterfall', false, network),
  def('websocket', 'WebSocket', 'WebSocket connections and lifecycle', false, websocket),
];

export const SECTION_KEYS = SECTIONS.map((s) => s.key);
export const DEFAULT_SECTION_KEYS = SECTIONS.filter((s) => s.isDefault).map((s) => s.key);
