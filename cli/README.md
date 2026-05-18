# thetanuts CLI

TypeScript CLI for Thetanuts Finance V4 on Base (chainId 8453). Browse the orderbook, query market pricing, fill orders, manage option positions — from a terminal or as a JSON API for scripts and agents.

> **v0.1 — early release.** The trading surface (`book fill`, `position payout`, `rfq request/cancel/accept/settle`) is wired and dry-run verified, but always test with `--dry-run` and tiny amounts before sending real transactions. Start with a dedicated wallet, not your main funds wallet.

## Install

### From this repository (today, dev)

```sh
git clone https://github.com/Thetanuts-Finance/thetanuts-sdk.git
cd thetanuts-sdk
npm install && npm run build       # build the parent SDK once
cd cli
npm install && npm run build       # build the CLI
npm link                           # exposes `thetanuts` on PATH
thetanuts --help
```

`npm link` symlinks the freshly-built `dist/index.js` into your npm global bin
directory. Re-run `npm run build` after editing CLI source — the symlink picks
up changes automatically.

### From npm (after publish)

```sh
npm install -g @thetanuts-finance/cli
```

The package is `@thetanuts-finance/cli`; the binary on PATH is `thetanuts`.
The MCP server (a daemon, separate concern) ships as `thetanuts-mcp` from
`mcp-server/`.

Homebrew distribution is not currently planned for v0.1 — `npm install -g` is
sufficient.

## Quick Start

```sh
# No wallet needed — query live data immediately
thetanuts market data
thetanuts chain tokens
thetanuts book orders --underlying ETH --type PUT
thetanuts pricing all --underlying ETH

# Pre-trade liquidity check: should I fill on the orderbook or RFQ this strike?
thetanuts book check --underlying ETH --type PUT --strike 2200 --expiry 1778832000 --direction sell

# JSON output for scripts
thetanuts -o json market data | jq '.prices.ETH'
```

To trade, set up a wallet first:

```sh
# Generate a new wallet (recommended — random key, saved locally)
thetanuts wallet create
# Or import an existing key (interactive, masked prompt)
thetanuts wallet import
# Or run the guided wizard which offers both options
thetanuts setup

# Then approvals + a tiny dry-run before any real fill
thetanuts wallet approve --token USDC --for optionBook --amount 100 --dry-run
thetanuts book fill --order-index 0 --collateral 1 --dry-run
```

## Configuration

Precedence (highest first):

1. `--private-key <key>` flag (and `--rpc-url`) on any invocation
2. Environment variables: `THETANUTS_PRIVATE_KEY`, `THETANUTS_RPC_URL`
3. Persisted config at `~/.config/thetanuts/config.json`

Three ways to create or import a wallet:

```sh
# Option 1 — generate a fresh random wallet (recommended for dedicated trading wallets)
thetanuts wallet create
# Interactive TTY: offers to display the 12-word mnemonic ONCE for paper backup.
# Non-TTY / --yes: saves silently, prints a stern stderr warning that the mnemonic
# was discarded and the config file is the only backup.

thetanuts wallet create --reveal-key      # show key + mnemonic in stdout (gated by confirm)
thetanuts wallet create --force           # overwrite existing key (prints old address)

# Option 2 — import an existing private key (masked input)
thetanuts wallet import

# Option 3 — guided wizard that bundles wallet + RPC setup
thetanuts setup
```

Config file shape (`~/.config/thetanuts/config.json`):

```json
{
  "version": 1,
  "chainId": 8453,
  "rpcUrl": "https://mainnet.base.org",
  "privateKey": "0x...",
  "rfqKeysDir": "~/.config/thetanuts/rfq-keys"
}
```

File permissions: the config file is written with `chmod 600` and the parent
directory `~/.config/thetanuts/` is created with `chmod 700`. If you ever edit
the file by hand, restore those perms with:

```sh
chmod 700 ~/.config/thetanuts
chmod 600 ~/.config/thetanuts/config.json
```

### What needs a wallet vs what doesn't

Read-only (no wallet required):

- `market` — spot prices, protocol stats, indexer positions/history/option
- `pricing` — MM quotes for vanilla and multi-leg options
- `chain` — chain id, contracts, tokens
- `book orders`, `book preview`, `book max-contracts`, `book check`
- `position info`, `position full` (read-only; `position list` needs
  either `--address` or a signer)
- `wallet create`, `wallet import`, `wallet show` — wallet setup (generate
  or import keys; these are how you get a wallet in the first place)
- `keys` — RFQ keypair management subcommands (generate, show, export,
  import, remove). Independent of the signing wallet.
- `rfq quote`, `rfq build`, `rfq get` — quote discovery, off-chain builder, and read views.

Keystore required (no signing wallet needed):

- `rfq offers` — lists OfferMade events for an RFQ and decrypts those
  addressed to the keystore. Needs an RFQ key from `keys ensure`.

Wallet required only when no `--address` is passed:

- `position list` — when no `--address` given, defaults to the signer's positions
- `rfq status` — same: signer is the default address to query the indexer for

Wallet required:

