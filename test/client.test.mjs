import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The client half runs in the browser, so this suite supplies the two things it
 * needs from that world: the module loader and a React with hooks. It then
 * renders the dock entry against projection values shaped exactly like the Host
 * half's wire view.
 */

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect() {},
  useRef(value) {
    return { current: value };
  },
  memo(component) {
    return component;
  },
};

const requireStub = (name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
};

let loaded;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec;
    },
  },
  setInterval: () => 0,
  clearInterval: () => {},
};

await import('../client.js');

/** Collect every text node of a rendered element tree. */
function texts(node, into = []) {
  if (node === null || node === undefined) return into;
  if (Array.isArray(node)) {
    for (const child of node) texts(child, into);
    return into;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    into.push(String(node));
    return into;
  }
  if (typeof node === 'object' && 'children' in node) texts(node.children, into);
  return into;
}

/** Evaluate the entry component with a frozen clock. */
function render(component, value, nowIso) {
  const realNow = Date.now;
  Date.now = () => Date.parse(nowIso);
  try {
    return component({ useProjection: () => value });
  } finally {
    Date.now = realNow;
  }
}

const liveValue = {
  costUsd: 0.06312069000000001,
  missCostUsd: 0.01736145,
  hitCostUsd: 0.01768704,
  outCostUsd: 0.0280722,
  uncachedCostUsd: 0.90171345,
  messages: 62,
  inputTokens: 115743,
  hitTokens: 5895680,
  writeTokens: 0,
  outputTokens: 46787,
  peakMessages: 0,
  offPeakMessages: 62,
  unpricedMessages: 0,
  lastModel: 'deepseek-flash',
  peakWindows: [[60, 240], [360, 600]],
  weekdaysOnly: true,
  holidays: [],
};

let registration;
const dictionaries = [];
const ctx = {
  effect: (callback) => callback(),
  locale: {
    register(ns, dicts) {
      dictionaries.push({ ns, dicts });
      return () => {};
    },
    bind(ns) {
      const dict = dictionaries.find((entry) => entry.ns === ns)?.dicts.en ?? {};
      return (key) => dict[key] ?? key;
    },
  },
  slots: {
    inject(owner, callback) {
      registration = { owner };
      return callback();
    },
    register(options, component) {
      registration.options = options;
      registration.component = component;
      return () => {};
    },
  },
};

test('registers with the module loader under the package name', () => {
  assert.ok(loaded, 'client module registered');
  assert.equal(loaded.id, 'dsh-peak-cost');
});

test('registers one dock entry and both locale dictionaries', () => {
  const module = loaded.factory(requireStub);
  assert.deepEqual(module.inject, ['slots', 'locale']);
  module.apply(ctx);

  assert.equal(dictionaries.length, 1);
  assert.equal(dictionaries[0].ns, 'peak-cost');
  assert.ok(dictionaries[0].dicts.en['status.peak']);
  assert.ok(dictionaries[0].dicts.zh['status.peak']);

  assert.equal(registration.owner, 'conversation.composer.dock');
  assert.equal(registration.options.name, 'conversation.composer.dock');
  assert.equal(registration.options.id, 'peak-cost');
  assert.equal(registration.options.order, 2);
});

test('renders an approximate off-peak pill with the session amount', () => {
  const tree = render(registration.component, liveValue, '2026-10-23T19:51:00Z');
  const copy = texts(tree).join(' ');
  assert.match(copy, /Off-peak/);
  assert.match(copy, /≈ \$0\.063/);
  assert.doesNotMatch(copy, /Peak hours/);
  assert.equal(tree.props['aria-label'], 'DeepSeek billing: Off-peak. Estimated session spend $0.063.');
});

test('tooltip explains window, next change, spend and the cache discount', () => {
  const tree = render(registration.component, liveValue, '2026-10-23T19:51:00Z');
  const title = tree.props.title;
  assert.match(title, /DeepSeek billing window: Off-peak/);
  assert.match(title, /Changes to Peak hours in 2 d 5 h/);
  assert.match(title, /Estimated this session: \$0\.063 over 62 model calls/);
  assert.match(title, /Input 116k \(98\.1% cache hit\) · output 46\.8k/);
  assert.match(title, /Billed: input \$0\.017 \+ cache \$0\.018 \+ output \$0\.028/);
  assert.match(title, /without prompt caching would cost \$0\.902 at list price/);
  assert.match(title, /list-price equivalent, not a wallet reading/);
  assert.match(title, /Estimate from list prices/);
});

test('switches to peak inside a peak window', () => {
  const tree = render(registration.component, liveValue, '2026-10-23T02:30:00Z');
  assert.match(texts(tree).join(' '), /Peak hours/);
  assert.match(tree.props.title, /Changes to Off-peak in/);
  assert.equal(tree.props['aria-label'], 'DeepSeek billing: Peak hours. Estimated session spend $0.063.');
});

test('shows zero spend and the live window before the first model call', () => {
  const tree = render(registration.component, undefined, '2026-10-23T19:51:00Z');
  const copy = texts(tree).join(' ');
  assert.match(copy, /Off-peak/);
  assert.match(copy, /\$0\.00/);
  assert.match(tree.props.title, /DeepSeek billing window: Off-peak/);
});
