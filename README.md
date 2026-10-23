# dsh-peak-cost

A [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart) plugin that adds one ambient line under the composer:

```text
● Off-peak · $0.063
```

It answers two questions about the session you are in:

1. **Is DeepSeek billing in peak hours right now?**
2. **How much has this session cost so far, in US dollars?**

Hovering the line expands it into a breakdown: the billing window and the time until it flips, the estimated spend and model-call count, the input/cache/output token split, and how many calls ran at each rate.

<p align="center">
  <img src="icon.svg" width="72" height="72" alt="dsh-peak-cost icon">
</p>

## Behavior

| | |
|---|---|
| Slot | `conversation.composer.dock` (below the composer card, beside the shipped activity and context-usage entries) |
| Scope | Per session |
| Updates | Spend follows every settled model call; the status label re-evaluates against the clock every 30 s; the balance refreshes every 60 s |
| Locales | English and Chinese, following the app's language setting |

### Balance

Next to the session estimate the line also shows your DeepSeek account balance:

```text
● Off-peak · ≈ $0.18 · bal ¥7.26
```

It is read from the Host's account Remote (`ctx.remote.account.getBalance`) every 60 seconds — the same call the Settings → Account page makes — and **both wallet kinds are summed**: the recharge wallet plus any bonus/grant wallet, which is why it can differ from a single number on a top-up page. The tooltip breaks the two apart when a bonus wallet exists.

The balance is optional in every direction: a signed-out account, an API-key-only setup, a failed read, or a build without the account transport all simply drop it, leaving the cost line intact. Nothing is cached to disk.

### Cost

## Install

The package is a Harness **bundle**: it declares `dsh.bundle.patch` and a `dsh.client` half, so installing it in a profile mounts both the Host projection and the Web entry.

Install the package spec `github:ogidimitrov/dsh-peak-cost` as a bundle — from the Plugins page of the app, or from an agent session through the plugin manager's `install_bundle` action with that spec as the target.

The plugin needs a Harness build that provides the session projection registry, the `conversation.composer.dock` slot, and the client locale service — that is, the current DeepSeek Harness desktop/web app. It has no npm dependencies and no build step.

To remove it, uninstall the bundle from the same Plugins page.

## How the number is computed

Money is not inferred on the client from a token total. The Host half folds the durable session log and registers one session projection, `peakCost`, whose wire view carries the cumulative spend. The Client renders that value; it never re-folds events, so the figure survives paging, reloads, and compaction.

Each `assistant/message` in the log is priced on its own:

- **model** — from the message's own provider metadata, so a session that switches between `deepseek-flash` and `deepseek-v4-pro` stays correct;
- **tokens** — cache-miss input, cache-hit input, cache-write, and output are priced separately from the provider-reported usage (falling back to the usage chunk in the message's stream);
- **billing window** — from the message's own timestamp, so a session that crosses a peak boundary is priced correctly in both windows;
- **discount** — off-peak rates are half of peak rates.

Because the fold is a pure function of committed events, replay and fork produce the same figure.

### Cache hits are part of the calculation

Harness sends the whole conversation on every model call, so a long session burns a large prompt each time — and nearly all of it is a **cache hit**, billed at the hit rate rather than the input rate. That discount is the whole reason one session can move millions of prompt tokens for cents.

A real session from this plugin, mid-conversation, off-peak on `deepseek-flash`:

| | tokens | rate (off-peak) | cost |
|---|---|---|---|
| cache-miss input | 184,312 | $0.15 / 1M | $0.028 |
| cache-hit input | 21,805,952 | $0.003 / 1M | $0.065 |
| output | 102,878 | $0.60 / 1M | $0.062 |
| **total** | | | **$0.155** |

The same 22M prompt tokens billed without prompt caching would be **$3.36** at the miss rate. The tooltip shows this line for the session you are looking at, so the discount is visible rather than assumed.

### Why this number and your balance can disagree

The figure is a **list-price equivalent**, computed from the session log; it never reads your wallet. Three things make a wallet diverge from it:

- **Granted or bonus credit is consumed first.** DeepSeek deducts from granted/bonus balances before a topped-up balance, so a topped-up number can stay flat while usage accrues.
- **The balance is not streamed.** It is read on demand from the platform; a panel left open shows what it read.
- **Not every call is in the log.** Session-title generation and some compaction work never commit an `assistant/message`, so they cost money this estimate cannot see.

Use the platform's usage page for the authoritative charge; this line is for watching a session's shape while it runs.


### Rates and calendar

Defaults follow [DeepSeek's published pricing](https://api-docs.deepseek.com/quick_start/pricing/) (USD per 1M tokens):

| Model | Cache hit | Cache miss | Output |
|---|---|---|---|
| `deepseek-flash` | 0.006 | 0.30 | 1.20 |
| `deepseek-v4-pro` | 0.044 | 1.32 | 3.96 |

Peak hours are **01:00–04:00 and 06:00–10:00 UTC, Monday through Friday**, excluding Chinese public holidays. Every other hour, all weekend, and Chinese public holidays are off-peak. Off-peak prices are half of the table above.

Both the rates and the calendar are constants at the top of [`index.js`](index.js):

- `MODEL_RATES` — add or change a model card when DeepSeek changes prices;
- `PEAK_WINDOWS`, `PEAK_WEEKDAYS_ONLY` — the billing calendar;
- `PEAK_HOLIDAYS` — Chinese public holidays as UTC `YYYY-MM-DD`. **Empty by default**: on a holiday the indicator reports "peak" while billing is actually off-peak, until you add the dates.

Legacy aliases (`deepseek-v4-flash`, and the older `-chat` / `-reasoner` names) bill at the flash card.

## Known limitations

- **An estimate.** It prices reported tokens at list rates. It is not a bill: nothing here reads your balance or the provider's invoice.
- **Only settled model calls count.** Calls that never commit an `assistant/message` — session-title generation, some compaction work — are not in the log and are not counted. Failed attempts that report usage without a settled message are likewise skipped.
- **One session.** Subagent sessions have their own logs and their own dock lines; this number is the session you are looking at.
- **Unknown routes.** A model id that matches no card is counted in the message total but priced at zero; the tooltip reports how many.
- **Search/Fetch.** Standalone Search and Fetch API charges are not modelled.

## Development

```bash
npm test        # node --test: fold semantics, window edges, wire schema, client rendering
```

The suite needs nothing beyond Node 22+:

- [`test/fold.test.mjs`](test/fold.test.mjs) drives the Host fold directly — peak edges, weekends, cache buckets, model routing, unknown routes, stream fallback, checkpoint safety;
- [`test/client.test.mjs`](test/client.test.mjs) loads the client module with a stubbed module loader and React, then renders the dock entry against projection values shaped like the wire view.

Bundle layout:

```text
index.js            Host half: the `peakCost` session projection
client.js           Client half: the composer-dock entry and locale dictionaries
cordis.patch.yml    Loader row inserted by the bundle
locale/{en,zh}.json Plugin Manager title and description
icon.svg            Plugin artwork
```

## License

MIT — see [LICENSE](LICENSE).
