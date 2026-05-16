# Changelog

All notable changes to `@thetanuts-finance/cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-17

Initial public release. Trader-focused command surface for Thetanuts Finance V4
on Base (chainId 8453).

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
- **`book`** — OptionBook orderflow: `orders`, `preview`, `max-contracts`,
  `check` (pre-trade liquidity analyzer ported from OpenClaw
  `check-orderbook.ts`), `fill`.
- **`position`** — owned-option management: `list`, `info`, `full`, `payout`
  (claim post-expiry — cash settlement isn't auto-distributed), `calc-payout`
  (local payout math, no RPC).
- **`keys`** — RFQ ECDH keypair management: `generate`, `show`, `export`,
  `import`, `remove`. One keypair per chain at
  `<config-dir>/rfq-keys/` (chmod 700/600). Private key never printed to
  stdout — export only writes to a file.
- **`rfq`** — requester lifecycle: `build`, `get`, `request`, `cancel`,
  `offers` (decrypt incoming offers from makers), `accept` (early-settle a
  specific maker offer; optional — the protocol auto-settles when the offer
  window closes), `settle` (post-reveal finalize), `status`. Calldata is
  byte-equal to OpenClaw `build-rfq.ts` for all 8 comparable structures.
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

- **USDC-collateralized fills only.** `book fill` rejects WETH or cbBTC
  collateral with a clear error. The SDK's `calculateNumContracts` formula
  is mathematically valid only when collateral input is 6-decimal scale —
  WETH (18-dec) and cbBTC (8-dec) fill support will roll out in a future
  release.
- **No live RFQ broadcast tested.** The requester path is dry-run verified
  end-to-end, but no real maker has submitted an encrypted offer to a
  CLI-created RFQ yet. The `offers` decryption + `accept` flows exist but
  are not road-tested.
- **Base-only.** `--chain` rejects anything but `base` / `8453` with a
  clear error. The SDK still supports Ethereum (chainId 1, vault-only),
  but the CLI doesn't surface any vault commands yet.
- **No automated tests.** Ships on manual smoke alone. Test infrastructure
  (vitest, snapshot tests for `--help`, live-RPC read smoke in CI) is on
  the roadmap.

### Out of scope for 0.1.0 (planned for future releases)

- `wallet sign-message` (EIP-191 / EIP-712 signer) — for off-chain auth
- BIP-39 mnemonic import (currently raw private key only)
- HD-wallet multi-account access (`wallet derive --index N`)
- OS keychain backend (currently filesystem with chmod 600)
- WETH/cbBTC fill support
- Maker side of RFQ — real makers run dedicated MM bots, not CLIs
- `loan`, `ranger`, RFQ-side `market` subcommands, `events`
- Phase 4: `watch` (WebSocket streams), `wheel`, `vault`

[Unreleased]: https://github.com/Thetanuts-Finance/thetanuts-sdk/compare/cli-v0.1.0...HEAD
[0.1.0]: https://github.com/Thetanuts-Finance/thetanuts-sdk/releases/tag/cli-v0.1.0
