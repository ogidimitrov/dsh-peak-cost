import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../index.js';

let definition;
apply({ sessionProjections: { register: (def) => { definition = def; } } });

const state0 = definition.init();
const million = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 };

const message = (timeIso, model, usage, extra = {}) => ({
  type: 'assistant/message',
  seq: 1,
  time: Date.parse(timeIso),
  data: {
    turn: 1,
    step: 1,
    message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model } },
    stream: [],
    ...(usage === undefined ? {} : { usage }),
    ...extra,
  },
});

test('registers one peakCost projection unit', () => {
  assert.equal(definition.key, 'peakCost');
  assert.equal(typeof definition.apply, 'function');
  assert.equal(typeof definition.wire.view, 'function');
});

test('prices cache-miss input at the peak rate inside 01:00-04:00 UTC', () => {
  const state = definition.apply(state0, message('2026-10-23T03:00:00Z', 'deepseek-flash', million));
  assert.equal(state.costUsd, 0.3);
  assert.equal(state.peakMessages, 1);
  assert.equal(state.offPeakMessages, 0);
});

test('halves the price outside peak hours', () => {
  const state = definition.apply(state0, message('2026-10-23T12:00:00Z', 'deepseek-flash', million));
  assert.equal(state.costUsd, 0.15);
  assert.equal(state.offPeakMessages, 1);
});

test('treats weekends as fully off-peak', () => {
  const state = definition.apply(state0, message('2026-10-24T03:00:00Z', 'deepseek-flash', million));
  assert.equal(state.costUsd, 0.15);
});

test('applies the exact window edges', () => {
  const cases = [
    ['2026-10-23T00:59:00Z', 'off'],
    ['2026-10-23T01:00:00Z', 'peak'],
    ['2026-10-23T03:59:00Z', 'peak'],
    ['2026-10-23T04:00:00Z', 'off'],
    ['2026-10-23T05:59:00Z', 'off'],
    ['2026-10-23T06:00:00Z', 'peak'],
    ['2026-10-23T09:59:00Z', 'peak'],
    ['2026-10-23T10:00:00Z', 'off'],
  ];
  for (const [iso, expected] of cases) {
    const state = definition.apply(state0, message(iso, 'deepseek-flash', million));
    assert.equal(state.peakMessages === 1 ? 'peak' : 'off', expected, iso);
  }
});

test('prices cache-hit input, cache-miss input and output separately', () => {
  const state = definition.apply(state0, message('2026-10-23T12:00:00Z', 'deepseek-flash', {
    inputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    outputTokens: 1_000_000,
  }));
  assert.equal(state.costUsd, 0.15 + 0.003 + 0.6);
  assert.equal(state.missCostUsd, 0.15);
  assert.equal(state.hitCostUsd, 0.003);
  assert.equal(state.outCostUsd, 0.6);
  assert.equal(state.uncachedCostUsd, 0.3);
  assert.equal(state.inputTokens, 1_000_000);
  assert.equal(state.hitTokens, 1_000_000);
  assert.equal(state.outputTokens, 1_000_000);
});

test('reports what the same prompt would cost without prompt caching', () => {
  const cached = definition.apply(state0, message('2026-10-23T12:00:00Z', 'deepseek-flash', {
    inputTokens: 1_000,
    cacheReadTokens: 9_999_000,
    outputTokens: 0,
  }));
  assert.equal(cached.costUsd, (1_000 * 0.15 + 9_999_000 * 0.003) / 1e6);
  assert.equal(cached.uncachedCostUsd, (10_000_000 * 0.15) / 1e6);
  assert.ok(cached.costUsd < cached.uncachedCostUsd / 10);
});

test('uses the pro rate card for pro routes and flash for legacy aliases', () => {
  const pro = definition.apply(state0, message('2026-10-23T12:00:00Z', 'deepseek-v4-pro', million));
  assert.equal(pro.costUsd, 0.66);
  const legacy = definition.apply(state0, message('2026-10-23T12:00:00Z', 'deepseek-v4-flash', million));
  assert.equal(legacy.costUsd, 0.15);
});

test('counts unknown routes without pricing them', () => {
  const state = definition.apply(state0, message('2026-10-23T12:00:00Z', 'some-other-model', million));
  assert.equal(state.costUsd, 0);
  assert.equal(state.unpricedMessages, 1);
  assert.equal(state.messages, 1);
});

test('falls back to the usage chunk embedded in the stream', () => {
  const state = definition.apply(state0, message('2026-10-23T12:00:00Z', 'deepseek-flash', undefined, {
    stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: million } }],
  }));
  assert.equal(state.costUsd, 0.15);
});

test('returns the same state reference for irrelevant events', () => {
  assert.equal(
    definition.apply(state0, { type: 'turn/end', seq: 2, time: 0, data: { turn: 1, reason: { kind: 'completed' } } }),
    state0,
  );
  assert.equal(
    definition.apply(state0, message('2026-10-23T12:00:00Z', 'deepseek-flash', undefined)),
    state0,
  );
});

test('publishes a plain-JSON wire view carrying the billing calendar', () => {
  const state = definition.apply(state0, message('2026-10-23T12:00:00Z', 'deepseek-flash', million));
  const view = definition.wire.view(state);
  assert.equal(definition.wire.viewSchema.parse(view), view);
  assert.deepEqual(view.peakWindows, [[60, 240], [360, 600]]);
  assert.equal(view.weekdaysOnly, true);
  assert.deepEqual(view.holidays, []);
  assert.equal(view.costUsd, 0.15);
  assert.equal(view.lastModel, 'deepseek-flash');
});

