/**
 * Client half of `dsh-peak-cost` — https://github.com/ogidimitrov/dsh-peak-cost
 *
 * Renders one ambient entry below the composer card:
 *
 *     ● Off-peak · ≈ $0.338 · bal $7.27
 *
 * Hovering it opens a themed panel with the cost attribution: where the money
 * went, split by content category, and for each one what it cost the first time
 * it entered the context (cache-miss input) versus every later call that re-sent
 * it (cache-hit input). The Host half owns the numbers; this half only renders.
 */
window.__ModuleLoader__.load({
  id: 'dsh-peak-cost',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'peak-cost';

    /** Fallback calendar for a Session whose projection has no messages yet. */
    const DEFAULT_WINDOWS = [[60, 240], [360, 600]];

    /** Display order fallback; the panel sorts by cost anyway. */
    const CATEGORY_ORDER = ['web', 'tools', 'user', 'assistant', 'reasoning', 'system', 'schemas'];

    const LOCALES = {
      en: {
        'status.peak': 'Peak hours',
        'status.offPeak': 'Off-peak',
        'aria': 'DeepSeek billing: {status}. Estimated session spend {amount}.',
        'aria.withBalance': 'DeepSeek billing: {status}. Estimated session spend {amount}. Account balance {balance}.',
        'balance.short': 'bal',
        'panel.calls': '{calls} model calls · {peak} at peak, {off} off-peak',
        'panel.next': 'Next: {status} in {gap}',
        'panel.balance': 'Account balance {balance}',
        'panel.balanceParts': 'Recharge {recharge} · bonus {bonus}',
        'panel.where': 'Where the money went',
        'panel.col.category': 'Content',
        'panel.col.tokens': 'In context',
        'panel.col.first': 'First time',
        'panel.col.cached': 'Re-sent',
        'panel.output': 'Model output',
        'panel.total': 'Session total',
        'panel.empty': 'No priced model call yet.',
        'cat.web': 'Web results',
        'cat.tools': 'Tool results',
        'cat.user': 'Your messages',
        'cat.assistant': 'Assistant replies',
        'cat.reasoning': 'Model thinking',
        'cat.system': 'System prompt',
        'cat.schemas': 'Tool schemas',
        'gap.minutes': '{n} min',
        'gap.hours': '{n} h {m} min',
        'gap.days': '{n} d {h} h',
      },
      zh: {
        'status.peak': '高峰时段',
        'status.offPeak': '非高峰时段',
        'aria': 'DeepSeek 计费：{status}。本会话预估花费 {amount}。',
        'aria.withBalance': 'DeepSeek 计费：{status}。本会话预估花费 {amount}。账户余额 {balance}。',
        'balance.short': '余额',
        'panel.calls': '{calls} 次模型调用 · 高峰 {peak} 次，非高峰 {off} 次',
        'panel.next': '下一次切换：{gap}后{status}',
        'panel.balance': '账户余额 {balance}',
        'panel.balanceParts': '充值 {recharge} · 赠送 {bonus}',
        'panel.where': '花费去向',
        'panel.col.category': '内容',
        'panel.col.tokens': '上下文',
        'panel.col.first': '首次',
        'panel.col.cached': '重复',
        'panel.output': '模型输出',
        'panel.total': '会话合计',
        'panel.empty': '还没有计费的模型调用。',
        'cat.web': '网页结果',
        'cat.tools': '工具结果',
        'cat.user': '你的消息',
        'cat.assistant': '助手回复',
        'cat.reasoning': '模型思考',
        'cat.system': '系统提示',
        'cat.schemas': '工具定义',
        'gap.minutes': '{n} 分钟',
        'gap.hours': '{n} 小时 {m} 分',
        'gap.days': '{n} 天 {h} 小时',
      },
    };

    /**
     * Fill `{name}` placeholders in one dictionary string.
     * @param {string} template - dictionary text.
     * @param {Record<string, string | number>} params - replacement values.
     * @returns {string} the rendered text.
     */
    function format(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        params !== undefined && Object.hasOwn(params, key) ? String(params[key]) : match
      ));
    }

    /**
     * Build one translate function over a dictionary with `format` fallback.
     * @param {(key: string) => string} base - the locale service binding.
     * @param {Record<string, string>} dict - this module's fallback dictionary.
     * @returns {(key: string, params?: Record<string, string | number>) => string} translate.
     */
    function translate(base, dict) {
      return (key, params) => {
        const text = base(key);
        const source = text === key && Object.hasOwn(dict, key) ? dict[key] : text;
        return format(source, params);
      };
    }

    /**
     * Whether one instant falls inside DeepSeek's peak billing window.
     * @param {number} ms - epoch milliseconds.
     * @param {number[][]} windows - [start, end) minute ranges of the UTC day.
     * @param {boolean} weekdaysOnly - whether weekends are fully off-peak.
     * @param {string[]} holidays - UTC `YYYY-MM-DD` dates that are fully off-peak.
     * @returns {boolean} true when peak rates apply.
     */
    function isPeakAt(ms, windows, weekdaysOnly, holidays) {
      const at = new Date(ms);
      if (Number.isNaN(at.getTime())) return false;
      if (weekdaysOnly) {
        const day = at.getUTCDay();
        if (day === 0 || day === 6) return false;
      }
      if (Array.isArray(holidays) && holidays.includes(at.toISOString().slice(0, 10))) return false;
      const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
      const ranges = Array.isArray(windows) && windows.length > 0 ? windows : DEFAULT_WINDOWS;
      return ranges.some(([start, end]) => minutes >= start && minutes < end);
    }

    /**
     * First instant after `from` whose peak status differs, scanning one minute
     * at a time; peak boundaries are minute-aligned, so this is exact.
     * @param {number} from - epoch milliseconds.
     * @param {number[][]} windows - peak minute ranges.
     * @param {boolean} weekdaysOnly - weekend rule.
     * @param {string[]} holidays - holiday dates.
     * @returns {number | undefined} epoch milliseconds of the next flip.
     */
    function nextFlip(from, windows, weekdaysOnly, holidays) {
      const current = isPeakAt(from, windows, weekdaysOnly, holidays);
      const limit = from + 3 * 24 * 60 * 60 * 1000;
      for (let at = from + 60 * 1000; at <= limit; at += 60 * 1000) {
        if (isPeakAt(at, windows, weekdaysOnly, holidays) !== current) return at;
      }
      return undefined;
    }

    /**
     * Compact token count using k/M suffixes, matching host formatting.
     * @param {number} value - token count.
     * @returns {string} the label.
     */
    function formatTokens(value) {
      if (!Number.isFinite(value) || value <= 0) return '0';
      const scaled = (candidate) => (candidate >= 100
        ? String(Math.round(candidate))
        : String(Math.round(candidate * 10) / 10));
      if (value >= 1e6) return `${scaled(value / 1e6)}M`;
      if (value >= 1e3) return `${scaled(value / 1e3)}k`;
      return String(Math.round(value));
    }

    /**
     * US dollar label with enough precision to stay readable for tiny sessions.
     * @param {number} value - USD amount.
     * @returns {string} the label.
     */
    function formatUsd(value) {
      if (!Number.isFinite(value) || value <= 0) return '$0.00';
      if (value < 0.01) return `$${value.toFixed(4)}`;
      if (value < 1) return `$${value.toFixed(3)}`;
      return `$${value.toFixed(2)}`;
    }

    /**
     * Money label for one wallet currency.
     * @param {'CNY' | 'USD'} currency - wallet currency.
     * @param {number} amount - wallet amount.
     * @returns {string} the label.
     */
    function formatMoney(currency, amount) {
      const symbol = currency === 'CNY' ? '¥' : '$';
      const digits = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(amount);
      return `${symbol}${digits}`;
    }

    /**
     * Fold the account balance response into displayable totals.
     *
     * The platform reports recharge and bonus wallets separately; DeepSeek spends
     * bonus credit first, so the number a person watches is the sum of both.
     * @param {object | null | undefined} value - `AccountDetails['balance']`.
     * @returns {{primary: {currency: string, total: number, recharge: number, bonus: number}, all: object[]} | null} totals.
     */
    function summarizeBalance(value) {
      if (value === null || value === undefined || value.status !== 'ready') return null;
      const totals = new Map();
      const add = (list, kind) => {
        for (const wallet of list ?? []) {
          const amount = Number.parseFloat(wallet.balance);
          if (!Number.isFinite(amount)) continue;
          const entry = totals.get(wallet.currency) ?? { currency: wallet.currency, total: 0, recharge: 0, bonus: 0 };
          entry[kind] += amount;
          entry.total += amount;
          totals.set(wallet.currency, entry);
        }
      };
      add(value.value, 'recharge');
      add(value.bonusWallets, 'bonus');
      const all = [...totals.values()].map((entry) => ({
        ...entry,
        total: roundMoney(entry.total),
        recharge: roundMoney(entry.recharge),
        bonus: roundMoney(entry.bonus),
      })).sort((left, right) => right.total - left.total);
      return all.length === 0 ? null : { primary: all[0], all };
    }

    /**
     * Strip binary floating-point noise from a wallet sum.
     * @param {number} value - summed amount.
     * @returns {number} the amount rounded to six decimals.
     */
    function roundMoney(value) {
      return Math.round(value * 1e6) / 1e6;
    }

    /**
     * The metadata every account Remote method carries. The version is the
     * running Harness release, read from the boot payload rather than guessed.
     * @param {object} ctx - client context carrying the locale service.
     * @returns {{version: string, locale: string, timezoneOffsetSeconds: number}} metadata.
     */
    function clientMetadata(ctx) {
      let version = 'dsh-peak-cost';
      try {
        const boot = globalThis.__DSH_BOOT__;
        if (boot && boot.release && typeof boot.release.version === 'string' && boot.release.version !== '') {
          version = boot.release.version;
        }
      } catch {
        // keep the fallback
      }
      let locale = 'en';
      try {
        locale = ctx.locale.getSnapshot().active;
      } catch {
        // keep the fallback
      }
      return {
        version,
        locale,
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      };
    }

    /**
     * Human gap label for the next billing-window change.
     * @param {number} ms - milliseconds remaining.
     * @param {(key: string, params?: object) => string} t - translate.
     * @returns {string} the label.
     */
    function formatGap(ms, t) {
      const minutes = Math.max(1, Math.round(ms / 60000));
      if (minutes < 60) return t('gap.minutes', { n: minutes });
      if (minutes < 24 * 60) {
        return t('gap.hours', { n: Math.floor(minutes / 60), m: minutes % 60 });
      }
      return t('gap.days', { n: Math.floor(minutes / (24 * 60)), h: Math.floor((minutes % (24 * 60)) / 60) });
    }

    /**
     * Repaint clock for the status label.
     * @param {number} intervalMs - tick period.
     * @returns {number} current epoch milliseconds.
     */
    function useClock(intervalMs) {
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        const id = window.setInterval(() => setNow(Date.now()), intervalMs);
        return () => window.clearInterval(id);
      }, [intervalMs]);
      return now;
    }

    /**
     * Build the per-category rows the panel shows, largest cost first.
     * @param {object | undefined} usage - the `peakCost` projection value.
     * @param {(key: string, params?: object) => string} t - translate.
     * @returns {Array<{key: string, label: string, tokens: number, first: number, cached: number, total: number}>} rows.
     */
    function buildRows(usage, t) {
      const breakdown = usage === undefined || usage === null ? undefined : usage.breakdown;
      if (breakdown === undefined || breakdown === null) return [];
      const rows = [];
      for (const key of CATEGORY_ORDER) {
        const entry = breakdown[key];
        if (entry === undefined || entry === null) continue;
        const first = Number.isFinite(entry.missUsd) ? entry.missUsd : 0;
        const cached = Number.isFinite(entry.hitUsd) ? entry.hitUsd : 0;
        const tokens = Number.isFinite(entry.tokens) ? entry.tokens : 0;
        if (first <= 0 && cached <= 0 && tokens <= 0) continue;
        rows.push({ key, label: t(`cat.${key}`), tokens, first, cached, total: first + cached });
      }
      rows.sort((left, right) => right.total - left.total || right.tokens - left.tokens);
      return rows;
    }

    /**
     * Build the dock entry component for one translate function.
     * @param {(key: string, params?: object) => string} t - translate.
     * @param {object} ctx - client context, for the account transport and per-call metadata.
     * @param {() => object | undefined} getAccount - the injected account face, when available.
     * @returns {Function} the React component.
     */
    function createEntry(t, ctx, getAccount) {
      return function PeakCostEntry({ useProjection }) {
        const usage = useProjection('peakCost');
        const now = useClock(30000);
        const [balance, setBalance] = React.useState(null);
        const [open, setOpen] = React.useState(false);
        const [position, setPosition] = React.useState(null);
        const rootRef = React.useRef(null);
        const openTimer = React.useRef(undefined);
        const closeTimer = React.useRef(undefined);

        React.useEffect(() => {
          let live = true;
          let warned = false;
          const fail = (reason) => {
            if (!warned) {
              warned = true;
              try {
                console.warn('peak-cost: account balance unavailable', reason);
              } catch {
                // no console in this host
              }
            }
            setBalance(null);
          };
          const read = () => {
            const account = getAccount?.() ?? resolveAccount(ctx);
            if (account === undefined) {
              fail('no account transport');
              return;
            }
            Promise.resolve()
              .then(() => account.getBalance(clientMetadata(ctx)))
              .then((result) => {
                if (!live) return;
                if (result === null || result === undefined || result.ok !== true) {
                  fail(result?.error?.code ?? 'read failed');
                  return;
                }
                setBalance(summarizeBalance(result.value));
              })
              .catch((error) => {
                if (live) fail(error?.message ?? 'read threw');
              });
          };
          read();
          const id = window.setInterval(read, 60000);
          const onFocus = () => read();
          window.addEventListener('focus', onFocus);
          return () => {
            live = false;
            window.clearInterval(id);
            window.removeEventListener('focus', onFocus);
          };
        }, []);

        // Keep the fixed-position panel glued to the trigger while it is open.
        React.useEffect(() => {
          if (!open) {
            setPosition(null);
            return undefined;
          }
          const place = () => {
            const element = rootRef.current;
            if (element === null || element === undefined || typeof element.getBoundingClientRect !== 'function') return;
            const rect = element.getBoundingClientRect();
            const width = Math.min(420, Math.max(280, window.innerWidth - 24));
            const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 12);
            setPosition({ left, width, bottom: window.innerHeight - rect.top + 10 });
          };
          place();
          window.addEventListener('scroll', place, true);
          window.addEventListener('resize', place);
          return () => {
            window.removeEventListener('scroll', place, true);
            window.removeEventListener('resize', place);
          };
        }, [open]);

        React.useEffect(() => {
          if (!open) return undefined;
          const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false);
          };
          document.addEventListener('keydown', onKeyDown);
          return () => document.removeEventListener('keydown', onKeyDown);
        }, [open]);

        React.useEffect(() => () => {
          window.clearTimeout(openTimer.current);
          window.clearTimeout(closeTimer.current);
        }, []);

        const windows = usage !== undefined && usage !== null && Array.isArray(usage.peakWindows)
          ? usage.peakWindows
          : DEFAULT_WINDOWS;
        const weekdaysOnly = usage !== undefined && usage !== null && typeof usage.weekdaysOnly === 'boolean'
          ? usage.weekdaysOnly
          : true;
        const holidays = usage !== undefined && usage !== null && Array.isArray(usage.holidays)
          ? usage.holidays
          : [];
        const peak = isPeakAt(now, windows, weekdaysOnly, holidays);
        const status = peak ? t('status.peak') : t('status.offPeak');
        const amount = formatUsd(usage !== undefined && usage !== null ? usage.costUsd : 0);
        const money = balance === null ? undefined : formatMoney(balance.primary.currency, balance.primary.total);
        const rows = buildRows(usage, t);
        const calls = usage !== undefined && usage !== null && Number.isFinite(usage.messages) ? usage.messages : 0;
        const output = usage !== undefined && usage !== null && Number.isFinite(usage.outCostUsd) ? usage.outCostUsd : 0;
        const flip = nextFlip(now, windows, weekdaysOnly, holidays);

        const enter = () => {
          window.clearTimeout(closeTimer.current);
          window.clearTimeout(openTimer.current);
          openTimer.current = window.setTimeout(() => setOpen(true), 120);
        };
        const leave = () => {
          window.clearTimeout(openTimer.current);
          window.clearTimeout(closeTimer.current);
          closeTimer.current = window.setTimeout(() => setOpen(false), 160);
        };

        const cell = (key, text, extra) => h('span', {
          key,
          style: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', ...extra },
        }, text);

        const grid = '1fr 62px 66px 62px';

        const panel = open ? h('div', {
          key: 'panel',
          role: 'tooltip',
          'data-testid': 'peak-cost-panel',
          style: {
            position: 'fixed',
            left: position === null ? 12 : position.left,
            bottom: position === null ? 64 : position.bottom,
            width: position === null ? 380 : position.width,
            zIndex: 60,
            boxSizing: 'border-box',
            padding: '10px 12px',
            // Opaque: the menu token may be translucent, so it is composited
            // over the opaque application base instead of used alone.
            backgroundColor: 'var(--dsw-alias-bg-base)',
            backgroundImage: 'linear-gradient(var(--dsw-specific-menu), var(--dsw-specific-menu))',
            color: 'var(--dsw-alias-label-primary)',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '10px',
            boxShadow: 'var(--dsw-elevation-panel)',
            fontSize: '12px',
            lineHeight: '18px',
            maxHeight: '60vh',
            overflowY: 'auto',
          },
        }, [
          h('div', {
            key: 'head',
            style: { display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '2px' },
          }, [
            h('span', { key: 's', style: { color: 'var(--dsw-alias-label-secondary)' } }, status),
            h('span', { key: 'sep', style: { color: 'var(--dsw-alias-label-secondary)', opacity: 0.6 } }, '·'),
            h('span', { key: 'amt', style: { fontWeight: 600 } }, `≈ ${amount}`),
          ]),
          h('div', { key: 'calls', style: { color: 'var(--dsw-alias-label-secondary)' } }, t('panel.calls', {
            calls,
            peak: usage?.peakMessages ?? 0,
            off: usage?.offPeakMessages ?? 0,
          })),
          money === undefined ? null : h('div', {
            key: 'bal',
            style: { color: 'var(--dsw-alias-label-secondary)' },
          }, [
            h('span', { key: 'label' }, t('panel.balance', { balance: money })),
            h('span', { key: 'parts' }, ` · ${t('panel.balanceParts', {
              recharge: formatMoney(balance.primary.currency, balance.primary.recharge),
              bonus: formatMoney(balance.primary.currency, balance.primary.bonus),
            })}`),
          ]),
          flip === undefined ? null : h('div', {
            key: 'flip',
            style: { color: 'var(--dsw-alias-label-secondary)' },
          }, t('panel.next', {
            status: peak ? t('status.offPeak') : t('status.peak'),
            gap: formatGap(flip - now, t),
          })),
          h('div', {
            key: 'rule',
            style: { height: '1px', background: 'var(--dsw-alias-border-l1)', margin: '8px 0' },
          }),
          h('div', { key: 'title', style: { fontWeight: 600, marginBottom: '4px' } }, t('panel.where')),
          rows.length === 0
            ? h('div', { key: 'empty', style: { color: 'var(--dsw-alias-label-secondary)' } }, t('panel.empty'))
            : h('div', { key: 'table' }, [
              h('div', {
                key: 'header',
                style: { display: 'grid', gridTemplateColumns: grid, gap: '6px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '2px' },
              }, [
                h('span', { key: 'c0' }, t('panel.col.category')),
                cell('c1', t('panel.col.tokens')),
                cell('c2', t('panel.col.first')),
                cell('c3', t('panel.col.cached')),
              ]),
              ...rows.map((row) => h('div', {
                key: row.key,
                style: { display: 'grid', gridTemplateColumns: grid, gap: '6px' },
              }, [
                h('span', { key: 'label', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.label),
                cell('tokens', formatTokens(row.tokens), { color: 'var(--dsw-alias-label-secondary)' }),
                cell('first', formatUsd(row.first)),
                cell('cached', formatUsd(row.cached)),
              ])),
              h('div', {
                key: 'output',
                style: { display: 'grid', gridTemplateColumns: grid, gap: '6px', marginTop: '4px' },
              }, [
                h('span', { key: 'label' }, t('panel.output')),
                cell('tokens', ''),
                h('span', {
                  key: 'value',
                  style: { gridColumn: 'span 2', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
                }, formatUsd(output)),
              ]),
              h('div', {
                key: 'total',
                style: {
                  display: 'grid',
                  gridTemplateColumns: grid,
                  gap: '6px',
                  marginTop: '4px',
                  paddingTop: '4px',
                  borderTop: '1px solid var(--dsw-alias-border-l1)',
                  fontWeight: 600,
                },
              }, [
                h('span', { key: 'label' }, t('panel.total')),
                cell('tokens', ''),
                h('span', {
                  key: 'sum',
                  style: { gridColumn: 'span 2', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
                }, formatUsd(usage !== undefined && usage !== null && Number.isFinite(usage.costUsd) ? usage.costUsd : 0)),
              ]),
            ]),
        ]) : null;

        return h('span', {
          ref: rootRef,
          'data-testid': 'peak-cost',
          onMouseEnter: enter,
          onMouseLeave: leave,
          onFocus: enter,
          onBlur: leave,
          tabIndex: 0,
          'aria-label': money === undefined
            ? t('aria', { status, amount })
            : t('aria.withBalance', { status, amount, balance: money }),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            position: 'relative',
            fontSize: '12px',
            lineHeight: '20px',
            color: 'var(--dsw-alias-label-secondary)',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            cursor: 'default',
            outline: 'none',
          },
        }, [
          h('span', {
            key: 'dot',
            'aria-hidden': true,
            style: {
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              flex: 'none',
              background: peak
                ? 'var(--dsw-alias-state-warn-primary)'
                : 'var(--dsw-alias-state-success-primary)',
            },
          }),
          h('span', { key: 'status', 'aria-hidden': true }, status),
          h('span', { key: 'sep', 'aria-hidden': true, style: { opacity: 0.6 } }, '·'),
          h('span', {
            key: 'amount',
            'aria-hidden': true,
            style: {
              color: 'var(--dsw-alias-label-primary)',
              fontVariantNumeric: 'tabular-nums',
            },
          }, `≈ ${amount}`),
          ...money === undefined ? [] : [
            h('span', { key: 'bal-sep', 'aria-hidden': true, style: { opacity: 0.6 } }, '·'),
            h('span', {
              key: 'bal',
              'aria-hidden': true,
              style: { display: 'inline-flex', alignItems: 'center', gap: '3px' },
            }, [
              h('span', { key: 'label', style: { opacity: 0.8 } }, t('balance.short')),
              h('span', {
                key: 'value',
                style: { color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums' },
              }, money),
            ]),
          ],
          panel,
        ]);
      };
    }

    /**
     * Resolve the account transport without making it a hard dependency: a
     * profile without the account Remote still gets the cost line.
     * @param {object} ctx - client context.
     * @returns {object | undefined} the `remote.account` face when present.
     */
    function resolveAccount(ctx) {
      try {
        let remote;
        if (typeof ctx.get === 'function') remote = ctx.get('remote');
        if (remote === undefined || remote === null) remote = ctx.remote;
        if (remote === undefined || remote === null) return undefined;
        const account = remote.account;
        return account !== null && account !== undefined && typeof account.getBalance === 'function'
          ? account
          : undefined;
      } catch {
        return undefined;
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { en: LOCALES.en, zh: LOCALES.zh }),
          'peak-cost: locale dictionary',
        );
        const t = translate(ctx.locale.bind(NS), LOCALES.en);
        // The account face is a Typert Remote namespace, not a plain service:
        // capture it through a scoped injection so the entry still renders on
        // profiles that have no account transport at all.
        let account;
        const capture = (scoped) => {
          try {
            const face = scoped['remote.account'] ?? scoped.remote?.account;
            if (face !== null && face !== undefined && typeof face.getBalance === 'function') account = face;
          } catch {
            // leave the fallback path to try the root context
          }
        };
        if (typeof ctx.inject === 'function') {
          try {
            ctx.inject(['remote.account'], (scoped) => {
              capture(scoped);
              return () => {
                account = undefined;
              };
            });
          } catch {
            // optional dependency
          }
        }
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'peak-cost',
          order: 2,
        }, createEntry(t, ctx, () => account)));
      },
      /** Pure helpers exposed for the unit suite; the loader ignores them. */
      test: { summarizeBalance, formatMoney, clientMetadata, buildRows },
    };
  },
});
