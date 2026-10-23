/**
 * Host half of `dsh-peak-cost` — https://github.com/ogidimitrov/dsh-peak-cost
 *
 * Folds the durable session log into an estimated USD spend for one Session and
 * publishes it as the client-visible `peakCost` session projection, so the Web
 * client renders a number computed from the whole log instead of re-folding
 * events itself (see the Harness plugin practices: `wire.view`).
 *
 * Prices and the peak/off-peak calendar come from DeepSeek's published list:
 * https://api-docs.deepseek.com/quick_start/pricing/
 *
 *   peak hours   01:00-04:00 and 06:00-10:00 UTC, Monday-Friday,
 *                excluding Chinese public holidays
 *   off-peak     every other hour, all weekend, and Chinese public holidays
 *   off-peak rates are half of the peak rates
 *
 * Edit `MODEL_RATES` when DeepSeek changes prices; the fold prices each model
 * call at the rate card and billing window that applied when it ran, so a
 * session that crosses a peak boundary stays accurate.
 */

/** Peak list prices in USD per 1M tokens: cache-hit input, cache-miss input, output. */
const MODEL_RATES = {
  'deepseek-flash': { hit: 0.006, miss: 0.3, out: 1.2 },
  'deepseek-v4-pro': { hit: 0.044, miss: 1.32, out: 3.96 },
};

/** Off-peak list prices are half of the peak list prices. */
const OFF_PEAK_FACTOR = 0.5;

/** Peak billing windows as [startMinute, endMinute) of the UTC day. */
const PEAK_WINDOWS = [
  [60, 240],
  [360, 600],
];

/** Peak billing applies on weekdays only. */
const PEAK_WEEKDAYS_ONLY = true;

/** Chinese public holidays (UTC `YYYY-MM-DD`) are fully off-peak. Empty by default. */
const PEAK_HOLIDAYS = [];

/**
 * Resolve one model id to a rate card, tolerating the aliases DeepSeek keeps
 * accepting. Unknown routes are counted but priced at zero and reported.
 * @param {string} model - the durable assistant message's model id.
 * @returns {{hit: number, miss: number, out: number} | undefined} the rate card.
 */
function rateFor(model) {
  if (typeof model !== 'string' || model.length === 0) return undefined;
  const id = model.toLowerCase();
  if (Object.hasOwn(MODEL_RATES, id)) return MODEL_RATES[id];
  if (id.includes('pro')) return MODEL_RATES['deepseek-v4-pro'];
  if (id.includes('flash') || id.includes('chat') || id.includes('reasoner')) {
    return MODEL_RATES['deepseek-flash'];
  }
  return undefined;
}

/**
 * Whether one instant falls inside DeepSeek's peak billing window.
 * @param {number} ms - epoch milliseconds of the model call.
 * @returns {boolean} true when peak rates apply.
 */
function isPeakAt(ms) {
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return false;
  const day = at.getUTCDay();
  if (PEAK_WEEKDAYS_ONLY && (day === 0 || day === 6)) return false;
  if (PEAK_HOLIDAYS.includes(at.toISOString().slice(0, 10))) return false;
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  return PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end);
}

/**
 * Provider usage of one durable Assistant settlement, falling back to the last
 * usage chunk embedded in its stream.
 * @param {object} event - the `assistant/message` session event.
 * @returns {object | undefined} the usage record.
 */
function usageOf(event) {
  const data = event.data;
  if (data === undefined || data === null) return undefined;
  if (data.usage !== undefined && data.usage !== null && typeof data.usage === 'object') {
    return data.usage;
  }
  const stream = data.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record === null || typeof record !== 'object') continue;
    if (record.type !== 'chunk') continue;
    const chunk = record.chunk;
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage') return chunk.usage;
  }
  return undefined;
}

/**
 * A finite, non-negative token count from a provider usage record.
 * @param {unknown} value - candidate count.
 * @returns {number} the count, or 0 when unreported or invalid.
 */
