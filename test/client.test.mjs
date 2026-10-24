import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The client half runs in the browser, so this suite supplies the two things it
 * needs from that world: the module loader and a React with hooks. It then
 * renders the dock entry against projection values shaped exactly like the Host
 * half's wire view.
 */

const hookStores = new WeakMap();
let hookCursor = 0;
let currentComponent;

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() };
  },
  useState(initial) {
    const store = hookStores.get(currentComponent) ?? [];
    hookStores.set(currentComponent, store);
    const slot = hookCursor++;
    if (!(slot in store)) store[slot] = typeof initial === 'function' ? initial() : initial;
    return [store[slot], (next) => { store[slot] = next; }];
  },
  useEffect(effect) {
    effect();
  },
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
  setTimeout: (callback) => {
    callback();
    return 0;
  },
  clearTimeout: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  innerWidth: 1280,
  innerHeight: 800,
};

globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
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
  currentComponent = component;
  hookCursor = 0;
  try {
    return component({ useProjection: () => value });
  } finally {
    Date.now = realNow;
  }
}

/** Let the pending balance promise settle, then render again from stored hooks. */
async function settle(component, value, nowIso) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return render(component, value, nowIso);
}

/** Find the hover panel node in a rendered tree. */
function findPanel(node) {
  if (node === null || node === undefined) return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findPanel(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node !== 'object') return undefined;
  if (node.props !== undefined && node.props['data-testid'] === 'peak-cost-panel') return node;
  return findPanel(node.children);
}

/** Render, hover the line, render again, and return the open panel. */
function openPanel(component, value, nowIso) {
  const trigger = render(component, value, nowIso);
  assert.equal(typeof trigger.props.onMouseEnter, 'function');
  trigger.props.onMouseEnter();
  const next = render(component, value, nowIso);
  const panel = findPanel(next);
  assert.ok(panel !== undefined, 'panel renders after hover');
  return panel;
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
  breakdown: {
    schemas: { tokens: 8815, miss: 8815, hit: 0, usd: 0.0013, missUsd: 0.0013, hitUsd: 0 },
    system: { tokens: 1448, miss: 1448, hit: 0, usd: 0.0002, missUsd: 0.0002, hitUsd: 0 },
    user: { tokens: 4200, miss: 2000, hit: 2200, usd: 0.0031, missUsd: 0.0003, hitUsd: 0.0028 },
    web: { tokens: 18000, miss: 9000, hit: 9000, usd: 0.0124, missUsd: 0.0014, hitUsd: 0.011 },
    tools: { tokens: 40000, miss: 30000, hit: 10000, usd: 0.0261, missUsd: 0.0214, hitUsd: 0.0047 },
    assistant: { tokens: 12000, miss: 12000, hit: 0, usd: 0.0048, missUsd: 0.0048, hitUsd: 0 },
    reasoning: { tokens: 6000, miss: 6000, hit: 0, usd: 0.0024, missUsd: 0.0024, hitUsd: 0 },
  },
  peakWindows: [[60, 240], [360, 600]],
  weekdaysOnly: true,
  holidays: [],
};

const dictionaries = [];

/**
 * Build a client context with an optional account transport.
 * @param {object} [account] - `ctx.remote.account` stub.
 * @param {object} [options] - `injectAccount` simulates the scoped injection path.
 * @returns {{ctx: object, registration: object, dicts: object[]}} context, registration, dictionaries.
 */
function makeContext(account, options = {}) {
  const registration = {};
  const dicts = [];
  const ctx = {
    effect: (callback) => callback(),
    locale: {
      register(ns, dictsValue) {
        dicts.push({ ns, dicts: dictsValue });
        return () => {};
      },
      getSnapshot: () => ({ active: 'en' }),
      bind(ns) {
        const dict = (dicts.find((entry) => entry.ns === ns) ?? dictionaries[0])?.dicts.en ?? {};
        return (key) => dict[key] ?? key;
      },
    },
    slots: {
      inject(owner, callback) {
        registration.owner = owner;
        return callback();
      },
      register(optionsValue, component) {
        registration.options = optionsValue;
        registration.component = component;
        return () => {};
      },
    },
  };
  if (account !== undefined) ctx.remote = { account };
  if (options.injectAccount !== undefined) {
    const face = options.injectAccount;
    ctx.inject = (deps, callback) => {
      registration.injected = deps;
      return callback({ 'remote.account': face, remote: { account: face } });
    };
  }
  return { ctx, registration, dicts };
}