- `wallet balance`, `wallet allowance` (when no `--address` is provided)
- `wallet approve`
- `book fill`
- `position payout`
- `rfq request`, `rfq cancel`
- `rfq accept` (optional — see RFQ section; the protocol auto-settles if
  you do nothing)
- `rfq settle` (post-reveal finalize)

## Output Formats

Every command accepts `-o <fmt>`:

| Format  | Use case                                       |
| ------- | ---------------------------------------------- |
| `table` | Default. Human-readable; ANSI colors on TTY.   |
| `json`  | Scripts and agents. BigInts as decimal strings. |
| `csv`   | List endpoints only (`book orders`, `market history`, etc.). |
| `yaml`  | Config-style readability for runbooks.         |

Same command, two formats:

```sh
$ thetanuts market data
┌────────┬──────────┐
│ key    │ value    │
├────────┼──────────┤
│ ETH    │ 2150.42  │
│ BTC    │ 64210    │
│ ...    │ ...      │
└────────┴──────────┘

$ thetanuts -o json market data
{
  "prices": { "ETH": "2150.42", "BTC": "64210", ... },
  "currentTime": 1747200000,
  "lastUpdated": 1747199997
}
```

Piping works cleanly. EPIPE on stdout is handled, so:

```sh
thetanuts pricing all -o json --underlying ETH | head -5
thetanuts -o json book orders --underlying ETH | jq '.[].pricePerContract'
```

both exit silently with status 0.

Errors emit on stderr by default; pass `--json-errors` for structured JSON
errors on stderr instead. Either way, exit code is non-zero.

**Auto-switch to JSON for deeply-nested payloads.** When you don't pass `-o`
explicitly, these commands default to JSON because table rendering crams
their nested objects into one cell:

- `market stats` — protocol-wide aggregate (totals + 24h/7d/30d + byImplementationType)
- `rfq build` — flat summary + nested `payout` / `params` / `tracking` / `transaction.data`
- `rfq get` — quotation params + state
- `pricing ticker` / `pricing position` / `pricing spread` / `pricing butterfly` / `pricing condor` — nested `byCollateral` per quote

Explicit `-o table` still works on any of them.

### Exit codes

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| `0`  | Success                                                              |
| `1`  | Generic error (network, RPC, contract revert) — also `keys show` when no RFQ key is stored |
| `2`  | Usage error (bad flags, missing required arg)                        |
| `3`  | Confirmation refused / dry-run aborted                               |
| `4`  | Config / wallet / keyfile error, or RFQ build validation: `--contracts` / `--collateral-amount` mutex, BUY without `--reserve-price`, stale offer deadline, strike-ordering / butterfly-equidistance / condor-equal-width / iron-condor-overlap, WETH collateral on a non-CALL structure |
| `5`  | Chain unsupported (reserved — no current command reaches this)       |
| `6`  | RFQ crypto error (stored key corrupted, decrypt key mismatch, `keys export` with no key, `keys show` with corrupt stored key) |

## Commands

Run `thetanuts <group> --help` for a group's subcommands, or
`thetanuts <group> <subcommand> --help` for flags on a specific subcommand.

### `setup` — first-run wizard

Interactive: set the Base RPC URL and import a private key. Writes to
`~/.config/thetanuts/config.json` with `chmod 600`. Base only
(chainId 8453).

```sh
thetanuts setup
```

### `config` — inspect and edit persisted config

```sh
thetanuts config show                         # private key masked
thetanuts config path
thetanuts config set chainId 8453
thetanuts config validate                     # checks RPC + key still work
```

### `chain` — chain metadata

```sh
thetanuts chain info                          # chainId, RPC, contracts
thetanuts chain tokens                        # 8 supported tokens
thetanuts chain contracts                     # contract addresses
```

### `wallet` — create/import wallets, balances, approvals, transfers

```sh
# Wallet setup
thetanuts wallet create                       # generate fresh, save locally, optional paper backup
thetanuts wallet create --reveal-key          # also print key + mnemonic (gated by confirm)
thetanuts wallet create --force               # overwrite existing (prints old address)
thetanuts wallet import                       # interactive masked-input prompt for an existing key
thetanuts wallet show                         # address + source + config path
thetanuts wallet reset                        # delete the config file (prompts for confirmation)

# Balances + allowances
thetanuts wallet balance                      # all configured tokens
thetanuts wallet balance --token USDC
thetanuts wallet allowance --token USDC --for optionBook       # preset spender
thetanuts wallet allowance --token USDC --spender 0x...        # or pass an explicit address

# Writes
thetanuts wallet approve --token USDC --for optionBook --amount 100
```

Flags for `wallet create`:

| Flag             | Meaning                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `--force`        | Overwrite an existing key without prompting. Stderr warning names the old address being destroyed. |
| `--reveal-key`   | After saving, also print the private key + 12-word BIP-39 mnemonic to stdout. Gated by a confirm prompt that warns about scrollback. |
| `--yes`          | Auto-confirm prompts. The post-save "mnemonic discarded" stderr warning still fires.          |
| `--dry-run`      | Beats `--reveal-key --yes` for the reveal prompt — key is never printed under `--dry-run`.    |

