/**
 * Host half of `dsh-peak-cost` — https://github.com/ogidimitrov/dsh-peak-cost
 *
 * Folds the durable session log into an estimated USD spend for one Session and
 * publishes it as the client-visible `peakCost` session projection, so the Web
 * client renders numbers computed from the whole log instead of re-folding
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
 *
 * ## Cost attribution
 *
 * The projection also answers "where did the money go". Every model call reports
 * real billed usage: cache-miss input, cache-hit input, output. The fold keeps a
 * running, per-category estimate of the context (web results, tool results, user
 * turns, assistant text, reasoning, system prompt, tool schemas) and splits each
 * call's billed prompt between those categories:
 *
 *   - cache-miss tokens go to the content added since the previous call
 *     (a search result is billed as input exactly once, when it first lands);
 *   - cache-hit tokens go to everything already in context, proportional to size
 *     (the same search result is billed as cache on every later call).
 *
 * The shares come from a four-characters-per-token estimate, but the per-call
 * totals are the provider's own numbers, so the category costs add up to the
 * real bill and only their split is approximate.
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

/** Context categories the billed prompt is split across, in display order. */
const CATEGORIES = ['schemas', 'system', 'user', 'web', 'tools', 'assistant', 'reasoning'];

/** Tool names whose results count as web data. */
const WEB_TOOLS = new Set(['web_search', 'web_fetch']);

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
 * Fixed heuristic price of one string: four characters per token.
 * @param {unknown} text - candidate text.
 * @returns {number} estimated tokens.
 */
function estimateText(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Fixed heuristic price of one content-block list, with per-block overhead.
 * @param {unknown} blocks - message content blocks.
 * @returns {number} estimated tokens.
 */
function estimateBlocks(blocks) {
  if (!Array.isArray(blocks)) return 0;
  let total = 0;
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
      case 'reasoning':
        total += 4 + estimateText(block.text);
        break;
      case 'tool-call':
        total += 10 + estimateText(block.name) + estimateText(block.arguments);
        break;
      case 'tool-addition':
      case 'tool-removal':
        total += 10 + estimateText(block.toolName);
        break;
      case 'image':
        total += 800;
        break;
      case 'file':
        total += 40;
        break;
      default:
        total += 8;
    }
  }
  return total;
}

/**
 * Split one surface event into `[category, tokens]` parts.
 * @param {object} event - session event.
 * @param {Record<string, string>} toolNames - callId to tool name.
 * @returns {Array<[string, number]>} parts, possibly empty.
 */
function partsOf(event, toolNames) {
  const data = event.data;
  if (data === undefined || data === null) return [];
  switch (event.type) {
    case 'user/message':
      return [['user', estimateBlocks(data.content)]];
    case 'system/message':
    case 'developer/message': {
      const message = data.message ?? data;
      return [['system', estimateBlocks(message.content)]];
    }
    case 'tool/result': {
      const message = data.message;
      if (message === undefined || message === null) return [];
      const callId = message.source?.callId;
      const name = typeof callId === 'string' ? toolNames[callId] : undefined;
      return [[WEB_TOOLS.has(name) ? 'web' : 'tools', estimateBlocks(message.content)]];
    }
    case 'assistant/message': {
      const message = data.message;
      if (message === undefined || message === null) return [];
      let reasoning = 0;
      let rest = 0;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block !== null && typeof block === 'object' && block.type === 'reasoning') {
          reasoning += 4 + estimateText(block.text);
        } else {
          rest += estimateBlocks([block]);
        }
      }
      const parts = [];
      if (rest > 0) parts.push(['assistant', rest]);
      if (reasoning > 0) parts.push(['reasoning', reasoning]);
      return parts;
    }
    default:
      return [];
  }
}

/** A zeroed per-category breakdown. @returns {object} the breakdown. */
function blankBreakdown() {
  return Object.fromEntries(CATEGORIES.map((category) => [category, {
    tokens: 0, miss: 0, hit: 0, usd: 0, missUsd: 0, hitUsd: 0,
  }]));
}

/** A zeroed pending-arrivals map. @returns {object} the map. */
function blankPending() {
  return Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
}

/** Deep-copy the breakdown so an update can mutate it. @param {object} source - breakdown. @returns {object} the copy. */
function copyBreakdown(source) {
  return Object.fromEntries(CATEGORIES.map((category) => [category, { ...source[category] }]));
}

/**
 * Reject values that cannot survive the projection checkpoint as plain JSON.
 * @param {unknown} value - candidate value.
 * @param {number} depth - recursion guard.
 * @returns {boolean} whether the value is plain JSON.
 */
