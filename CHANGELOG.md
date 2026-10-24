# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.1] - 2026-10-24

### Changed

- The hover panel is opaque: the menu tint is composited over the opaque application base rather than rendered translucent over the conversation.

### Removed

- The explanatory footer under **Session total** — the web-result note, the no-cache counterfactual, the estimate note and the wallet caveat. The panel now ends at the total.

## [1.4.0] - 2026-10-24

### Added

- A themed hover panel in place of the native tooltip: fixed-positioned above the composer, dismissed on leave or Escape, styled with the host's menu, border and elevation tokens.
- Cost attribution per content category — web results, tool results, your messages, assistant replies, model thinking, system prompt and tool schemas — with a **first time** (cache-miss) and **re-sent** (cache-hit) column per row, plus model output and the session total.
- A rolling context model: new content is billed as input on the call that first carries it and as cache on every later call; replaced or compacted content is subtracted as it leaves the surface.

### Changed

- The projection state version is 3, so existing session checkpoints refold from the log.

## [1.3.2] - 2026-10-24

### Added

- This changelog.

### Changed

- CI and release workflows run on `actions/checkout@v7` and `actions/setup-node@v7` after the Dependabot merge.

## [1.3.1] - 2026-10-23

### Added

- A real capture of the dock line in the README, plus `screenshots.json` so storefronts can show it.

## [1.3.0] - 2026-10-23

### Fixed

- The account balance now resolves through a scoped `ctx.inject(['remote.account'])` and a root-context fallback, instead of a plain service lookup that never matched — the balance had been silently absent since 1.2.0.

### Changed

- The tooltip always lists recharge, bonus and total, and refreshes on window focus.
- A failed or missing account transport logs one console warning instead of failing silently.

## [1.2.0] - 2026-10-23

### Added

- The DeepSeek account balance beside the session estimate, summed across recharge and bonus wallets.

## [1.1.0] - 2026-10-23

### Added

- The billed split (input, cache hit, output) and the same prompt priced without caching.

### Changed

- The figure reads as an estimate (`≈`) and the README documents why a topped-up balance can stay flat.

## [1.0.0] - 2026-10-23

### Added

- Peak/off-peak billing status and the estimated USD spend for the current session, under the composer.
- A `peakCost` session projection that prices every settled model call at its own model card and billing window.
