# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
