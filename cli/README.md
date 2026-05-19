# Thetanuts CLI

TypeScript CLI for [Thetanuts Finance V4](https://thetanuts.finance) options on Base. Browse the orderbook, request quotes, fill orders, manage positions, and run on-chain operations — from a terminal or as a JSON API for scripts and agents.

> **Warning:** This is early, experimental software. Use at your own risk and do not use with large amounts of funds. APIs, commands, and behavior may change without notice. Always run `--dry-run` first, start with a dedicated wallet (not your main funds wallet), and verify transactions before confirming.

> **v0.1 — USDC collateral only.** All trading (book fills, RFQ requests) is denominated in USDC. WETH and cbBTC collateral are planned for a future release.

## Install

### From source (today)

```bash
git clone https://github.com/Thetanuts-Finance/thetanuts-sdk
cd thetanuts-sdk
npm install && npm run build       # build the SDK once
cd cli
npm install && npm run build       # build the CLI
npm link                           # exposes `thetanuts` on PATH
thetanuts --help
```

Re-run `npm run build` inside `cli/` after editing — the symlink picks up changes automatically.

### From npm (after publish)

```bash
npm install -g @thetanuts-finance/cli
```

The package is `@thetanuts-finance/cli`; the binary is `thetanuts`.

## Quick Start

```bash
# No wallet needed — query live data immediately
thetanuts market data
thetanuts chain tokens
thetanuts book orders --underlying ETH --type PUT
thetanuts pricing all --underlying ETH

# Pre-trade check: should I fill on the orderbook or RFQ this strike?
thetanuts book check --underlying ETH --type PUT --strike 2200 --expiry 1778832000 --direction sell

# JSON output for scripts
thetanuts -o json market data | jq '.prices.ETH'
```

To trade, set up a wallet:

```bash
thetanuts setup
# Or manually:
thetanuts wallet create
thetanuts wallet approve --token USDC --for optionBook --amount 100
```

## Configuration

### Wallet Setup

The CLI needs a private key to sign approvals, fills, and RFQ submissions. Three ways to provide it (checked in this order):

1. **CLI flag**: `--private-key 0xabc...` (and `--rpc-url`)
2. **Environment variable**: `THETANUTS_PRIVATE_KEY` (and `THETANUTS_RPC_URL`)
3. **Config file**: `~/.config/thetanuts/config.json`

```bash
thetanuts wallet create             # generate a new random key
thetanuts wallet import             # paste an existing key (masked input)
thetanuts setup                     # guided wizard for both wallet + RPC
thetanuts wallet show               # what's configured
```

The config file (`~/.config/thetanuts/config.json`):

```json
{
  "version": 1,
  "chainId": 8453,
  "rpcUrl": "https://mainnet.base.org",
  "privateKey": "0x...",
  "rfqKeysDir": "~/.config/thetanuts/rfq-keys"
}
```

File permissions are set automatically: `chmod 700` on the directory, `chmod 600` on the file.

### What Needs a Wallet

Most commands work without a wallet — browsing the order book, querying market-maker quotes, inspecting positions by address. You only need a wallet for:

- Filling orders (`book fill`)
- Submitting and managing RFQs (`rfq request`, `rfq cancel`, `rfq accept`, `rfq settle`)
- Token approvals (`wallet approve`)
- Reading your own balances and positions without an explicit `--address`
- Claiming an expired position's payout (`position payout`)

The RFQ workflow also needs a separate ECDH keypair (managed by `keys ensure`) so makers can encrypt offers to you.

## Output Formats

Every command accepts `-o <fmt>`:

| Format  | Use case                                       |
| ------- | ---------------------------------------------- |
| `table` | Default. Human-readable; ANSI colors on TTY.   |
| `json`  | Scripts and agents. BigInts as decimal strings. |
| `csv`   | List endpoints only (`book orders`, `market history`, etc.). |
| `yaml`  | Config-style readability for runbooks.         |

```bash
# Human-readable table (default)
thetanuts market data
```

```
┌────────┬──────────┐
│ key    │ value    │
├────────┼──────────┤
│ ETH    │ 2150.42  │
│ BTC    │ 64210    │
└────────┴──────────┘
```

```bash
# Machine-readable JSON
thetanuts -o json market data
```

```json
{
  "prices": { "ETH": "2150.42", "BTC": "64210" },
  "currentTime": 1747200000,
  "lastUpdated": 1747199997
}
```

Piping works cleanly — EPIPE is handled, so `thetanuts ... | head` exits silently with status 0. Errors emit on stderr by default; pass `--json-errors` for a structured JSON error on stderr. Either way the exit code is non-zero.

### Exit codes

| Code | Meaning |
| ---- | ------- |
| `0`  | Success |
| `1`  | Generic error (network, RPC, contract revert) |
| `2`  | Usage error (bad flags, missing required arg) |
| `3`  | Confirmation refused / dry-run aborted |
| `4`  | Config / wallet / keyfile error, or RFQ validation failure (strike/expiry not in MM grid, bad structure ordering, etc.) |
| `5`  | Chain unsupported (reserved) |
| `6`  | RFQ crypto error (corrupted key, decrypt mismatch, missing key) |

---

## Walkthrough 1 — Fill an order on the OptionBook

End-to-end: from "I have an empty terminal" to "I own an option contract that pays out at expiry."

### Step 1 — Set up a wallet

```bash
thetanuts wallet create
```

Expected output (interactive):

```
✓ generated new wallet
  address: 0x9F8a...c421
  saved to: /Users/you/.config/thetanuts/config.json (chmod 600)

? Show the 12-word mnemonic now for paper backup? Yes
ETH testnet word1 word2 word3 ... word12

⚠  This is the ONLY time the mnemonic is shown. Write it on paper.
   Press Enter to continue.
```

### Step 2 — Fund the wallet

Send a tiny amount of USDC (the trading collateral) plus a few cents of ETH on Base for gas to the address printed above. Bridges and on-ramps that support Base mainnet work fine.

Verify:

```bash
thetanuts wallet balance
```

```
┌────────┬──────────┐
│ token  │ balance  │
├────────┼──────────┤
│ ETH    │ 0.0021   │
│ USDC   │ 25.00    │
└────────┴──────────┘
```

### Step 3 — Approve USDC for the OptionBook

The OptionBook needs an ERC-20 allowance to pull the premium when you fill an order.

```bash
thetanuts wallet approve --token USDC --for optionBook --amount 10 --dry-run
```

Expected output (dry-run):

```
preview: approve 10 USDC to optionBook (0x...)
  calldata: 0x095ea7b3…0007a120 (138 chars)

run again without --dry-run to broadcast
```

When happy, broadcast:

```bash
thetanuts wallet approve --token USDC --for optionBook --amount 10
```

```
? Approve 10 USDC to optionBook (0x...)? Yes
✓ broadcast
  tx: 0xabcd...1234
  gasUsed: 46812  gasPriceGwei: 0.05  feeEth: 0.0000023  feeUsd: $0.005
```

### Step 4 — Browse live orders

```bash
thetanuts book orders --underlying ETH --type PUT
```

```
┌─────┬──────────────────────────┬────────┬─────────┬───────────────┬──────────┐
│ idx │ ticker                   │ type   │ strike  │ pricePerContr │ size     │
├─────┼──────────────────────────┼────────┼─────────┼───────────────┼──────────┤
│ 0   │ ETH-29MAY26-2000-P       │ PUT    │ $2000   │ $42.50        │ 5.0      │
│ 1   │ ETH-29MAY26-2100-P       │ PUT    │ $2100   │ $58.20        │ 3.2      │
│ 2   │ ETH-19JUN26-2000-P       │ PUT    │ $2000   │ $61.10        │ 8.4      │
└─────┴──────────────────────────┴────────┴─────────┴───────────────┴──────────┘
```

### Step 5 — Preview the fill

```bash
thetanuts book preview --order-index 0 --collateral 1 --scenarios
```

```
order: ETH-29MAY26-2000-P (PUT, strike $2000)
fill plan:
  collateral spent:    1.00 USDC
  contracts received:  0.0235
  pricePerContract:    $42.50

payout (cash-settled at expiry):
  totalPremium:  $1.00 (max loss)
  maxGain:       $46.00 (if ETH → 0)
  note: PUT pays max(strike − spot, 0) per contract

scenarios:
┌────────────────┬─────────────────┬──────────────┬──────────────────┐
│ spotAtExpiry   │ payoutPerContr  │ totalPayout  │ netPnl           │
├────────────────┼─────────────────┼──────────────┼──────────────────┤
│ $1800          │ $200.00         │ $4.70        │ +$3.70 (+370%)   │
│ $1900          │ $100.00         │ $2.35        │ +$1.35 (+135%)   │
│ $1950          │ $50.00          │ $1.18        │ +$0.18 (+18%)    │
│ $2000 (strike) │ $0.00           │ $0.00        │ -$1.00 (-100%)   │
│ $2050          │ $0.00           │ $0.00        │ -$1.00 (-100%)   │
└────────────────┴─────────────────┴──────────────┴──────────────────┘
```

### Step 6 — Dry-run the fill

Always run `--dry-run` first to see the actual calldata.

```bash
thetanuts book fill --order-index 0 --collateral 1 --dry-run
```

```
preview: fill order ETH-29MAY26-2000-P
  collateral:        1.00 USDC
  contracts:         0.0235
  pricePerContract:  $42.50

approve calldata:  0x095ea7b3…000f4240 (138 chars)
fill calldata:     0x3593564c…0000000a (842 chars)

run again without --dry-run to broadcast
```

### Step 7 — Broadcast the real fill

```bash
thetanuts book fill --order-index 0 --collateral 1
```

```
? Fill order 0 (ETH-29MAY26-2000-P) with 1.00 USDC for 0.0235 contracts? Yes
✓ broadcast
  tx: 0xfeed...beef
  position: 0xA1b2...C3d4
  gasUsed: 312044  gasPriceGwei: 0.05  feeEth: 0.0000156  feeUsd: $0.034
```

Between the confirm prompt and broadcast, the CLI re-fetches the order book and re-resolves your order by `(maker, nonce)`. If the order moved or was already filled, the CLI aborts cleanly instead of broadcasting a tx that would revert.

### Step 8 — Inspect your new position

```bash
thetanuts position list
```

```
┌─────────────┬────────┬────────┬────────────────────┬─────────────────────┬───────────┬─────────┬─────┐
│ id          │ source │ side   │ createdAt          │ expiry              │ contracts │ premium │ pnl │
├─────────────┼────────┼────────┼────────────────────┼─────────────────────┼───────────┼─────────┼─────┤
│ 0xA1b2…C3d4 │ book   │ buyer  │ 2026-05-19T03:42:01│ 2026-05-29T08:00:00 │ 0.023529  │ $1.00   │ —   │
└─────────────┴────────┴────────┴────────────────────┴─────────────────────┴───────────┴─────────┴─────┘
```

For a fresh position the `pnl` column shows `—` until the indexer settles it or MM mark-to-market pricing is reachable. Once it resolves, you'll see `+$X.XX (+Y.Y%)`.

After expiry, claim the payout:

```bash
thetanuts position payout --address 0xA1b2...C3d4 --dry-run    # always dry-run first
thetanuts position payout --address 0xA1b2...C3d4
```

---

## Walkthrough 2 — Submit an RFQ

RFQ is a sealed-bid auction: you publish a request, makers submit encrypted offers, the best one wins. Use this when the orderbook doesn't carry your strike or you want a custom multi-leg structure.

### Step 1 — Set up the RFQ keypair

RFQ uses ECDH + AES-256-GCM. Makers encrypt offers to your public key; only your private key can decrypt them.

```bash
thetanuts keys ensure
```

```
✓ created RFQ keypair for chain 8453
  publicKey:  0x02f1a4...b9d2
  stored at:  /Users/you/.config/thetanuts/rfq-keys/thetanuts_rfq_key_8453.key (chmod 600)
```

**Back it up.** Losing this file means every offer ever encrypted to your public key becomes undecryptable forever.

```bash
thetanuts keys export --out ~/rfq-key-backup.key
```

### Step 2 — Approve USDC for the OptionFactory

For BUY-side RFQs, the OptionFactory escrows your `reservePrice` at request time. Approve enough.

```bash
thetanuts wallet approve --token USDC --for optionFactory --amount 10
```

### Step 3 — Discover what's tradeable

```bash
thetanuts rfq quote --underlying ETH --type put
```

```
┌──────────────────────┬───────┬───────┬───────┬──────────────────────┐
│ ticker               │ bid   │ ask   │ mark  │ expiry               │
├──────────────────────┼───────┼───────┼───────┼──────────────────────┤
│ ETH-29MAY26-1900-P   │ 32.10 │ 35.40 │ 33.75 │ 2026-05-29T08:00:00  │
│ ETH-29MAY26-2000-P   │ 41.20 │ 44.80 │ 43.00 │ 2026-05-29T08:00:00  │
│ ETH-29MAY26-2100-P   │ 56.40 │ 60.10 │ 58.25 │ 2026-05-29T08:00:00  │
└──────────────────────┴───────┴───────┴───────┴──────────────────────┘
```

> The CLI enforces this grid. If a (strike, expiry) is not listed, `rfq build` and `rfq request` refuse it with exit 4 and point you back at `rfq quote`.

### Step 4 — Build the request off-chain (dry-run preview)

```bash
thetanuts rfq build --underlying ETH --type PUT --strike 2000 \
  --expiry 1779177600 --collateral-amount 0.5 --direction buy
```

```json
{
  "summary": {
    "structure": "PUT",
    "underlying": "ETH",
    "strike": 2000,
    "expiry": 1779177600,
    "direction": "buy",
    "contracts": "0.01116",
    "reservePricePerContract": "44.80",
    "totalReserve": "0.5 USDC",
    "deadlineSeconds": 45
  },
  "payout": {
    "totalPremium": "0.50 USDC",
    "maxLoss": "0.50 USDC",
    "maxGain": "22.32 USDC",
    "note": "PUT: pays max(strike − spot, 0). If filled, premium is the maximum loss."
  },
  "transaction": { "data": "0x...", "to": "0x..." }
}
```

The CLI auto-fetches the MM's live ask price (here $44.80) and derives `contracts = 0.5 / 44.80 ≈ 0.01116`. To pass a custom reserve, add `--reserve-price 45`.

### Step 5 — Submit on-chain (dry-run first)

```bash
thetanuts rfq request --underlying ETH --type PUT --strike 2000 \
  --expiry 1779177600 --collateral-amount 0.5 --direction buy --dry-run
```

```
preview: requestForQuotation (BUY PUT ETH-29MAY26-2000-P)
  contracts:         0.01116
  reservePrice:      0.5 USDC (escrowed at submission)
  deadline:          45 seconds from submission
  requesterPubKey:   0x02f1a4...b9d2 (from keystore)

allowance check: OK (10.0 USDC ≥ 0.5 USDC)
calldata:        0x4a8b1c2d…00000045 (1024 chars)
```

Submit for real:

```bash
thetanuts rfq request --underlying ETH --type PUT --strike 2000 \
  --expiry 1779177600 --collateral-amount 0.5 --direction buy
```

```
? Submit RFQ (BUY PUT ETH-29MAY26-2000-P, reserve 0.5 USDC, 45s deadline)? Yes
✓ broadcast
  tx: 0x1234...abcd
  quotationId: 42
  gasUsed: 198432  gasPriceGwei: 0.05  feeEth: 0.0000099  feeUsd: $0.021
```

### Step 6 — Wait for fill (the protocol auto-settles)

You can walk away now. After the 45s deadline, anyone can call `settleQuotation` to finalize; if you do nothing, the protocol still picks the winning maker from on-chain reveals and either mints your position or refunds your escrow.

Optional intermediate check — see who offered:

```bash
thetanuts rfq offers --id 42
```

```
┌────────────────┬────────────┬────────────────┬──────────────┐
│ offeror        │ amount     │ amountSource   │ revealed     │
├────────────────┼────────────┼────────────────┼──────────────┤
│ 0xMM1...a1    │ 0.488 USDC │ decrypted      │ no           │
│ 0xMM2...b2    │ 0.495 USDC │ decrypted      │ no           │
└────────────────┴────────────┴────────────────┴──────────────┘
```

### Step 7 — Check whether you got filled

```bash
thetanuts rfq status --ticker ETH-29MAY26-2000-P --since 1779000000
```

Filled:

```
✓ filled
  position: 0xC5d6...E7f8
  source:   rfq
  contracts: 0.01116
  premium:  0.488 USDC
```

Exit code `0`. Not filled — escrow already refunded:

```
✗ no matching position found for ticker ETH-29MAY26-2000-P
  (escrow was refunded by auto-settle)
```

Exit code `1`.

### Step 8 — Inspect the filled position

```bash
thetanuts position info --address 0xC5d6...E7f8
```

```
┌─────────────────┬─────────────────────────────────────────────┐
│ field           │ value                                       │
├─────────────────┼─────────────────────────────────────────────┤
│ optionType      │ PUT (vanilla, cash-settled)                 │
│ strikes         │ 2000 USD                                    │
│ expiry          │ 1779177600 (2026-05-29T08:00:00.000Z)       │
│ collateralToken │ USDC (0x833589f…)                           │
│ underlyingToken │ ETH (derived from priceFeed)                │
│ priceFeed       │ 0x71041dd…                                  │
└─────────────────┴─────────────────────────────────────────────┘
```

After expiry, claim the payout the same way as the OptionBook flow:

```bash
thetanuts position payout --address 0xC5d6...E7f8 --dry-run
thetanuts position payout --address 0xC5d6...E7f8
```

---

## Commands Reference

Run `thetanuts <group> --help` for a group's subcommands, or `thetanuts <group> <subcommand> --help` for flags on a specific subcommand.

### Setup

Interactive first-run wizard — sets the Base RPC URL and creates or imports a wallet.

```bash
thetanuts setup
```

### Chain

```bash
thetanuts chain info                # chainId, RPC, contracts
thetanuts chain tokens              # configured tokens (USDC is the v0.1 trading collateral)
thetanuts chain contracts           # contract addresses
```

### Wallet

```bash
thetanuts wallet create             # generate fresh, save locally
thetanuts wallet create --force     # overwrite existing
thetanuts wallet import             # interactive masked prompt
thetanuts wallet show               # address + source + config path
thetanuts wallet reset              # delete the config file (confirms)

thetanuts wallet balance            # all configured tokens
thetanuts wallet balance --token USDC
thetanuts wallet allowance --token USDC --for optionBook

thetanuts wallet approve --token USDC --for optionBook --amount 100
thetanuts wallet approve --token USDC --for optionBook --amount 100 --dry-run
```

**Flags for `wallet approve`:**

| Flag | Meaning |
| ---- | ------- |
| `--token <sym>` | Token symbol (USDC for trading) |
| `--spender <addr>` | Explicit spender address |
| `--for <name>` | Alternative: `optionBook` or `optionFactory` |
| `--amount <max\|n>` | `max` approves MaxUint256 (WARNING printed). Otherwise a decimal. |
| `--yes` | Skip confirmation prompt |
| `--dry-run` | Emit calldata, do not broadcast |

### Market

Read-only — no wallet needed.

```bash
thetanuts market data                          # spot prices + lastUpdated
thetanuts market stats                         # protocol-wide stats
thetanuts market positions --address 0x...     # indexer positions for any address
thetanuts market history --address 0x...       # trade history
thetanuts market option --address 0x...        # indexer detail for an option
```

### Pricing

Market-maker quotes for vanilla and multi-leg structures. No wallet needed.

```bash
thetanuts pricing all --underlying ETH                                  # all live quotes
thetanuts pricing ticker --ticker ETH-16FEB26-1800-P                    # single quote

thetanuts pricing position --ticker ETH-16FEB26-1800-P --contracts 6 \
                           --collateral-token USDC --long

thetanuts pricing spread    --underlying ETH --strikes 1800,2000      --expiry 1771228800 --type put
thetanuts pricing butterfly --underlying ETH --strikes 1700,1800,1900 --expiry 1771228800 --type call
thetanuts pricing condor    --underlying ETH --strikes 1600,1700,1800,1900 --expiry 1771228800 --type iron
```

### Book — OptionBook orderflow

```bash
thetanuts book orders --underlying ETH                                   # all live orders
thetanuts book orders --underlying ETH --type PUT                        # filter by type
thetanuts book preview --order-index 0 --collateral 1                    # preview a fill
thetanuts book preview --order-index 0 --collateral 1 --scenarios        # + payoff table
thetanuts book max-contracts --order-index 0                             # max fillable size

# Pre-trade liquidity check
thetanuts book check --underlying ETH --type PUT --strike 2200 \
                     --expiry 1778832000 --direction sell

# Fill (always dry-run first)
thetanuts book fill --order-index 0 --collateral 1 --dry-run
thetanuts book fill --order-index 0 --collateral 1
```

**Flags for `book fill`:**

| Flag | Meaning |
| ---- | ------- |
| `--order-index <n>` | Position in the live order book (0-indexed) |
| `--collateral <n>` | USDC amount to spend. CLI derives contracts from the order's price. Omit to fill the max available. |
| `--approve-amount <val>` | If allowance is short. Default: exact. `max` approves MaxUint256 (WARNING printed). |
| `--yes` | Skip both prompts (approval + fill) |
| `--dry-run` | Emit `{ approve, fill }` calldata; do not broadcast |

### Position

```bash
thetanuts position list                                  # all your open positions
thetanuts position list --source book                    # only OptionBook fills
thetanuts position list --source rfq                     # only RFQ settlements
thetanuts position info --address 0x...                  # decoded terms
thetanuts position full --address 0x...                  # full on-chain math
thetanuts position payout --address 0x... --dry-run      # post-expiry: claim payout
thetanuts position calc-payout --type call --strikes 2000 --price 2150 --contracts 1
```

**`position list` columns:**

| Column | Meaning |
| ------ | ------- |
| `id` / `optionAddress` | The option contract's address |
| `source` | `book`, `rfq`, or `book+rfq` (cross-listed) |
| `side` | `buyer` (long) or `seller` (short) |
| `createdAt` | When the position was minted |
| `expiry` | Expiry date |
| `contracts` | Position size as a human decimal |
| `premium` | Total premium paid (BUY) or received (SELL), in USDC |
| `pnl` | `+$X.XX (+Y.Y%)` / `-$X.XX (-Y.Y%)` when resolvable, else `—` |

PnL prefers indexer-computed values; falls back to MM mark-to-market math; degrades to `—` if neither is available. Scripts can read `pnlSource` from `-o json` (always `"indexer"` | `"mtm"` | `"unavailable"`).

### Keys — RFQ keypair management

```bash
thetanuts keys ensure                              # generate + persist (run this first)
thetanuts keys show                                # public key + storage path (NEVER the private key)
thetanuts keys export --out ~/rfq-key-backup.key
thetanuts keys import --in ~/rfq-key-backup.key
thetanuts keys remove --force                      # destroy the key (strands every prior RFQ!)
```

> **Loss consequences.** Deleting the keystore makes every encrypted offer sent to that public key undecryptable forever. **Always run `keys export --out <backup-path>` before anything destructive**, and treat the resulting file like the wallet itself.

`keys export` and `keys import` refuse `--out -` / `--in -` on purpose: private-key material must never land in stdin/stdout where it could be captured.

### RFQ — Request-for-Quotation lifecycle (requester side)

Full requester lifecycle in 9 subcommands: `quote` → `build` → `request` → `get` → `offers` → `accept` (optional) → `cancel` → `settle` → `status`. Maker side is out of scope (run MM bots).

**Strike/expiry availability.** Both `rfq build` and `rfq request` only accept (strike, expiry) combinations the MM is actively quoting. Always start with `rfq quote` to see the live grid; passing something outside it exits with code 4.

**`rfq build` vs `rfq request`:**

| Command | Writes on-chain? | Use case |
| ------- | ---------------- | -------- |
| `rfq quote` | No | List MM-quoted strikes & expiries (vanilla). |
| `rfq build` | No | Construct + validate the RFQ off-chain. Inspect calldata, payout, structure. Save with `--out`. |
| `rfq request` | **Yes — gas + escrow** | Broadcasts on-chain. Returns a `quotationId`. |

**Multi-leg examples:**

```bash
# PUT spread (sell): pass 2 strikes
thetanuts rfq build --underlying ETH --type PUT --strikes 2050,2000 \
  --expiry 1779177600 --collateral-amount 1 --direction sell

# CALL fly (buy): pass 3 strikes (equidistant)
thetanuts rfq build --underlying ETH --type CALL --strikes 2000,2050,2100 \
  --expiry 1779177600 --contracts 0.1 --direction buy --reserve-price 5

# IRON_CONDOR (sell): pass 4 strikes + --structure iron-condor
thetanuts rfq build --underlying ETH --type PUT --strikes 1800,1900,2100,2200 \
  --expiry 1779177600 --collateral-amount 1 --direction sell \
  --structure iron-condor

# Save a build artifact for later submission
thetanuts rfq build --underlying ETH --type PUT --strike 2000 \
  --expiry 1779177600 --collateral-amount 0.5 --direction buy --out /tmp/build.json
thetanuts rfq request --from-build-file /tmp/build.json
```

**Sizing rules** — pass exactly one of:

- `--contracts <n>` (direct count)
- `--collateral-amount <n>` (USDC budget for BUY; collateral deposit for SELL)
  - BUY without `--reserve-price` → CLI fetches the live MM ask and derives contracts.
  - SELL → CLI computes contracts offline from the structure's max-loss formula.

**Structure rules:**

- PUT spreads/flies/condors → strikes **DESCENDING**
- CALL spreads/flies/condors → strikes **ASCENDING**
- Condor / iron condor → always **ASCENDING**
- Butterfly: wings equidistant; condor: outer spreads equal
- Default offer deadline: **0.75 minutes (45 seconds)**

**Offer flow (optional — auto-settle handles most cases):**

```bash
thetanuts rfq offers --id 42                                        # list offers, decrypt yours

# Optionally lock in a specific maker early
thetanuts rfq accept --id 42 --offeror 0xMakerAddress --dry-run
thetanuts rfq accept --id 42 --offeror 0xMakerAddress
```

**Settle + status:**

```bash
thetanuts rfq settle --id 42 --dry-run                                # anyone can settle after deadline
thetanuts rfq settle --id 42

thetanuts rfq status --ticker ETH-29MAY26-2000-P --since 1779000000   # 0 = filled, 1 = no fill
```

### Config

```bash
thetanuts config show               # private key masked
thetanuts config path
thetanuts config set chainId 8453
thetanuts config validate           # checks RPC + key still work
```

## Common Workflows

### Browse before trading

```bash
thetanuts market data
thetanuts book orders --underlying ETH --type PUT
thetanuts pricing all --underlying ETH
thetanuts book preview --order-index 0 --collateral 1
```

### Monitor your portfolio

```bash
thetanuts position list
thetanuts position info --address 0xYourOption...
```

### Script with JSON output

```bash
# Pipe order book to jq
thetanuts -o json book orders --underlying ETH | jq '.[].pricePerContract'

# Pricing snapshot
thetanuts -o json pricing all --underlying ETH | jq '.[] | {ticker, bid, ask, mark}'

# Error handling
if ! result=$(thetanuts -o json market data 2>/dev/null); then
  echo "Failed to fetch market data"
fi
```

## Safety

- **Every write op shows a preview before prompting** — you see the expected outcome before signing.
- **`--dry-run` always emits encoded calldata without broadcasting.** For `book fill` it emits both the `approve` and `fill` blocks.
- **Order freshness check.** `book fill` re-fetches the order book between the confirm prompt and broadcast, re-resolving by `(maker, nonce)`. If the order was filled or repriced since preview, the CLI aborts cleanly.
- **MM grid gating.** RFQ submissions are rejected if the (strike, expiry) isn't in the MM's live quote grid — run `rfq quote` first.
- **Gas accounting.** Every successful write tx renders `gasUsed`, `gasPriceGwei`, `feeEth`, and `feeUsd` after the receipt.
- **`--yes` skips prompts.** Use it in CI / automation only.
- **Approvals are never bundled silently with fills** — they require their own confirmation.
- **`max` approvals require explicit opt-in.** `--approve-amount max` (or `wallet approve --amount max`) prints a stderr WARNING and cannot be combined with key-disclosure flags.
- **`keys export`/`import` refuse stdin/stdout** to prevent private-key material from landing in shell history or pipe targets.
- **HTTPS-only RPC.** The CLI rejects non-HTTPS RPC URLs unless they point at localhost.

## Architecture

The CLI is a thin wrapper over `@thetanuts-finance/thetanuts-client`. Each command group lives in one file under `cli/src/commands/`; a registry wires them into the Commander root.

```
cli/src/
├── index.ts            -- Commander root, global flags, EPIPE handler, --version
├── client.ts           -- getClient() factory (flag → env → config → default)
├── config.ts           -- Load/save ~/.config/thetanuts/config.json (0o600)
├── defaults.ts         -- Default chain ID + RPC URLs
├── output.ts           -- table / json / csv / yaml renderers; BigInt-safe; secret redaction
├── confirm.ts          -- Preview + confirm() + dry-run plumbing (dry-run > yes)
├── options.ts          -- Shared Commander option declarations
├── payout.ts           -- Payoff math + scenarios (shared by book + rfq)
├── rfqKeyStorage.ts    -- Filesystem-backed RFQ keystore (0o700/0o600, atomic writes)
└── commands/           -- One module per command group
```

Groups still unimplemented: `loan`, `ranger`, `events`, `watch`, `wheel`, `vault` (the last three deferred by design).

## License

MIT