const base = makeContext();
const registration = base.registration;

/**
 * Build a dock component with its own hook store, optionally with an account.
 * @param {object} [account] - `ctx.remote.account` stub.
 * @returns {Function} the component.
 */
function freshComponent(account) {
  const made = makeContext(account);
  loaded.factory(requireStub).apply(made.ctx);
  return made.registration.component;
}

test('registers with the module loader under the package name', () => {
  assert.ok(loaded, 'client module registered');
  assert.equal(loaded.id, 'dsh-peak-cost');
});

test('registers one dock entry and both locale dictionaries', () => {
  const module = loaded.factory(requireStub);
  assert.deepEqual(module.inject, ['slots', 'locale']);
  module.apply(base.ctx);

  assert.equal(base.dicts.length, 1);
  assert.equal(base.dicts[0].ns, 'peak-cost');
  assert.ok(base.dicts[0].dicts.en['status.peak']);
  assert.ok(base.dicts[0].dicts.zh['status.peak']);

  assert.equal(registration.owner, 'conversation.composer.dock');
  assert.equal(registration.options.name, 'conversation.composer.dock');
  assert.equal(registration.options.id, 'peak-cost');
  assert.equal(registration.options.order, 2);
  assert.ok(module.test, 'pure helpers exposed for the suite');
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
  const tree = openPanel(registration.component, liveValue, '2026-10-23T19:51:00Z');
  const copy = texts(tree).join(' ');
  assert.match(copy, /Where the money went/);
  assert.match(copy, /Content/);
  assert.match(copy, /In context/);
  assert.match(copy, /First time/);
  assert.match(copy, /Re-sent/);
  assert.match(copy, /Web results/);
  assert.match(copy, /Tool results/);
  assert.match(copy, /Model thinking/);
  assert.match(copy, /Session total/);
  assert.match(copy, /Web results are billed once as input/);
  assert.match(copy, /The same prompts without caching: \$0\.902/);
  assert.match(copy, /62 model calls · 0 at peak, 62 off-peak/);
});

test('sorts attribution rows by cost and hides empty categories', () => {
  const { buildRows } = loaded.factory(requireStub).test;
  const dict = Object.fromEntries(Object.entries(base.dicts[0].dicts.en));
  const t = (key) => dict[key] ?? key;
  const rows = buildRows(liveValue, t);
  assert.deepEqual(rows.map((row) => row.key), ['tools', 'web', 'assistant', 'user', 'reasoning', 'schemas', 'system']);
  assert.equal(rows[0].label, 'Tool results');
  assert.ok(rows.every((row) => row.total > 0));
  assert.deepEqual(buildRows(undefined, t), []);
  const empty = buildRows({
    breakdown: { web: { tokens: 0, miss: 0, hit: 0, usd: 0, missUsd: 0, hitUsd: 0 } },
  }, t);
  assert.deepEqual(empty, []);
});

test('switches to peak inside a peak window', () => {
  const tree = render(freshComponent(), liveValue, '2026-10-23T02:30:00Z');
  assert.match(texts(tree).join(' '), /Peak hours/);
  assert.equal(tree.props['aria-label'], 'DeepSeek billing: Peak hours. Estimated session spend $0.063.');
});

test('shows zero spend and the live window before the first model call', () => {
  const tree = render(freshComponent(), undefined, '2026-10-23T19:51:00Z');
  const copy = texts(tree).join(' ');
  assert.match(copy, /Off-peak/);
  assert.match(copy, /\$0\.00/);
});

test('folds recharge and bonus wallets into one balance per currency', () => {
  const { summarizeBalance, formatMoney } = loaded.factory(requireStub).test;
  const summary = summarizeBalance({
    status: 'ready',
    value: [{ currency: 'CNY', balance: '6.98' }],
    bonusWallets: [{ currency: 'CNY', balance: '0.28' }],
  });
  assert.equal(summary.primary.currency, 'CNY');
  assert.equal(summary.primary.total, 7.26);
  assert.equal(summary.primary.recharge, 6.98);
  assert.equal(summary.primary.bonus, 0.28);
  assert.equal(formatMoney('CNY', summary.primary.total), '¥7.26');
  assert.equal(formatMoney('USD', 3.5), '$3.50');
});