Flags for `wallet approve`:

| Flag                     | Meaning                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `--token <sym>`          | Token symbol (USDC, WETH, cbBTC, etc.).                            |
| `--spender <addr>`       | Explicit spender address.                                          |
| `--for <name>`           | Alternative: `optionBook` or `optionFactory` — resolved from chain config. |
| `--amount <max\|n>`      | `max` approves MaxUint256 (WARNING printed). Otherwise a decimal.  |
| `--yes`                  | Skip confirmation prompt.                                          |
| `--dry-run`              | Emit calldata, do not broadcast.                                   |

### `market` — live market reads

```sh
thetanuts market data                          # spot prices + lastUpdated
thetanuts market stats                         # protocol-wide stats (defaults to JSON; payload is deeply nested — pass -o table to flatten)
thetanuts market positions --address 0x...     # indexer positions for any address
thetanuts market history --address 0x...       # trade history (realized P&L source)
thetanuts market option --address 0x...        # indexer detail for an option contract
```

### `pricing` — market-maker quotes

```sh
thetanuts pricing all --underlying ETH                                  # all quotes, sorted
thetanuts pricing ticker --ticker ETH-16FEB26-1800-P                    # single quote
thetanuts pricing position --ticker ETH-16FEB26-1800-P --contracts 6 \
                          --collateral-token USDC --long                # premium + collateral cost
thetanuts pricing spread    --underlying ETH --strikes 1800,2000      --expiry 1771228800 --type put
thetanuts pricing butterfly --underlying ETH --strikes 1700,1800,1900 --expiry 1771228800 --type call
thetanuts pricing condor    --underlying ETH --strikes 1600,1700,1800,1900 --expiry 1771228800 --type iron
```

### `book` — OptionBook orderflow

```sh
# Reads + pre-trade analysis
thetanuts book orders --underlying ETH
thetanuts book preview --order-index 0 --collateral 1
thetanuts book preview --order-index 0 --collateral 1 --scenarios   # adds 5-row payoff table
thetanuts book max-contracts --order-index 0
thetanuts book check --underlying ETH --type PUT --strike 2200 --expiry 1778832000 --direction sell

# Write (broadcast — use --dry-run first)
thetanuts book fill --order-index 0 --collateral 1 --dry-run
thetanuts book fill --order-index 0 --collateral 1 --dry-run --scenarios
```

`book preview` and `book fill --dry-run` both emit a `payout` block
(`totalPremium` / `maxLoss` / `maxGain` / `note`) from
`cli/src/payout.ts::computePayoutSummary`. Book fills are always BUY (the
filler buys the option from the maker), so `maxLoss = totalPremium` and
`maxGain = totalIntrinsic − totalPremium` where `totalIntrinsic` comes from
`calculateCollateralRequired(1, product, strikes) × contracts`.

`--scenarios` adds a 5-row table walking representative spot prices at
expiry (vanilla: 0.9× → 1.025× strike for PUT, 0.975× → 1.10× for CALL;
multi-leg: `min(strikes)×0.95 → max(strikes)×1.05` with the strikes
themselves as anchor rows). Each row prints `payoutPerContract`,
`totalPayout`, and `netPnl`. The payoff formulas live in
`cli/src/payout.ts::payoffPerContract`.

`book check` is a deterministic port of OpenClaw's pre-trade liquidity
analyzer. It returns matching orderbook orders + best price + available
size + partial-fill availability + nearby strikes within 5% + a
recommendation (`orderbook` vs `rfq`) with reason. Useful before a
`book fill` or an `rfq request`.

Flags for `book fill`:

| Flag                       | Meaning                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `--order-index <n>`        | Position in the live order book (0-indexed).                       |
| `--collateral <n>`         | USDC amount to spend on premium (e.g. `--collateral 1` for $1). The CLI derives the number of contracts from the order's price-per-contract automatically. Omit to fill the maximum available. |
| `--approve-amount <val>`   | Approve mode if allowance is insufficient. Default: exact (approves only what's needed). `max` approves MaxUint256 (WARNING printed). `<number>` approves a specific amount. |
| `--yes`                    | Skip both prompts (approval and fill).                             |
| `--dry-run`                | Emit `{ approve, fill }` calldata, do not broadcast.               |

`--dry-run` always emits both the `approve` and `fill` calldata blocks
regardless of current allowance, so you can inspect or hand off both
transactions without first granting an allowance on-chain.

### `position` — owned option management

```sh
thetanuts position list                                  # all your open positions (book + rfq merged)
thetanuts position list --source book                    # only positions from OptionBook fills
thetanuts position list --source rfq                     # only positions from RFQ settlements
thetanuts position info --address 0x...                  # decoded terms (strikes, expiry, type, collateral, underlying)
thetanuts position full --address 0x...                  # full on-chain math (numContracts, collateral, fees)
thetanuts position payout --address 0x... --dry-run      # post-expiry: claim payout (dry-run first)
thetanuts position calc-payout --type call --strikes 2000 --price 2150 --contracts 1
```

**`position list` columns (table mode):**

| Column | Meaning |
|---|---|
| `id` / `optionAddress` | The option contract's address (Base mainnet) |
| `source` | `book` (filled via OptionBook), `rfq` (settled via OptionFactory), or `book+rfq` (cross-listed). `--source book\|rfq\|all` filters; default `all` fetches both indexers in parallel and dedupes by lowercased `optionAddress`. |
| `side` | `buyer` (long) or `seller` (short) |
| `createdAt` | ISO timestamp the position was minted (from `entryTimestamp`); `—` if `entryTimestamp == 0n` |
| `expiry` | ISO date the option expires |
| `contracts` | Position size as a human decimal (e.g. `0.001505`), `amount ÷ 10^collateralDecimals` |
| `premium` | Total premium paid (BUY) or received (SELL): `entryPrice ÷ 10^collateralDecimals` with a `$` prefix and the collateral symbol — matches the dApp's option-book PositionsTable (`Number(pos.entryPrice) / 10 ** decimals`). |
| `pnl` | `+$X.XX (+Y.Y%)` / `-$X.XX (-Y.Y%)` when resolvable, else `—` |

**PnL is tiered** — mirrors the dApp's options-dashboard route (`adaptOptionBookPosition.ts:74-89` + `mapApiPositionToEnriched.ts:317-338`):

1. **Tier 1 [indexer]** — `pos.pnlEntries[side].pnlUsd` (8-decimal USD), pre-computed by the indexer's settlement worker.
2. **Tier 2 [indexer]** — top-level `pos.pnlUsd` / `pos.pnlPct` (some payloads only populate this).
3. **Tier 3 [mtm]** — fan-out fetch of MM pricing (`mmPricing.getTickerPricing`/`getSpreadPricing`/`getButterflyPricing`/`getCondorPricing`), then `calculateBuyerPnL` / `calculateSellerPnL` — native-Number ports of the dApp's `pnlCalculations.ts:75-141`. Skipped for dead positions (settled / expired). A stderr advisory fires if fan-out exceeds 2s.
4. **Tier 4 [unavailable]** — column shows `—`.

The table mode does NOT show which tier produced the number — users don't care. Scripts that care can read `pnlSource` from `-o json` (always present: `"indexer"` | `"mtm"` | `"unavailable"`).

`-o json` byte-stable: existing `amount`, `entryPrice`, `currentValue`, `pnl` fields stay (raw decimal strings). Additive fields: `sources` (e.g. `["book"]`), `entryTimestamp` (unix seconds string), `implementationName`, `implementationType`, `pnlSource`, and `pnlUsd`/`pnlPct` when populated. For Tier 1/2 the original 8-decimal `pnlUsd` string is preserved; for Tier 3 it's a 2-dp formatted USD string. Scripts consuming the indexer fields keep working unchanged.

**`position info` decoded fields** (table mode):

| Field | Display |
|---|---|
| `optionType` | Decoded label (`PUT (vanilla, american, cash)`, `CALL (vanilla)`, etc.) with the raw uint preserved in `optionTypeRaw` |
| `strikes` | Human USD (`2025 USD`); raw 8-decimal Chainlink-scale array in `strikesRaw` |
| `expiry` | Unix ts + ISO date (`1779177600 (2026-05-19T08:00:00.000Z)`) |
| `collateralToken` | Symbol + address (`USDC (0x833589...)`) |
| `underlyingToken` | Derived from the option's Chainlink price feed (`ETH (derived from priceFeed)`) — BaseOption has no on-chain `underlyingToken()` getter, so this is computed CLI-side |
| `priceFeed` | Chainlink feed address used for settlement |

The previous `implementation` / `implementationName` / `implementationType` rows were dropped from the table — they were redundant noise once `optionType` decodes to a readable label, and rendered empty when the on-chain decoder failed. `-o json` keeps the raw `optionType` uint for scripts.

Flags for `position info`:

| Flag                | Meaning                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `--address <addr>`  | Option contract address.                                         |

Flags for `position list`:

| Flag                  | Meaning                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--address <addr>`    | Wallet address to query (defaults to signer)                                                                  |
| `--source <src>`      | `book` \| `rfq` \| `all` (default `all`). Fetches both indexers in parallel and dedupes by `optionAddress`. RFQ-side failure degrades to stderr warning + book-only output. |

### `keys` — ECDH keypair management for sealed-bid RFQ

The RFQ workflow uses a sealed-bid auction. Makers encrypt offer amounts
to the requester's compressed public key (ECDH + AES-256-GCM); only the
requester's matching private key can decrypt them. The `keys` group
manages that keypair — one keypair per chain, persisted under
`<config-dir>/rfq-keys/` with `chmod 700` on the directory and `chmod
600` on the key file.

```sh
thetanuts keys ensure                          # generate + persist (or load existing) — recommended first step
thetanuts keys generate                        # in-memory only, does NOT persist (use `ensure` to store)
thetanuts keys show                            # public key + storage path (NEVER the private key)
thetanuts keys export --out ~/rfq-key-backup.key
thetanuts keys import --in ~/rfq-key-backup.key
thetanuts keys remove --force                  # destroy the key (strands every prior RFQ — back up first!)
```

| Subcommand        | Exit codes                                                        |
| ----------------- | ----------------------------------------------------------------- |
| `keys ensure`     | 0 success (newly created or already present) / 1 internal error  |
| `keys generate`   | 0 success / 1 internal error (in-memory only)                     |
| `keys show`       | 0 found / 1 no key / 6 stored key is corrupted                    |
| `keys export`     | 0 success / 3 refused / 6 no key stored / 1 fs error              |
| `keys import`     | 0 success / 3 overwrite refused / 4 bad file or invalid key       |
| `keys remove`     | 0 success / 3 refused (no `--force`, no `--yes`)                  |

Storage layout (one file per chain; the CLI is Base-only, chainId 8453):

```
~/.config/thetanuts/rfq-keys/                  ← directory, mode 0o700
└── thetanuts_rfq_key_8453.key                 ← Base, mode 0o600
```

Override the directory by adding `"rfqKeysDir": "/path/to/keys"` to your
config.json, or by passing `--config /other/path.json` (the keystore
follows the config file's parent directory).

**Loss consequences.** If you delete the keystore for a chain, every
encrypted offer that was ever sent to your public key for that chain
becomes undecryptable — they cannot be recovered. Always run
`keys export --out <backup-path>` before doing anything destructive,
and treat the resulting file like the wallet itself.

`keys export` and `keys import` refuse `--out -` / `--in -` on purpose:
private-key material must never land in stdin/stdout where shell
scrollback, pipe targets, or log capture could persist it.

### `rfq` — Request-for-Quotation lifecycle (requester side)

Full requester lifecycle in 9 subcommands: `quote` → `build` → `request` →
`get` → `offers` → `accept` (optional) → `cancel` → `settle` → `status`. The
maker side (encrypt + sign + submit an offer) is intentionally out of scope —
real makers run dedicated MM bots, and OpenClaw is also requester-only.

**`rfq build` vs `rfq request` — which one do I run?**

| Command | What it does | RPC writes? | When to use |
|---|---|---|---|
| `rfq quote` | Lists live MM-quoted strikes & expiries for an underlying. **Vanilla only** — passing a multi-leg `--type` (SPREAD/FLY/CONDOR/IRON) returns an actionable error pointing at `pricing spread/butterfly/condor`. | No | First step — pick legs from the vanilla grid. |
| `rfq build` | Constructs the RFQ request object off-chain. Validates strike ordering / butterfly equidistance / condor equal-width / iron-condor non-overlap. Fetches MM ask price (for BUY `--collateral-amount` without `--reserve-price`), derives `numContracts`, computes the `payout` block. Defaults to `--deadline-minutes 0.75` (45s). Optionally saves to a file with `--out`. | No (read-only network calls only) | Inspect the calldata, payout, and on-chain shape before committing. Useful for review, scripting, or saving an artifact to submit later. |
| `rfq request` | Same as `rfq build`, **plus broadcasts** `requestForQuotation` on-chain. Auto-stamps the requester public key, escrows your `reservePrice` (BUY) or earmarks collateral (SELL), returns a `quotationId`. BUY hard-blocks with exit 4 when allowance < reservePrice (the contract escrows at request time). | **Yes** — costs gas + escrow | The actual submission. |

In short: **`rfq build` is the dry-run inspector**; **`rfq request` is the broadcast**. They share all the same flags (sizing, structure, expiry, deadline, etc.); `request` adds keystore handling + on-chain submission + the quotationId-extraction post-broadcast.

**Simplest end-to-end flow for a new user:**

```sh
# 1. Discover what's tradeable
thetanuts rfq quote --underlying ETH --type put

# 2. Pick a strike/expiry from the output, then submit. CLI auto-derives
#    contracts + reservePrice from live MM ask; no need to know either.
thetanuts rfq request --underlying ETH --type PUT --strike 2000 \
  --expiry 1779177600 --collateral-amount 0.01 --direction buy

# → prints quotationId. The protocol auto-settles when the deadline expires
#   (default 0.75 min = 45 seconds). Walk away. Come back:

# 3. Check if you got filled
thetanuts rfq status --ticker ETH-19MAY26-2000-P --since <unix-of-request>
# Exit 0 = filled (position appears in `position list`). Exit 1 = no fill (escrow already refunded by auto-settle).
```

You do NOT need to manually call `rfq settle`, `rfq accept`, or watch `rfq offers` for the typical happy path — the deadline + auto-settle handle it. Use those commands only for active offer-management.

```sh
# 0. Discover what's tradeable. The MM publishes live quotes for a specific
#    grid of expiries × strikes; pick from this list.
#    NOTE: `rfq quote` is vanilla-only by design — the MM publishes a single-strike
#    grid, not multi-leg structures. Passing `--type SPREAD/FLY/CONDOR/IRON`
#    triggers an actionable error that points you to `pricing spread/butterfly/condor`.
thetanuts rfq quote --underlying ETH --type put           # all PUTs the MM is pricing
thetanuts rfq quote --underlying ETH --expiry 1779177600  # all strikes for one expiry
thetanuts rfq quote --underlying ETH -o json | jq '.[] | {ticker, ask, mark}'

# 1. Build an RFQRequest off-chain. Multi-leg structures auto-detected
#    from --strikes count.
#    Sizing: pass EITHER --contracts (direct count) OR --collateral-amount
#    (USDC budget for BUY / collateral deposit for SELL; CLI derives contracts).
#    For BUY: if you omit --reserve-price, the CLI fetches the MM's live
#    ask price and uses it as the per-contract ceiling automatically.
thetanuts rfq build --underlying ETH --type PUT --strike 2000 \
  --expiry 1779177600 --collateral-amount 0.01 --direction buy           # auto-derives reserve from MM
thetanuts rfq build --underlying ETH --type PUT --strikes 2050,2000 \
  --expiry 1779177600 --collateral-amount 1 --direction sell             # PUT_SPREAD sell (offline)
thetanuts rfq build --underlying ETH --type CALL --strikes 2000,2050,2100 \
  --expiry 1779177600 --contracts 0.1 --direction buy --reserve-price 5  # direct --contracts (offline)
thetanuts rfq build --underlying ETH --type PUT --strikes 1800,1900,2100,2200 \
  --expiry 1779177600 --collateral-amount 1 --direction sell \
  --structure iron-condor                                                # IRON_CONDOR sell (offline)

# `rfq build` output includes a `payout` block with totalPremium / maxLoss /
# maxGain / collateralLocked (sell side) / note — computed by
# `cli/src/payout.ts::computePayoutSummary` from the actual MM ask price (BUY)
# or structure-aware max-loss math (SELL). Pass `--scenarios` for an
# additional 5-row (spotAtExpiry, payoutPerContract, totalPayout, netPnl) table.

# Save a build artifact for later reuse
thetanuts rfq build --underlying ETH --type PUT --strike 2000 \
  --expiry 1779177600 --collateral-amount 0.01 --direction buy --out /tmp/build.json

# Inspect a quotation by ID
thetanuts rfq get --id 42

# 2. Submit an RFQ. Auto-stamps requesterPublicKey from the RFQ keystore
#    (creates one if missing — or run `thetanuts keys ensure` ahead of time).
#    For BUY without --reserve-price, `rfq request` re-fetches MM pricing
#    every invocation so submission uses the freshest quote — not a stale
#    price snapshotted at `rfq build` time.
#    Always dry-run first.
thetanuts rfq request --underlying ETH --type PUT --strike 2000 \
  --expiry 1779177600 --collateral-amount 0.01 --direction buy --dry-run
thetanuts rfq request --underlying ETH --type PUT --strike 2000 \
  --expiry 1779177600 --collateral-amount 0.01 --direction buy
thetanuts rfq request --from-build-file /tmp/build.json --dry-run

# For SHORT (--direction sell) requests, optionally ensure collateral
# allowance to the OptionFactory at request time:
thetanuts rfq request --underlying ETH --type PUT --strike 2000 \
  --expiry 1779177600 --collateral-amount 1 --direction sell \
  --ensure-allowance --approve-amount max

# BUY allowance gate: the OptionFactory escrows reservePrice at request time,
# so a BUY request hard-blocks (exit code 4) when allowance < reservePrice.
# Either pre-approve, or pass --ensure-allowance to approve in-flow.

# Cancel an RFQ you created (only the original requester can cancel)
thetanuts rfq cancel --id 42 --dry-run
thetanuts rfq cancel --id 42
```

**Sizing flag rules:**

- `--contracts <n>` and `--collateral-amount <n>` are **mutually exclusive** — pass exactly one.
- `--collateral-amount` on `--direction buy`:
  - If `--reserve-price` is passed: pure offline math (`contracts = budget / reserve`).
  - If `--reserve-price` is omitted: CLI fetches the live MM ask via `mmPricing` (vanilla → `getTickerPricing`; spread → `getSpreadPricing`; butterfly → `getButterflyPricing`; condor/iron → `getCondorPricing`). Vanilla uses `byCollateral[asset].mmAskPriceBuffered` (matches the dApp); multi-leg uses `netMmAskPrice`. For USDC collateral, `premiumPerContract = mmAsk × spot`; for WETH collateral (INVERSE_CALL family), `premiumPerContract = mmAsk` (already in underlying). Then `contracts = budget / premiumPerContract` and the per-contract reserve is stamped into the build inputs. Fails with exit code 4 if the MM isn't pricing that strike/expiry — run `rfq quote` first to see what's live.
- `--collateral-amount` on `--direction sell` is fully offline: calls `calculateNumContracts({ tradeAmount, product, strikes, isBuy: false })` from `src/utils/rfqCalculations.ts:242-328`, which dispatches on product (PUT → `tradeAmount / strike`; CALL_SPREAD/PUT_SPREAD → `tradeAmount / |K_hi − K_lo|`; CALL_FLY/PUT_FLY/CALL_CONDOR/PUT_CONDOR → `tradeAmount / wingWidth`; IRON_CONDOR → `tradeAmount / max(putSpread, callSpread)`; INVERSE_CALL → `tradeAmount` 1:1).
- On-chain reservePrice = `numContracts × per-contract-reserve × 10^collateralDecimals`, which collapses to the user's `--collateral-amount` value (in token decimals) by construction in the BUY-without-reserve path.

**Structure validators** (run client-side before the SDK builder; exit code 4 on failure):

- `validateStrikeOrdering` — PUT spreads/flies/condors descending, CALL ascending, condor/iron-condor always ascending.
- `validateButterfly` (`src/utils/rfqCalculations.ts:71-92`) — requires exactly 3 strikes; sorted wings must be equidistant within `FLOAT_TOLERANCE = 0.0001`.
- `validateCondor` (`src/utils/rfqCalculations.ts:102-124`) — requires exactly 4 strikes; sorted outer spreads (`s1−s0`) and (`s3−s2`) must be equal within tolerance.
- `validateIronCondor` (`src/utils/rfqCalculations.ts:134-151`) — requires exactly 4 strikes [putLower, putUpper, callLower, callUpper]; the put and call legs must not overlap (`putUpper <= callLower`).
- WETH collateral is rejected for everything except single-strike CALL (INVERSE_CALL impl) and 2-strike CALL (INVERSE_CALL_SPREAD impl) — other inverse implementations are not deployed.

**Number alignment guarantees (matches OpenClaw `build-rfq.ts` verbatim):**

| Constant                                | Value                              |
| --------------------------------------- | ---------------------------------- |
| Default offer deadline                  | 0.75 minutes (45 seconds)          |
| Single-strike CALL default collateral   | WETH (INVERSE_CALL)                |
| All other structures default collateral | USDC                               |
| PUT spread/fly strike ordering          | DESCENDING (high → low)            |
| CALL spread/fly strike ordering         | ASCENDING (low → high)             |
| Condor / iron condor strike ordering    | ASCENDING (always)                 |
| Placeholder requester when no signer    | `0x0000…0001`                      |

The CLI runs `validateStrikeOrdering` locally before the SDK builder, so
ordering violations exit cleanly with code 4 and an OpenClaw-style error
message — no RPC round-trip required.

**Offer flow:**

```sh
# List every offer submitted to an RFQ. Reads from the indexer's RFQ detail
# endpoint (`client.api.getRfq(id) → offers[offeror]`), which already returns
# revealedAmount for accepted/rejected/revealed offers. Falls back to a
# bounded on-chain OfferMade log scan ONLY if the indexer is unreachable.
# Decrypts encrypted offers using the keystore where possible; rows tagged
# with amountSource = "indexer" | "decrypted" | "logs".
thetanuts rfq offers --id 42

# Accept a specific offer (OPTIONAL — see disclaimer below). Same indexer-
# backed flow as `rfq offers`: pulls `rfq.offers[offeror]`, decrypts the
# encrypted blob locally, recovers (offerAmount, nonce), then submits
# settleQuotationEarly. The skip-decrypt mode lets you pass both values
# explicitly when you already have them (e.g. recorded from a previous
# `rfq offers` run); the CLI then never touches the keystore.
thetanuts rfq accept --id 42 --offeror 0xMakerAddress --dry-run
thetanuts rfq accept --id 42 --offeror 0xMakerAddress
thetanuts rfq accept --id 42 --offeror 0xMakerAddress \
  --offer-amount 420000 --nonce 1234567890                  # skip-decrypt
```

> **Disclaimer — `rfq accept` is optional.** If you do nothing, the
> protocol settles automatically once the offer window closes (anyone
> can then call `rfq settle` to finalize, and the contract picks the
> winner from on-chain reveals). Use `rfq accept` only when you want
> to lock in a *specific* maker's offer early via
> `settleQuotationEarly`. The auto-settle path is fine for most users.

Errors that don't fit exit-code-1:
- Exit 4 — no `OfferMade` event matches the `--offeror`
- Exit 6 — the matching offer can't be decrypted (key mismatch, wrong chain,
  or you never were the requester for this RFQ)

**Settle + status:**

```sh
# Anyone can settle after the reveal window closes
thetanuts rfq settle --id 42 --dry-run
thetanuts rfq settle --id 42

# Detect whether an RFQ was filled by walking the indexer for a matching
# position ticker (port of OpenClaw scripts/check-rfq-fill.ts).
# Exit code 1 if no matching position found.
thetanuts rfq status --ticker ETH-29MAR26-1900-P --since 1779000000
thetanuts rfq status --ticker ETH-29MAR26-1900/1800-P --since 1779000000 \
  --address 0xRequesterAddress
```

The CLI's requester-side `rfq` surface is complete end-to-end: request →
listen for offers → (optionally accept) → settle → check status. The maker
side (encrypt + sign + submit an offer, then reveal post-deadline) is
intentionally NOT in the CLI — real RFQ makers run dedicated MM bots with
their own signing infrastructure, which is also why OpenClaw is
requester-only.

Groups still entirely unimplemented: `loan`, `ranger`, `events`, `watch`,
`wheel`, `vault`. The last three are deferred per design.

## Common Workflows

### 1. Browse and research before trading

```sh
thetanuts market data
thetanuts book orders --underlying ETH --type PUT
thetanuts pricing all --underlying ETH
thetanuts book preview --order-index 0 --collateral 1
```

### 2. First-time wallet setup and approvals

```sh
# Pick one — all three end up with a wallet in ~/.config/thetanuts/config.json
thetanuts wallet create        # generate fresh, paper-backup the mnemonic
thetanuts wallet import        # paste an existing private key
thetanuts setup                # guided wizard: wallet + RPC in one flow

thetanuts wallet show
thetanuts wallet balance
thetanuts wallet approve --token USDC --for optionBook --amount 100
```

### 3. Fill an order with dry-run preview, then real fill

```sh
thetanuts book fill --order-index 0 --collateral 1 --dry-run
# Inspect the { approve, fill } calldata. When happy:
thetanuts book fill --order-index 0 --collateral 1
```

### 4. Inspect a position you own

```sh
thetanuts position list
thetanuts position info --address 0xYourOption...
thetanuts position full --address 0xYourOption...
```

### 5. Pipe JSON output to scripts

```sh
thetanuts -o json book orders --underlying ETH \
  | jq '.[].pricePerContract'

thetanuts -o json pricing all --underlying ETH \
  | jq '.[] | {ticker, bid, ask, mark}'
```

## Safety

- Every write op runs a preview before prompting — you see the expected
  outcome before signing.
- `--dry-run` always emits encoded calldata without broadcasting (both
  `approve` and `fill` for `book fill`).
- `book fill` re-fetches the live order book between the confirm prompt and
  broadcast, then re-resolves the order by `(maker, nonce)` identity. If the
  order has been filled or repriced since preview, the CLI aborts with a
  clear stderr message instead of broadcasting a tx that would revert.
- Every successful write tx (`book fill`, `wallet approve`, `rfq request/cancel/accept/settle`)
  now renders `gasUsed`, `gasPriceGwei`, `feeEth`, and `feeUsd` after the
  receipt. The USD figure is a best-effort estimate from `market data` ETH
  spot; if that lookup fails, only ETH-denominated fields appear.
- Dry-run output (`book fill --dry-run`, `rfq request --dry-run`, `wallet approve --dry-run`)
  truncates long hex calldata (>80 chars) in table mode as
  `0x<selector>…<tail> (N chars)`. The full hex is preserved in `-o json`.
- `--yes` skips prompts. Use it in CI / automation only, never in interactive
  sessions.
- Token approvals are never bundled silently with fills — they require their
  own confirmation prompt.
- `--approve-amount max` (or `wallet approve --amount max`) requires explicit
  opt-in and emits a stderr WARNING. The two paths share a single helper, so
  the WARNING text is byte-identical.

## Architecture

The CLI is a thin wrapper over `@thetanuts-finance/thetanuts-client`. Each
command group lives in one file under `cli/src/commands/`; a registry wires
them into the Commander root.

```
cli/src/
├── index.ts                    Commander root, global flags, EPIPE handler, --version
├── client.ts                   getClient() factory (flag → env → config → default)
├── config.ts                   Load/save ~/.config/thetanuts/config.json (0o600)
├── defaults.ts                 Single source for default chain ID + RPC URLs
├── output.ts                   table / json / csv / yaml renderers; BigInt-safe
├── confirm.ts                  Preview + confirm() + dry-run plumbing (dry-run > yes)
├── options.ts                  Shared Commander option declarations
├── rfqKeyStorage.ts            Filesystem-backed RFQ keystore (0o700/0o600, atomic writes)
└── commands/
    ├── registry.ts             Wires every group's register(program)
    ├── setup.ts                Interactive first-run wizard (create | import | skip)
    ├── config.ts               Inspect/edit persisted config
    ├── chain.ts                Chain metadata
    ├── wallet.ts               Create/import wallets, balances, allowances, transfers
    ├── market.ts               Live market reads
    ├── pricing.ts              MM pricing + ticker math
    ├── book.ts                 OptionBook orderflow + pre-trade liquidity check
    ├── position.ts             Owned option management
    ├── keys.ts                 RFQ ECDH keypair management (generate, ensure, export, import, etc.)
    └── rfq.ts                  Requester-side RFQ: builders, encoders, reads, request/cancel/accept/settle/status. Maker side is out of scope (MM bots only).
```

Roadmap: groups still entirely unimplemented are `loan`, `ranger`,
`events`, `watch`, `wheel`, `vault` (the last three are deferred per
user direction). Some SDK methods worth surfacing in a future commit:
`optionFactory.withdrawFees` (lets referral owners claim accrued fees),
`api.getUserRfqs` / `getRfq` / `getUserOffersFromRfq` (state-API
listings for RFQ tracking), and `optionFactory.getOfferSignature` (read
an offer's on-chain signature). See `cli/rfq_design.md` and
`todo_cli.md` §5 / §13 for the full pending-work map.

For the full spec, see `cli/PRD.md` (working doc, gitignored).

## License

MIT