function isPlainJson(value, depth = 0) {
  if (depth > 10) return false;
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

/** Client-visible projection value. */
const WIRE_SCHEMA = plainJsonSchema('peakCost view');

/** Persisted fold state. */
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
  stateVersion: 3,
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
    breakdown: blankBreakdown(),
    pending: blankPending(),
    nodes: {},
    toolNames: {},
    schemasTokens: 0,
  }),
  apply: (state, event) => {
    const surface = event.surfaceOp !== undefined && event.surfaceOp !== null;
    const priced = event.type === 'assistant/message' && usageOf(event) !== undefined;
    if (!surface && !priced && event.type !== 'tool/call' && event.type !== 'request/header') {
      return state;
    }

    const next = {
      ...state,
      breakdown: copyBreakdown(state.breakdown),
      pending: { ...state.pending },
      nodes: surface || priced ? { ...state.nodes } : state.nodes,
      toolNames: { ...state.toolNames },
    };

    // 1. Price this call against the context as it stood before its own reply.
    if (priced) {
      const usage = usageOf(event);
      const message = event.data.message;
      const source = message === undefined || message === null ? undefined : message.source;
      const model = source !== undefined && source !== null && typeof source.model === 'string' ? source.model : '';
      const rate = rateFor(model);
      const peak = isPeakAt(event.time);
      const factor = peak ? 1 : OFF_PEAK_FACTOR;
      const inputTokens = tokens(usage.inputTokens);
      const writeTokens = tokens(usage.cacheWriteTokens);
      const hitTokens = tokens(usage.cacheReadTokens);
      const outputTokens = tokens(usage.outputTokens);
      const missTokens = inputTokens + writeTokens;

      const missCostUsd = rate === undefined ? 0 : missTokens * rate.miss / 1e6 * factor;
      const hitCostUsd = rate === undefined ? 0 : hitTokens * rate.hit / 1e6 * factor;
      const outCostUsd = rate === undefined ? 0 : outputTokens * rate.out / 1e6 * factor;
      const uncachedCostUsd = rate === undefined
        ? 0
        : (missTokens + hitTokens) * rate.miss / 1e6 * factor;

      next.costUsd = state.costUsd + missCostUsd + hitCostUsd + outCostUsd;
      next.missCostUsd = state.missCostUsd + missCostUsd;
      next.hitCostUsd = state.hitCostUsd + hitCostUsd;
      next.outCostUsd = state.outCostUsd + outCostUsd;
      next.uncachedCostUsd = state.uncachedCostUsd + uncachedCostUsd;
      next.messages = state.messages + 1;
      next.inputTokens = state.inputTokens + inputTokens;
      next.hitTokens = state.hitTokens + hitTokens;
      next.writeTokens = state.writeTokens + writeTokens;
      next.outputTokens = state.outputTokens + outputTokens;
      next.peakMessages = state.peakMessages + (peak ? 1 : 0);
      next.offPeakMessages = state.offPeakMessages + (peak ? 0 : 1);
      next.unpricedMessages = state.unpricedMessages + (rate === undefined ? 1 : 0);
      next.lastModel = model.length > 0 ? model : state.lastModel;

      // Split the billed prompt across content categories.
      let pendingTotal = 0;
      let contextTotal = 0;
      for (const category of CATEGORIES) {
        pendingTotal += Math.max(0, state.pending[category]);
        contextTotal += Math.max(0, state.breakdown[category].tokens);
      }
      for (const category of CATEGORIES) {
        const entry = next.breakdown[category];
        const shareMiss = pendingTotal > 0
          ? Math.max(0, state.pending[category]) / pendingTotal
          : (contextTotal > 0 ? Math.max(0, entry.tokens) / contextTotal : 0);
        const shareHit = contextTotal > 0 ? Math.max(0, entry.tokens) / contextTotal : 0;
        const categoryMiss = missTokens * shareMiss;
        const categoryHit = hitTokens * shareHit;
        entry.miss += categoryMiss;
        entry.hit += categoryHit;
        if (rate !== undefined) {
          const categoryMissUsd = categoryMiss * rate.miss / 1e6 * factor;
          const categoryHitUsd = categoryHit * rate.hit / 1e6 * factor;
          entry.missUsd += categoryMissUsd;
          entry.hitUsd += categoryHitUsd;
          entry.usd += categoryMissUsd + categoryHitUsd;
        }
      }
      next.pending = blankPending();
    }

    // 2. Apply a surface replacement before adding the new node.
    if (surface && event.surfaceOp !== null && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
      const { startSeq, endSeq } = event.surfaceOp;
      if (Number.isSafeInteger(startSeq) && Number.isSafeInteger(endSeq)) {
        for (let seq = startSeq; seq <= endSeq; seq += 1) {
          const parts = next.nodes[seq];
          if (parts === undefined) continue;
          for (const [category, value] of parts) {
            next.breakdown[category].tokens = Math.max(0, next.breakdown[category].tokens - value);
          }
          delete next.nodes[seq];
        }
      }
    }

    // 3. Record this event's own content for the calls that follow it.
    if (surface) {
      const parts = partsOf(event, state.toolNames).filter(([, value]) => value > 0);
      if (parts.length > 0) {
        next.nodes[event.seq] = parts;
        for (const [category, value] of parts) {
          next.breakdown[category].tokens += value;
          next.pending[category] += value;
        }
      }
    }

    // 4. Tool schemas are part of every prompt but never a surface node.
    if (event.type === 'request/header') {
      const tools = event.data?.header?.tools;
      let estimated = 0;
      if (Array.isArray(tools)) {
        for (const tool of tools) estimated += estimateText(tool?.name) + estimateText(tool?.description) + estimateText(JSON.stringify(tool?.parameters ?? {})) + 12;
      }
      const delta = estimated - state.schemasTokens;
      if (delta !== 0) {
        next.schemasTokens = estimated;
        next.breakdown.schemas.tokens = Math.max(0, next.breakdown.schemas.tokens + delta);
        if (delta > 0) next.pending.schemas += delta;
      }
    }

    // 5. Remember which tool produced a pending result.
    if (event.type === 'tool/call') {
      const callId = event.data?.callId;
      if (typeof callId === 'string') next.toolNames[callId] = event.data.name;
    }
    if (event.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId;
      if (typeof callId === 'string') delete next.toolNames[callId];
    }

    return next;
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
      breakdown: state.breakdown,
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