function tokens(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Reject values that cannot survive the projection checkpoint as plain JSON.
 * The registry stores unit state through a structured clone, so `NaN`, dates,
 * and class instances would corrupt every later read.
 * @param {unknown} value - candidate value.
 * @param {number} depth - recursion guard.
 * @returns {boolean} whether the value is plain JSON.
 */
function isPlainJson(value, depth = 0) {
  if (depth > 8) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isPlainJson(item, depth + 1));
  if (typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every((item) => isPlainJson(item, depth + 1));
}

/**
 * Parse-only schema used where the projection registry expects a zod schema.
 * A profile bundle has no schema-library dependency, and the registry only ever
 * calls `parse` on the state and wire schemas.
 * @param {string} label - name used in the thrown message.
 * @returns {{parse: (value: unknown) => unknown, safeParse: (value: unknown) => object}} the schema.
 */
function plainJsonSchema(label) {
  return {
    parse(value) {
      if (!isPlainJson(value)) throw new TypeError(`${label}: value is not plain JSON`);
      return value;
    },
    safeParse(value) {
      return isPlainJson(value)
        ? { success: true, data: value }
        : { success: false, error: new TypeError(`${label}: value is not plain JSON`) };
    },
  };
}

/** Client-visible projection value: cumulative spend plus the calendar the client needs. */
const WIRE_SCHEMA = plainJsonSchema('peakCost view');

/** Persisted fold state: the same totals plus the last priced model id. */
const STATE_SCHEMA = plainJsonSchema('peakCost state');

/**
 * The `peakCost` projection unit.
 *
 * One `assistant/message` with reported usage contributes one priced call. The
 * rate card follows the message's own model id and the billing window follows
 * the message's own timestamp, so replay produces the same total as the live
 * run and a session spanning peak and off-peak stays correct.
 */
const peakCostProjectionDefinition = {
  key: 'peakCost',
  stateVersion: 2,
  stateSchema: STATE_SCHEMA,
  init: () => ({
    costUsd: 0,
    missCostUsd: 0,
    hitCostUsd: 0,
    outCostUsd: 0,
    uncachedCostUsd: 0,
    messages: 0,
    inputTokens: 0,
    hitTokens: 0,
    writeTokens: 0,
    outputTokens: 0,
    peakMessages: 0,
    offPeakMessages: 0,
    unpricedMessages: 0,
    lastModel: '',
  }),
  apply: (state, event) => {
    if (event.type !== 'assistant/message') return state;
    const usage = usageOf(event);
    if (usage === undefined) return state;
    const message = event.data.message;
    const source = message === undefined || message === null ? undefined : message.source;
    const model = source !== undefined && source !== null && typeof source.model === 'string' ? source.model : '';
    const rate = rateFor(model);
    const peak = isPeakAt(event.time);
    const inputTokens = tokens(usage.inputTokens);
    const hitTokens = tokens(usage.cacheReadTokens);
    const writeTokens = tokens(usage.cacheWriteTokens);
    const outputTokens = tokens(usage.outputTokens);
    const factor = peak ? 1 : OFF_PEAK_FACTOR;
    const missCostUsd = rate === undefined ? 0 : ((inputTokens + writeTokens) * rate.miss) / 1e6 * factor;
    const hitCostUsd = rate === undefined ? 0 : (hitTokens * rate.hit) / 1e6 * factor;
    const outCostUsd = rate === undefined ? 0 : (outputTokens * rate.out) / 1e6 * factor;
    // The same prompt billed without prompt caching: every input token at the
    // cache-miss rate. Shown so the cache discount is visible, not assumed.
    const uncachedCostUsd = rate === undefined
      ? 0
      : ((inputTokens + writeTokens + hitTokens) * rate.miss) / 1e6 * factor;
    return {
      costUsd: state.costUsd + missCostUsd + hitCostUsd + outCostUsd,
      missCostUsd: state.missCostUsd + missCostUsd,
      hitCostUsd: state.hitCostUsd + hitCostUsd,
      outCostUsd: state.outCostUsd + outCostUsd,
      uncachedCostUsd: state.uncachedCostUsd + uncachedCostUsd,
      messages: state.messages + 1,
      inputTokens: state.inputTokens + inputTokens,
      hitTokens: state.hitTokens + hitTokens,
      writeTokens: state.writeTokens + writeTokens,
      outputTokens: state.outputTokens + outputTokens,
      peakMessages: state.peakMessages + (peak ? 1 : 0),
      offPeakMessages: state.offPeakMessages + (peak ? 0 : 1),
      unpricedMessages: state.unpricedMessages + (rate === undefined ? 1 : 0),
      lastModel: model.length > 0 ? model : state.lastModel,
    };
  },
  wire: {
    viewSchema: WIRE_SCHEMA,
    view: (state) => ({
      costUsd: state.costUsd,
      missCostUsd: state.missCostUsd,
      hitCostUsd: state.hitCostUsd,
      outCostUsd: state.outCostUsd,
      uncachedCostUsd: state.uncachedCostUsd,
      messages: state.messages,
      inputTokens: state.inputTokens,
      hitTokens: state.hitTokens,
      writeTokens: state.writeTokens,
      outputTokens: state.outputTokens,
      peakMessages: state.peakMessages,
      offPeakMessages: state.offPeakMessages,
      unpricedMessages: state.unpricedMessages,
      lastModel: state.lastModel,
      peakWindows: PEAK_WINDOWS,
      weekdaysOnly: PEAK_WEEKDAYS_ONLY,
      holidays: PEAK_HOLIDAYS,
    }),
  },
};

/** The projection registry is this plugin's whole purpose. */
export const inject = ['sessionProjections'];

/**
 * Register the `peakCost` unit; the registration is an effect on this plugin's
 * fiber, so unloading removes the key.
 * @param {object} ctx - registrant context carrying the projection registry.
 */
export function apply(ctx) {
  ctx.sessionProjections.register(peakCostProjectionDefinition);
}