test('reports no balance for a failed, absent or signed-out read', () => {
  const { summarizeBalance } = loaded.factory(requireStub).test;
  assert.equal(summarizeBalance(null), null);
  assert.equal(summarizeBalance({ status: 'failed' }), null);
  assert.equal(summarizeBalance({ status: 'ready', value: [], bonusWallets: [] }), null);
  assert.equal(summarizeBalance({ status: 'ready', value: [{ currency: 'USD', balance: 'oops' }] }), null);
});

test('renders the account balance beside the session cost', async () => {
  const withAccount = makeContext({
    getBalance: async () => ({
      ok: true,
      value: {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '6.98' }],
        bonusWallets: [{ currency: 'CNY', balance: '0.28' }],
      },
    }),
  });
  loaded.factory(requireStub).apply(withAccount.ctx);
  render(withAccount.registration.component, liveValue, '2026-10-23T19:51:00Z');
  const tree = await settle(withAccount.registration.component, liveValue, '2026-10-23T19:51:00Z');
  const copy = texts(tree).join(' ');
  assert.match(copy, /≈ \$0\.063/);
  assert.match(copy, /bal ¥7\.26/);
  const panel = openPanel(withAccount.registration.component, liveValue, '2026-10-23T19:51:00Z');
  const panelCopy = texts(panel).join(' ');
  assert.match(panelCopy, /Account balance ¥7\.26/);
  assert.match(panelCopy, /Recharge ¥6\.98 · bonus ¥0\.28/);
  assert.equal(
    tree.props['aria-label'],
    'DeepSeek billing: Off-peak. Estimated session spend $0.063. Account balance ¥7.26.',
  );
});

test('omits the balance when the account transport is missing or unauthorized', async () => {
  const signedOut = makeContext({
    getBalance: async () => ({ ok: true, value: null }),
  });
  loaded.factory(requireStub).apply(signedOut.ctx);
  render(signedOut.registration.component, liveValue, '2026-10-23T19:51:00Z');
  const tree = await settle(signedOut.registration.component, liveValue, '2026-10-23T19:51:00Z');
  assert.doesNotMatch(texts(tree).join(' '), /bal/);
  assert.equal(tree.props['aria-label'], 'DeepSeek billing: Off-peak. Estimated session spend $0.063.');

  const failing = makeContext({
    getBalance: async () => ({ ok: false, error: { code: 'account/unauthorized' } }),
  });
  loaded.factory(requireStub).apply(failing.ctx);
  render(failing.registration.component, liveValue, '2026-10-23T19:51:00Z');
  const failed = await settle(failing.registration.component, liveValue, '2026-10-23T19:51:00Z');
  assert.doesNotMatch(texts(failed).join(' '), /bal/);
});

test('finds the account through scoped injection when the root context has no remote', async () => {
  const injected = {
    getBalance: async () => ({
      ok: true,
      value: {
        status: 'ready',
        value: [{ currency: 'USD', balance: '7.26' }],
        bonusWallets: [],
      },
    }),
  };
  const made = makeContext(undefined, { injectAccount: injected });
  loaded.factory(requireStub).apply(made.ctx);
  assert.deepEqual(made.registration.injected, ['remote.account']);
  render(made.registration.component, liveValue, '2026-10-23T19:51:00Z');
  const tree = await settle(made.registration.component, liveValue, '2026-10-23T19:51:00Z');
  const copy = texts(tree).join(' ');
  assert.match(copy, /bal \$7\.26/);
  const panel = openPanel(made.registration.component, liveValue, '2026-10-23T19:51:00Z');
  const panelCopy = texts(panel).join(' ');
  assert.match(panelCopy, /Account balance \$7\.26/);
  assert.match(panelCopy, /Recharge \$7\.26 · bonus \$0\.00/);
});

test('shows both wallets even when the bonus is empty', async () => {
  const made = makeContext({
    getBalance: async () => ({
      ok: true,
      value: {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '12.40' }],
        bonusWallets: [{ currency: 'CNY', balance: '0.00' }],
      },
    }),
  });
  loaded.factory(requireStub).apply(made.ctx);
  render(made.registration.component, liveValue, '2026-10-23T19:51:00Z');
  const tree = await settle(made.registration.component, liveValue, '2026-10-23T19:51:00Z');
  assert.match(texts(tree).join(' '), /bal ¥12\.40/);
  const panel = openPanel(made.registration.component, liveValue, '2026-10-23T19:51:00Z');
  const panelCopy = texts(panel).join(' ');
  assert.match(panelCopy, /Account balance ¥12\.40/);
  assert.match(panelCopy, /Recharge ¥12\.40 · bonus ¥0\.00/);
});