test('rejects values that would corrupt a projection checkpoint', () => {
  assert.throws(() => definition.wire.viewSchema.parse({ costUsd: Number.NaN }));
  assert.throws(() => definition.wire.viewSchema.parse({ when: new Date() }));
  assert.equal(definition.stateSchema.safeParse(definition.init()).success, true);
  assert.throws(() => definition.stateSchema.parse({ ...definition.init(), costUsd: Infinity }));
});

// --- cost attribution --------------------------------------------------------

const OFF_PEAK = Date.parse('2026-10-23T12:00:00Z');
const text = (length) => 'x'.repeat(length);

const surface = (type, seq, data, op = 'append') => ({
  type,
  seq,
  time: OFF_PEAK,
  data,
  surfaceOp: op,
});

const systemEvent = (seq, chars) => surface('system/message', seq, {
  turn: 1,
  step: 1,
  message: { role: 'system', content: [{ type: 'text', text: text(chars) }] },
});

const userEvent = (seq, chars) => surface('user/message', seq, {
  role: 'user',
  content: [{ type: 'text', text: text(chars) }],
});

const toolResultEvent = (seq, callId, chars) => surface('tool/result', seq, {
  turn: 1,
  step: 2,
  message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text: text(chars) }] },
});

const replyEvent = (seq, usage) => surface('assistant/message', seq, {
  turn: 1,
  step: 1,
  message: {
    role: 'assistant',
    source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' },
    content: [{ type: 'text', text: text(40) }],
  },
  stream: [],
  usage,
});

test('bills new content as cache-miss input on its first call', () => {
  let state = definition.apply(state0, systemEvent(1, 400));   // 4 + 100 tokens
  state = definition.apply(state, userEvent(2, 400));           // 4 + 100 tokens
  state = definition.apply(state, replyEvent(3, { inputTokens: 1000, outputTokens: 0 }));

  assert.ok(Math.abs(state.breakdown.system.miss - 500) < 0.5, `system miss ${state.breakdown.system.miss}`);
  assert.ok(Math.abs(state.breakdown.user.miss - 500) < 0.5, `user miss ${state.breakdown.user.miss}`);
  assert.equal(state.breakdown.system.hit, 0);
  assert.equal(state.breakdown.system.tokens, 104);
});

test('bills a search result once as input, then as cache on later calls', () => {
  let state = definition.apply(state0, systemEvent(1, 400));
  state = definition.apply(state, userEvent(2, 400));
  state = definition.apply(state, replyEvent(3, { inputTokens: 1000, outputTokens: 0 }));
  state = definition.apply(state, {
    type: 'tool/call', seq: 4, time: OFF_PEAK, data: { turn: 1, step: 2, callId: 'c1', name: 'web_search', arguments: '{}' },
  });
  state = definition.apply(state, toolResultEvent(5, 'c1', 8000)); // 4 + 2000 tokens
  state = definition.apply(state, replyEvent(6, { inputTokens: 500, cacheReadTokens: 2000, outputTokens: 0 }));

  const web = state.breakdown.web;
  assert.equal(web.tokens, 2004);
  assert.ok(Math.abs(web.miss - 500 * 2004 / 2018) < 0.5, `web miss ${web.miss}`);
  assert.ok(web.hit > 1790 && web.hit < 1810, `web hit ${web.hit}`);
  assert.ok(web.usd > 0);
  // The whole call's hit tokens are distributed, never multiplied.
  const hit = Object.values(state.breakdown).reduce((total, entry) => total + entry.hit, 0);
  const miss = Object.values(state.breakdown).reduce((total, entry) => total + entry.miss, 0);
  assert.ok(Math.abs(hit - 2000) < 0.5, `hit sum ${hit}`);
  assert.ok(Math.abs(miss - 1500) < 0.5, `miss sum ${miss}`);
});

test('subtracts replaced content from the context before pricing the next call', () => {
  let state = definition.apply(state0, systemEvent(1, 400));
  state = definition.apply(state, userEvent(2, 400));
  state = definition.apply(state, replyEvent(3, { inputTokens: 1000, outputTokens: 0 }));
  assert.equal(state.breakdown.user.tokens, 104);
  assert.equal(state.breakdown.system.tokens, 104);

  state = definition.apply(state, {
    type: 'user/message',
    seq: 7,
    time: OFF_PEAK,
    data: { role: 'user', content: [{ type: 'text', text: text(80) }] },
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
  });
  assert.equal(state.breakdown.system.tokens, 0);
  assert.equal(state.breakdown.user.tokens, 24);
});

test('prices every category at the rate card of the call that sent it', () => {
  let state = definition.apply(state0, systemEvent(1, 400));
  state = definition.apply(state, replyEvent(2, { inputTokens: 1000, outputTokens: 0 }));
  // 1000 miss tokens at $0.30/M, off-peak half price.
  assert.ok(Math.abs(state.missCostUsd - 1000 * 0.3 / 1e6 * 0.5) < 1e-12);
  const systemUsd = state.breakdown.system.usd;
  assert.ok(Math.abs(systemUsd - state.missCostUsd) < 1e-12, 'the only category carries the whole miss');
});
