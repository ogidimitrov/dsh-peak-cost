/**
 * Client half of `dsh-peak-cost` — https://github.com/ogidimitrov/dsh-peak-cost
 *
 * Renders one ambient entry below the composer card:
 *
 *     ● Off-peak · $0.0042
 *
 * The status is computed from the browser clock against DeepSeek's published
 * peak calendar, so it moves on its own across a boundary. The amount comes
 * from the `peakCost` session projection (Host half), which prices every model
 * call in the durable log at the rate card and billing window that applied
 * when that call ran.
 */
window.__ModuleLoader__.load({
  id: 'dsh-peak-cost',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'peak-cost';

    /** Fallback calendar for a Session whose projection has no messages yet. */
    const DEFAULT_WINDOWS = [[60, 240], [360, 600]];

    const LOCALES = {
      en: {
        'status.peak': 'Peak hours',
        'status.offPeak': 'Off-peak',
        'aria': 'DeepSeek billing: {status}. Estimated session spend {amount}.',
        'tip.window': 'DeepSeek billing window: {status}',
        'tip.next': 'Changes to {status} in {gap}',
        'tip.spend': 'Estimated this session: {amount} over {calls} model calls',
        'tip.tokens': 'Input {input} ({percent}% cache hit) · output {output}',
        'tip.split': 'Billed: input {miss} + cache {hit} + output {out}',
        'tip.uncached': 'The same prompt without prompt caching would cost {amount} at list price',
        'tip.balance': 'This is a list-price equivalent, not a wallet reading: DeepSeek consumes granted or bonus credit before a topped-up balance, so a topped-up balance can stay flat while this number grows.',
        'tip.mixed': '{peak} calls at peak, {off} at off-peak',
        'tip.unpriced': '{count} call(s) billed on an unknown route were excluded',
        'tip.estimate': 'Estimate from list prices; cached-prefix and discount timing follow the session log.',
        'gap.minutes': '{n} min',
        'gap.hours': '{n} h {m} min',
        'gap.days': '{n} d {h} h',
      },
      zh: {
        'status.peak': '高峰时段',
        'status.offPeak': '非高峰时段',
        'aria': 'DeepSeek 计费：{status}。本会话预估花费 {amount}。',
        'tip.window': 'DeepSeek 计费时段：{status}',
        'tip.next': '{gap}后转入{status}',
        'tip.spend': '本会话预估：{amount}，共 {calls} 次模型调用',
        'tip.tokens': '输入 {input}（缓存命中 {percent}%）· 输出 {output}',
        'tip.split': '计费：输入 {miss} + 缓存 {hit} + 输出 {out}',
        'tip.uncached': '同样的提示若不使用缓存，按标价约为 {amount}',
        'tip.balance': '这只是按标价折算的等效金额，不是钱包读数：DeepSeek 会先扣减赠送或奖励额度，因此充值的余额可能保持不变。',
        'tip.mixed': '高峰 {peak} 次，非高峰 {off} 次',
        'tip.unpriced': '{count} 次未知路由调用未计价',
        'tip.estimate': '按官方标价估算；缓存前缀与折扣时段以会话日志为准。',
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
     * Build the dock entry component for one translate function.
     * @param {(key: string, params?: object) => string} t - translate.
     * @returns {Function} the React component.
     */
    function createEntry(t) {
      return function PeakCostEntry({ useProjection }) {
        const usage = useProjection('peakCost');
        const now = useClock(30000);
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
        const flip = nextFlip(now, windows, weekdaysOnly, holidays);
        const lines = [];
        lines.push(t('tip.window', { status }));
        if (flip !== undefined) {
          lines.push(t('tip.next', {
            status: peak ? t('status.offPeak') : t('status.peak'),
            gap: formatGap(flip - now, t),
          }));
        }
        if (usage !== undefined && usage !== null && (usage.messages ?? 0) > 0) {
          const promptTokens = (usage.inputTokens ?? 0) + (usage.hitTokens ?? 0);
          const percent = promptTokens > 0
            ? Math.round(((usage.hitTokens ?? 0) / promptTokens) * 1000) / 10
            : 0;
          lines.push(t('tip.spend', { amount, calls: usage.messages }));
          lines.push(t('tip.tokens', {
            input: formatTokens(usage.inputTokens),
            percent,
            output: formatTokens(usage.outputTokens),
          }));
          lines.push(t('tip.split', {
            miss: formatUsd(usage.missCostUsd ?? 0),
            hit: formatUsd(usage.hitCostUsd ?? 0),
            out: formatUsd(usage.outCostUsd ?? 0),
          }));
          if ((usage.uncachedCostUsd ?? 0) > 0) {
            lines.push(t('tip.uncached', { amount: formatUsd(usage.uncachedCostUsd) }));
          }
          if ((usage.peakMessages ?? 0) > 0 && (usage.offPeakMessages ?? 0) > 0) {
            lines.push(t('tip.mixed', { peak: usage.peakMessages, off: usage.offPeakMessages }));
          }
          if ((usage.unpricedMessages ?? 0) > 0) {
            lines.push(t('tip.unpriced', { count: usage.unpricedMessages }));
          }
          lines.push(t('tip.estimate'));
          lines.push(t('tip.balance'));
        }
        return h('span', {
          'data-testid': 'peak-cost',
          title: lines.join('\n'),
          'aria-label': t('aria', { status, amount }),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '12px',
            lineHeight: '20px',
            color: 'var(--dsw-alias-label-secondary)',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            cursor: 'default',
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
        ]);
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { en: LOCALES.en, zh: LOCALES.zh }),
          'peak-cost: locale dictionary',
        );
        const t = translate(ctx.locale.bind(NS), LOCALES.en);
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'peak-cost',
          order: 2,
        }, createEntry(t)));
      },
    };
  },
});
