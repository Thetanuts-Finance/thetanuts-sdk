# Changelog

All notable changes to `@thetanuts-finance/cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] — 2026-05-19

Docs-only patch. No code changes; behavior identical to `0.1.0`.

### Changed

- **README install section rewritten.** Removed the "From source (today)"
  build-from-git path that pre-dated the npm publish. Replaced with three
  paste-ready install paths (global `-g`, `npx --yes` one-off, and local
  + `npx`). Added a "`thetanuts: command not found` after `npm install`?"
  troubleshooting section explaining why local installs don't expose the
  binary on PATH and how to fix it.

## [0.1.0] — 2026-05-19

Initial public release on npm as `@thetanuts-finance/cli`.
Trader-focused command surface for Thetanuts Finance V4 on Base (chainId 8453).

Install:

```bash
npm install -g @thetanuts-finance/cli
thetanuts --help
```

Or one-off via `npx --yes @thetanuts-finance/cli market data`.

Verified live on Base mainnet during pre-publish smoke (real txs in the PR description on the merge commit). All critical write paths broadcast cleanly: book fill, RFQ open/cancel/close/build-file/auto-settle, wallet transfer, position payout (zero-payout fast-path).

### Added

- **`setup`** — first-run wizard: wallet create / import, RPC URL, persisted
  config at `~/.config/thetanuts/config.json` (chmod 600).
- **`config`** — show / path / set / unset / validate persisted CLI config.
  `set privateKey` refuses argv (history / `ps aux` leak vector); accepts
  stdin via `-`.
- **`chain`** — chain metadata: `info`, `tokens`, `contracts`.
- **`wallet`** — `create`, `import`, `show`, `balance`, `allowance`, `approve`,
  `reset`. `wallet create` generates a fresh random key, saves to config with
  chmod 600, optionally displays the BIP-39 mnemonic ONCE for paper backup.
- **`market`** — live indexer reads: `data` (spot prices), `stats` (protocol
  stats), `positions` / `history` / `option` (by address).
- **`pricing`** — MM quotes: `all`, `ticker`, `position` (premium + collateral
  cost), `spread`, `butterfly`, `condor`.
- **`book`** — OptionBook orderflow: `orders` (humanized columns with
  ticker / $-formatted strike-premium-available / ISO expiry in table
  mode; raw decimals preserved under `-o json`), `preview`,
  `max-contracts`, `check` (pre-trade liquidity analyzer ported from
  OpenClaw `check-orderbook.ts`), `fill`. Fill / preview / max-contracts
  accept stable selector flags `--underlying / --type / --strike /
  --expiry` instead of the volatile `--order-index` (which still works
  as a legacy escape hatch). The selector path re-resolves at broadcast
  time, picking the cheapest matching order for BUY by default;
  `--strict` errors instead.
- **`position`** — owned-option management: `list`, `info`, `full`, `payout`
  (claim post-expiry — cash settlement isn't auto-distributed; zero-payout
  OTM positions exit cleanly without attempting to broadcast),
  `calc-payout` (local payout math, no RPC),
  **`close`** — opens an opposite-direction RFQ on the same option to unwind
  early (mirrors the dApp's `useRfqActions.ts:701 handleClosePosition`).
  USDC-collateral only in v0.1.0; reserve price auto-derives from MM bid/ask
  or accepts `--reserve-price <usd-per-contract>` override.
- **`wallet`** also gained **`transfer`** — `transfer --token <SYM> --to
  <addr> --amount <n>` for sending any configured ERC-20 (USDC, WETH,
  cbBTC, etc.) out of the CLI wallet. Balance pre-check, address
  validation, `--dry-run` emits encoded `transfer(address,uint256)`
  calldata, full receipt with `feeUsd`.
- **`keys`** — RFQ ECDH keypair management: `generate`, `show`, `export`,
  `import`, `remove`. One keypair per chain at
  `<config-dir>/rfq-keys/` (chmod 700/600). Private key never printed to
  stdout — export only writes to a file.
- **`rfq`** — requester lifecycle: `quote`, `build`, `get`, `request`,
  `cancel`, `offers` (decrypt incoming offers from makers), `accept`
  (early-settle a specific maker offer; optional — the protocol
  auto-settles when the offer window closes), `settle` (post-reveal
  finalize), `status`. Calldata is byte-equal to OpenClaw `build-rfq.ts`
  for all 8 comparable structures. Submissions are gated on the MM's
  live quote grid — refuses (strike, expiry) combinations the MM isn't
  pricing, with a hint pointing at `rfq quote` and an explicit
  `--reserve-price` override. `--from-build-file` re-validates the grid
  at submission time. Iron-condor builds correctly split put/call legs
  to verify each against the right surface.
- **Safety pattern for writes:** every broadcast runs a preview, an optional
  approval prompt with the spender address shown, then a confirm prompt.
  `--dry-run` always emits encoded calldata without broadcasting.
  `--dry-run` wins over `--yes` precedence (intentional — money is on the line).
- **Output formats:** `-o table|json|csv|yaml`. BigInts serialized as decimal
  strings. EPIPE handled on stdout.
- **Exit codes:** `0` success, `1` generic error, `2` usage error, `3`
  confirm refused / dry-run aborted, `4` config / wallet error, `5` chain
  unsupported, `6` RFQ crypto error.

### Limitations

- **USDC collateral only.** `book fill`, `rfq build/request`, and
  `position close` all reject WETH and cbBTC collateral with a clear
  exit-4 error. The SDK still supports WETH for the inverse-CALL family —
  only the CLI surface is gated for v0.1.0. The `position close` math
  uses `Number(numContractsRaw) × pricePerContract` which loses precision
  above Number.MAX_SAFE_INTEGER; gating to USDC (6-dec, stays precise to
  ~9e9 contracts) avoids silent dust loss until Decimal.js arithmetic
  is wired in.
- **Live broadcast verified, multi-leg + ITM payout not fully exercised.**
  Vanilla and PUT-spread RFQs broadcast and auto-settle cleanly on
  mainnet; iron-condor builds pass the grid gate but a real IC fill
  hasn't been smoked. `position payout` is verified for the zero-payout
  (expired-OTM) fast-path; an actually-ITM payout broadcast hasn't been
  exercised.
- **Indexer status mismatch on `rfq offers`.** The indexer occasionally
  cross-links offers from older RFQs that share the same maker signing
  key — winning lower offers can surface as "rejected" in the offers
  table even when auto-settle picks them. Use `rfq status` and
  `position list` as the authoritative outcome.
- **MM "spread too wide" rule.** Even when your reserve clears the
  current bid/ask, MMs may decline if their own internal spread is too
  wide. Documented in the close-position section; retry later or use a
  smaller reserve gap.
- **Close RFQs don't always auto-settle.** When no maker matches a close
  RFQ, nobody is incentivized to call `settleQuotation`. The post-broadcast
  hint tells users to call `thetanuts rfq settle --id <quotationId>`
  manually after the offer deadline to refund the escrow.
- **Base mainnet only.** `--chain` rejects anything but `base` / `8453`.
  The SDK still supports Ethereum (chainId 1, vault-only), but the CLI
  doesn't surface vault commands yet.
- **No automated test suite.** Ships on manual + live mainnet smoke
  alone. Test infrastructure (vitest, snapshot tests for `--help`, live
  read-only RPC smoke in CI) is on the roadmap.
- **Display drift on non-USDC positions.** MTM PnL and `book orders`
  premium column use `Number(rawBigInt) / 10^decimals`. USDC stays
  precise to ~9e9 contracts; WETH (18-dec) and cbBTC (8-dec) display
  can drift by dust. Display only — no fund risk.

### Out of scope for 0.1.0 (planned for future releases)

- `wallet sign-message` (EIP-191 / EIP-712 signer) — for off-chain auth
- BIP-39 mnemonic import (currently raw private key only)
- HD-wallet multi-account access (`wallet derive --index N`)
- OS keychain backend (currently filesystem with chmod 600)
- WETH/cbBTC fill support
- Maker side of RFQ — real makers run dedicated MM bots, not CLIs
- `loan`, `ranger`, RFQ-side `market` subcommands, `events`
- Phase 4: `watch` (WebSocket streams), `wheel`, `vault`

[Unreleased]: https://github.com/Thetanuts-Finance/thetanuts-sdk/compare/cli-v0.1.1...HEAD
[0.1.1]: https://github.com/Thetanuts-Finance/thetanuts-sdk/compare/cli-v0.1.0...cli-v0.1.1
[0.1.0]: https://github.com/Thetanuts-Finance/thetanuts-sdk/releases/tag/cli-v0.1.0
