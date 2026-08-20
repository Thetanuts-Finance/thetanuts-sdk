# Changelog

All notable changes to `@thetanuts-finance/cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] — 2026-08-21

### Added

- **`rfq request --pay-with`** — fund an RFQ's collateral from an asset you
  already hold, in the same transaction, via `OptionFactory.swapAndCall`.
  - `--pay-with eth` wraps native ETH to WETH 1:1 inside the factory. No
    approval, no aggregator. **WETH is the only destination native ETH can
    reach** — the wrap path can only fund a token with a payable `receive()`,
    and the swap path reverts `NativeTokenNotAllowedForSwap` as soon as
    `msg.value > 0`. So there is no ETH -> USDC route through `swapAndCall`; the
    CLI rejects it up front and points at `--pay-with weth` instead of letting
    the revert surface.
  - `--pay-with <symbol|address> --pay-amount <n>` swaps through KyberSwap.
    The approval target is the **OptionFactory**, not the router — the factory
    is what calls the router — and `--dry-run` prints that explicitly.
  - **BUY requests only.** A long request escrows `reservePrice` when it is
    submitted, and that escrow is what the swap funds. A SELL request escrows
    nothing at request time — the factory pulls collateral from the seller at
    settlement — so there is nothing to fund up front, and the CLI refuses the
    combination rather than paying swap fees for a round-trip.
  - Sizing: the required deposit is the request's `reservePrice`, not a
    recomputation — the request's own `collateralAmount` is always 0. A quote
    that cannot cover it is refused before signing, with a suggested
    `--pay-amount`. Excess is refunded by the contract.
  - Rails: `--slippage-bps` (default 100, capped at 500 without an override),
    `--max-price-impact-bps` (default 200), `--force-slippage` to override both.
    Every rail — plus the wallet's balance of the pay-with token — is evaluated
    while the plan is built, before any approval is broadcast, so a rejected
    route costs no gas. The router is checked against `authorizedRouters`
    on-chain before anything is signed. A route the
    aggregator returns without USD pricing is refused rather than treated as
    zero impact — that is the case the rail exists for. Both the price-impact
    and min-output gates re-run against the refreshed quote at broadcast.
  - `--ensure-allowance` is rejected alongside `--pay-with`: the approval target
    moves to the pay-with token, so the flag would approve the wrong asset.
  - The route is quoted fresh at the broadcast boundary, never carried through
    the confirmation prompt, and re-checked against the required deposit in
    case the price moved while the prompt was open. Covering the deposit is not
    on its own treated as consent to the rate: the minimum shown at the prompt
    is carried across the re-quote and enforced, so a refreshed route that
    guarantees less is refused rather than broadcast. That figure includes a
    0.5% re-quote allowance, so ordinary price movement does not abort the run.
  - The aggregator's executable calldata is decoded and bound to the quoted
    trade before it is signed — source and destination token, amount,
    destination receiver, and the `minReturnAmount` the router actually
    enforces. The decoded minimum, not the response's plaintext `amountOut`, is
    what the floor above is measured against, so an aggregator response cannot
    report one price and encode another. Routes carrying a router-level fee, or
    using an entrypoint the CLI cannot decode, are refused.
  - The configured chain is asserted against the RPC before the approval and
    the swap are broadcast. `--pay-with` signs its transaction directly rather
    than through an SDK write method, which is where that check normally lives.
  - Entirely CLI-side: it builds calldata with the SDK's existing
    `encodeSwapAndCall` and sends it with the wallet's own signer, so no SDK
    change is required. The contract rules, the aggregator client, the router
    calldata decoder, and the Kyber router address all live in
    `cli/src/swapAndCall.ts`.

### Known limitations

- `--pay-with` is BUY-side only, for the reason above: a short RFQ has no
  request-time deposit for a swap to fund.
- `--pay-with` covers `rfq request` only, by design. `book fill` premiums are
  USDC-only in this CLI, so the friction is far smaller than on RFQ, where the
  collateral token is dictated by the structure (every single-strike ETH CALL is
  a WETH-collateralized `INVERSE_CALL`). `OptionBook.swapAndFillOrder` is also
  `nonpayable`, so it cannot accept native ETH at all — the user who would
  benefit most is the one it cannot serve. Revisit if the book ever lists
  non-USDC orders.
- Should that happen, note that `swapAndFillOrder` is **not** a reuse of this
  code. Verified against the deployed OptionBook source: it performs no
  destination-side balance check and pulls the premium from the taker's wallet,
  so its route needs `recipient = taker` while this one needs
  `recipient = factory`. Getting that backwards strands the swap output in the
  book without reverting. Details in the `cli/src/swapAndCall.ts` header.
- `swapAndCall` also accepts `settleQuotationEarly` /
  `settleQuotationEarlyByOrderBook` as its self-call, so `rfq accept` could
  fund a top-up the same way. Not implemented: the contract requires the
  requester to be long, with no current winner, and a deposit already short of
  the target, which means quoting for a computed delta rather than a
  user-supplied amount.

## [0.3.1] — 2026-08-20

### Docs

- README version banner updated to describe the 0.3.0 `book check` and referrer
  behaviour. No runtime change.

## [0.3.0] — 2026-08-20

### Fixed

- **`book check` recommended RFQ for strikes that were live and fillable on the
  orderbook.** It matched only `strikes[0]`, so any strike sitting on a
  structure's second/third/fourth leg was invisible to it — roughly half the
  live book is multi-leg (spreads, flies, rangers). Following its advice routed
  traders off the book and forfeited orderbook credit. The inverse also
  happened: a 4-strike RANGER whose first leg matched was reported as a
  fillable vanilla, with a vanilla ticker and the structure's premium quoted as
  a vanilla ask, and the `nextStep` it printed then failed to resolve.

  `check` now shares one matcher with `book preview` / `book fill`
  (`src/bookMatch.ts`), so the commands cannot disagree about what the book
  holds. Measured against a live 220-order book: 206 of 384 strike positions
  were previously unreachable.
- **`book preview` / `book fill` missed orders whose strikes are stored
  descending.** Makers do not use a canonical strike order — 19 of 310 live
  orders store them high-to-low. Matching was element-wise, so
  `--strikes 64500,65000` reported "No live order matches" while
  `--strikes 65000,64500` filled the same order. Strike vectors are now
  compared as multisets; the caller's argument order never reaches the
  contract, which encodes the signed order's own vector.
- **`book check --underlying` rejected everything except ETH and BTC**, leaving
  live SOL/DOGE/XRP/BNB/AVAX orders unreachable. It now resolves any feed
  configured in `chainConfig.priceFeeds`, matching `book orders` and
  `book preview`.
- **`book check --direction sell` returned RFQ unconditionally** without
  consulting the book. It now scans the sell side and reports what exists,
  flagging `cliExecutable: false` because the CLI executes buys only.
- **`book fill --dry-run --output json` emitted two concatenated JSON
  documents** (preview, then calldata), which no JSON parser accepts. Machine
  output is now a single object with the preview nested under `preview`. Table
  output is unchanged.
- **`book check` claimed an aggregate size was available that its own
  recommended command could not fill.** `availableSize` summed every matching
  maker, but `book preview` / `book fill` resolve exactly one order (the
  cheapest). With 5 contracts at $1 and 5 at $2, `--size 8` reported "fully
  available" and then filled 5. The ladder is now reported as `priceLevels`,
  `nextStepMaxSize` states what one invocation can take, and
  `partialFillAvailable` is keyed off that instead of the aggregate.
- **`book check` auto-selected between structures whose payoffs are not
  comparable.** Every structure carrying the requested strike was sorted by
  whole-structure premium, the first was labelled "cheapest", and its command
  became the top-level `nextStep` — but a spread, fly, condor and ranger
  sharing one strike are different products, and the requested strike can be a
  long, short or middle leg, so following that command could open exposure
  opposite to the vanilla the caller asked about. Structure matches are now
  reported as unranked alternatives with `legIndex` / `legCount`, and the
  top-level `nextStep` is prose (`nextStepIsCommand: false`) telling the caller
  to pick one.
- **`book check --direction sell` recommended the orderbook and then handed
  back an `rfq build` command** — the exact off-book route the orderbook
  recommendation exists to prevent. Sell-side matches now return a dApp action
  and never an RFQ command. Per-structure steps on a sell result no longer emit
  `book preview` commands either: `preview` filters to asks, so it could not
  preview the bid that matched.
- **`book check` ignored `--size` for structure-only results**, reporting
  `recommendation: orderbook` alongside `availableSize: null`. Each structure
  match now carries `meetsRequestedSize`.
- **A one-off `--referrer` was dropped from the workflow `book check`
  generated.** The flag configures only the current process, so copying the
  recommended preview/fill command silently fell back to address zero. The
  resolved referrer is now reported as `referrer` and baked into every emitted
  command. Global flags also appear under a **Global Options** heading in
  subcommand help (`book fill --help`), instead of only on `thetanuts --help`.

### Added

- **`--referrer <address>` global flag** for OptionBook referral attribution.
  Previously no flag existed anywhere, so every CLI fill went on-chain with the
  zero address. Resolution order matches the other settings: `--referrer`, then
  `THETANUTS_REFERRER`, then `referrer` in the config file. Settable with
  `thetanuts config set referrer 0x...` and via `thetanuts setup`.
  `book fill` warns on stderr when no referrer resolves, so the loss is not
  silent. Unrelated to RFQ's numeric `--referral-id`.
- **`book check` reports structure liquidity.** New fields: `structureMatches`
  (live multi-leg orders carrying the requested strike, cheapest first, each
  with a runnable `nextStep`), `liveExpiries`, `didYouMean` (listed expiries on
  the same UTC date — never auto-applied, since the book carries both 03:00Z
  and 08:00Z expiries on some dates), and `cliExecutable`. `recommendation`
  keeps its existing `orderbook` / `rfq` values, so existing consumers are
  unaffected.
- **`book fill` receipts surface `referrer` and `referralFeePaid`** from the
  `OrderFilled` event, so a fill's attribution can be audited without decoding
  the receipt on a block explorer.
- **`scripts/verify-book-fixes.ts`** — end-to-end verifier for the above,
  deriving every strike and expiry from the live book at run time. All fills
  run `--dry-run`.

### Changed

- Multi-leg tickers now name the structure:
  `BTC-28AUG26-67000/68000/69000/70000-RANGER` instead of a bare `-C`/`-P`
  suffix. Single-leg tickers are unchanged.

## [0.2.0] — 2026-08-19

Correctness release for the OptionBook and RFQ paths. Several fixes change
displayed numbers and command behavior, so read the Changed/Removed sections
before upgrading automation.

### Fixed

- **OptionBook premiums were displayed 100x too high, and contract counts
  100x too low.** `book preview` / `book fill` divided `pricePerContract` by
  the collateral token's decimals (6) instead of the protocol's fixed 8-decimal
  price scale, and divided contract quantities by 1e8 instead of the 6-decimal
  contract scale. `book check` separately reported maker collateral as if it
  were a contract count; it now uses the SDK's structure-aware
  `calculateMaxContracts`.
- **`book preview` overstated the premium when maker liquidity capped the
  fill.** The SDK echoes the requested spend ceiling back as `totalCollateral`
  when one is supplied; the CLI now recomputes the premium for the contracts
  that will actually be filled. Approvals are sized to the ceiling of that
  value so a fill cannot revert on a one-unit rounding difference.
- **`book fill` could re-resolve the wrong order just before broadcast.**
  Odette reuses nonces across batches, so `(maker, nonce)` is not a unique
  identity; the pre-broadcast freshness check now matches the exact EIP-712
  signature.
- **RFQ vanilla calls were built with an invalid collateral/implementation
  pairing.** The SDK selects a vanilla CALL implementation without considering
  collateral, so a USDC vanilla call produced a USDC + `INVERSE_CALL` request
  that no maker could fill. Vanilla ETH calls now require explicit
  `--collateral-token WETH` and route to `INVERSE_CALL`; every other structure
  stays USDC. Saved build artifacts with the old pairing are rejected rather
  than silently migrated.
- **RFQs could be mined already expired.** `offerEndTimestamp` is an absolute
  stamp fixed at build time, and an ERC-20 approval plus two confirmation
  prompts routinely consumed the whole 45-second window. Both `rfq request`
  and `position close` now restamp the deadline immediately before broadcast.
  `position close` additionally rejects, up front, a close whose option expires
  within the offer window, so a doomed request cannot burn an approval first.
- **`rfq build` threw when no RFQ key was present.** Encoding requires a
  compressed public key; a keyless build now emits the request plus an
  `encodingNote` instead, and `rfq request` stamps the key before broadcast.
- **`rfq accept` could submit an offer above the RFQ's fixed buyer reserve.**
  A buyer cannot top up an existing RFQ, so such an offer always fails on
  chain; it is now rejected locally with exit 4.
- **`position payout` demanded a signer for a read-only inspection** and
  flattened every error to exit 1. It no longer requires a signer, and exit
  codes propagate (pre-expiry is exit 4, expired-OTM is exit 0).
- **Table output truncated addresses, tx hashes, and RFQ public keys.**
  Addresses (42 chars), hashes (66), and compressed public keys (68) now
  always render whole; only larger blobs collapse, and they keep a
  `(N chars)` length suffix. Key/value tables wrap to the terminal instead of
  overflowing it.

### Added

- **`position close` supports WETH-collateralized positions.** Reserve pricing
  is now exact bigint arithmetic, so 18-decimal amounts — which exceed
  `Number.MAX_SAFE_INTEGER` — no longer round-trip through a float. MM quotes
  resolve in collateral terms, so an inverse call prices in ETH rather than USD.
- `wallet balance` reports the native ETH balance alongside ERC-20 tokens, and
  accepts `--token ETH`.
- `book orders` shows `implementation` and `settlement` columns.
- A successful `book fill` decodes the `OrderFilled` event and renders the
  created option address, ticker, buyer/seller, premium paid, protocol fee, and
  a ready-to-run `position info` command.
- `book check --direction sell` routes to RFQ with a concrete next command
  instead of recommending an unimplemented `book preview` path.
- `position list` shows a `structure` column.
- Regression tests for book eligibility and RFQ implementation routing, wired
  to `npm test`.

### Changed

- **`book orders`, `book preview`, `book check`, and `book fill` now show only
  executable orders**: cash-settled, USDC-collateralized maker asks. Physical
  implementations, non-USDC collateral, maker bids, expired orders, and
  zero-liquidity orders are excluded. `book orders` previously listed orders
  the CLI could not fill.
- **`--scenarios` labels WETH payouts in ETH.** Inverse-call payoffs are
  denominated in the underlying; they were previously printed with a `$`
  prefix, overstating them by roughly the spot price.
- `position payout` is documented and described as an inspection command. On
  r12 the factory settles automatically and pays the holder directly; there is
  no user-callable `claim()`. Its dry-run `action` field changed from `payout`
  to `inspect-automatic-payout`.
- `--collateral-amount` is denominated in the selected collateral token rather
  than always USDC.

### Removed

- **`book fill --order-index` no longer performs live fills.** Book indices
  shift as orders fill and cancel, so the flag is accepted only with
  `--dry-run`; live fills require the stable selector flags
  (`--underlying`, `--type`, `--strike`/`--strikes`, `--expiry`) and exit 2
  otherwise.
- **Vanilla BTC CALL RFQs are rejected.** They previously produced a broken
  USDC inverse-call request. BTC inverse calls need cbBTC collateral, which the
  CLI does not expose yet.

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
