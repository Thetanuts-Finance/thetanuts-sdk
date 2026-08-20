# Thetanuts CLI

TypeScript CLI for [Thetanuts Finance V4](https://thetanuts.finance) options on Base. Browse the orderbook, request quotes, fill orders, manage positions, and run on-chain operations — from a terminal or as a JSON API for scripts and agents.

> **Warning:** This is early, experimental software. Use at your own risk and do not use with large amounts of funds. APIs, commands, and behavior may change without notice. Always run `--dry-run` first, start with a dedicated wallet (not your main funds wallet), and verify transactions before confirming.

> **v0.2.0 — cash-settled USDC book buys only.** `book orders`, `book preview`, and `book fill` exclude physical implementations, maker bids, and non-USDC collateral. RFQ covers the wider direction/structure workflow documented below, including WETH `INVERSE_CALL` for vanilla ETH calls. See [CHANGELOG.md](./CHANGELOG.md) — 0.2.0 corrects OptionBook premium/contract scaling and restricts `book fill --order-index` to `--dry-run`.

## Install

```bash
# Recommended — global install puts `thetanuts` on PATH
npm install -g @thetanuts-finance/cli
thetanuts --help

# Or use without installing (one-off run)
npx --yes @thetanuts-finance/cli market data

# Or install locally to a project
npm install @thetanuts-finance/cli
npx thetanuts --help        # invoke via npx from the project root
```

The package is **`@thetanuts-finance/cli`**; the binary is **`thetanuts`**. Requires Node `>= 18`.

### `thetanuts: command not found` after `npm install`?

If you installed **without `-g`** and your shell can't find `thetanuts`, that's expected — local installs put the binary at `./node_modules/.bin/thetanuts` which **isn't on your shell's PATH by default**. Three ways to fix:

```bash
# 1. Switch to global install (recommended for CLI use)
npm install -g @thetanuts-finance/cli
thetanuts market data        # now works directly

# 2. Stay local, use npx
npm install @thetanuts-finance/cli
npx thetanuts market data    # works without polluting global

# 3. Stay local, call binary by path (for one-off scripting)
./node_modules/.bin/thetanuts market data
```

For most users wanting a terminal trading CLI, **`-g` is the right call**. Local install is for project-scoped use (e.g., calling from an npm script in `package.json`, where npm auto-prepends `node_modules/.bin` to PATH).

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

1. **CLI flag**: `--private-key 0xabc...` (and `--rpc-url`, `--referrer`)
2. **Environment variable**: `THETANUTS_PRIVATE_KEY` (and `THETANUTS_RPC_URL`, `THETANUTS_REFERRER`)
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
  "rfqKeysDir": "~/.config/thetanuts/rfq-keys",
  "referrer": "0x..."
}
```

File permissions are set automatically: `chmod 700` on the directory, `chmod 600` on the file.

### Referral attribution

OptionBook fills carry a referrer **address**. When set, the OptionBook credits it a share of the
protocol fee (`referrerFeeSplitBps` on-chain); when unset the CLI fills with the zero address and the
trade earns no referral credit — `book fill` prints a stderr warning in that case. Resolution follows
the usual order: `--referrer 0x...`, then `THETANUTS_REFERRER`, then the config file's `referrer`.

```bash
thetanuts config set referrer 0xYourReferrerAddress   # persist it
thetanuts --referrer 0xYourReferrerAddress book fill ...   # one-off
```

RFQ is a separate mechanism: `rfq build --referral-id <n>` is a numeric tracking ID carried in the
request, not an address, and it does not participate in OptionBook fee sharing. The two are unrelated
— setting one has no effect on the other.

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

> **Display note.** `book orders` and `book preview` now render humanized columns (ticker, $-formatted strike/premium/available, ISO expiry) in table mode. JSON output stays byte-stable with the raw on-chain decimals scripts depend on. A few other indexer-backed list endpoints still surface raw decimals in table mode; end-to-end humanization is on the v0.1.1 polish list.

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

Verify (ERC-20 balances only — `wallet balance` does not show native ETH; check that separately via your block explorer or RPC):

```bash
thetanuts wallet balance
```

```
Skipped 2 token(s) with known SDK config issues: cbDOGE, cbXRP. Use --all to inspect.
┌───────────┬────────────────────────────────────────────┬──────────┬────────┐
│ symbol    │ address                                    │ balance  │ raw    │
├───────────┼────────────────────────────────────────────┼──────────┼────────┤
│ USDC      │ 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 │ 0.120647 │ 120647 │
│ WETH      │ 0x4200000000000000000000000000000000000006 │ 0        │ 0      │
│ cbBTC     │ 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf │ 0        │ 0      │
│ aBasWETH  │ 0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7 │ 0        │ 0      │
│ aBascbBTC │ 0xBdb9300b7CDE636d9cD4AFF00f6F009fFBBc8EE6 │ 0        │ 0      │
│ aBasUSDC  │ 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB │ 0        │ 0      │
└───────────┴────────────────────────────────────────────┴──────────┴────────┘
```

Single-token query gives a vertical key-value view:

```bash
thetanuts wallet balance --token USDC
```

```
┌──────────┬────────────────────────────────────────────┐
│ key      │ value                                      │
├──────────┼────────────────────────────────────────────┤
│ address  │ 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 │
│ symbol   │ USDC                                       │
│ decimals │ 6                                          │
│ balance  │ 0.110648                                   │
│ raw      │ 110648                                     │
└──────────┴────────────────────────────────────────────┘
```

### Step 3 — Approve USDC for the OptionBook

The OptionBook needs an ERC-20 allowance to pull the premium when you fill an order. Approve a small budget (e.g. 0.5 USDC):

```bash
thetanuts wallet approve --token USDC --for optionBook --amount 0.5 --dry-run
```

```
┌─────────┬────────────────────────────────────────────┐
│ key     │ value                                      │
├─────────┼────────────────────────────────────────────┤
│ action  │ approve                                    │
│ token   │ 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 │
│ spender │ 0x1bDff855d6811728acaDC00989e79143a2bdfDed │
│ amount  │ 0.5                                        │
│ raw     │ 500000                                     │
└─────────┴────────────────────────────────────────────┘
┌────────┬────────────────────────────────────────────┐
│ key    │ value                                      │
├────────┼────────────────────────────────────────────┤
│ dryRun │ true                                       │
│ to     │ 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 │
│ data   │ 0x095ea7b3…0007a120 (138 chars)            │
└────────┴────────────────────────────────────────────┘
```

When happy, drop `--dry-run`:

```bash
thetanuts wallet approve --token USDC --for optionBook --amount 0.5
# Prompts: Approve 0.5 USDC to optionBook (0x1bDff8...)? (y/N)
# After confirmation, prints a receipt with txHash, status, gasUsed, gasPriceGwei, feeEth, feeUsd.
```

### Step 4 — Browse live orders

```bash
thetanuts book orders --underlying ETH --type PUT
```

The list is the executable CLI book: current cash-settled USDC maker asks only. Physical options and bids in aBasWETH/aBasUSDC are intentionally hidden. In table mode, the CLI renders humanized columns — a derived `ticker`, $-formatted `strike` / `premium` / `available`, ISO-stamped `expiry`, `collateralSymbol`, implementation, and settlement style. Under `-o json` the raw on-chain decimals are preserved (8-decimal strikes / prices, 6-decimal USDC and contract amounts) so scripts stay byte-stable.

```
┌───────┬────────────────────────────────────────────┬────────────────────┬────────┬─────────┬────────────────────────────────┬───────────┬──────────────────┬────────────────┬────────────┐
│ index │ maker                                      │ ticker             │ strike │ premium │ expiry                         │ available │ collateralSymbol │ implementation │ settlement │
├───────┼────────────────────────────────────────────┼────────────────────┼────────┼─────────┼────────────────────────────────┼───────────┼──────────────────┼────────────────┼────────────┤
│ 0     │ 0xEcda1D002FBC55F2Fd3386bB4B9B95F859f3C39E │ ETH-20AUG26-1880-P │ $1,880 │ $2.04   │ 1787212800 (2026-08-20T08:00Z) │ $10,000   │ USDC             │ PUT            │ cash       │
│ 1     │ 0xEcda1D002FBC55F2Fd3386bB4B9B95F859f3C39E │ ETH-20AUG26-1900-P │ $1,900 │ $5.39   │ 1787212800 (2026-08-20T08:00Z) │ $10,000   │ USDC             │ PUT            │ cash       │
│ 2     │ 0xEcda1D002FBC55F2Fd3386bB4B9B95F859f3C39E │ ETH-20AUG26-1920-P │ $1,920 │ $13.47  │ 1787212800 (2026-08-20T08:00Z) │ $10,000   │ USDC             │ PUT            │ cash       │
│ 3     │ 0xEcda1D002FBC55F2Fd3386bB4B9B95F859f3C39E │ ETH-20AUG26-1940-C │ $1,940 │ $7.09   │ 1787212800 (2026-08-20T08:00Z) │ $10,000   │ USDC             │ LINEAR_CALL    │ cash       │
└───────┴────────────────────────────────────────────┴────────────────────┴────────┴─────────┴────────────────────────────────┴───────────┴──────────────────┴────────────────┴────────────┘
```

Reading row 0: a PUT struck at `$1,880` with a per-contract premium of `$2.04`, expiring `2026-08-20T08:00Z`, with `$10,000` USDC of maker collateral available. The `premium` column uses the protocol's fixed 8-decimal price scale; `book preview` shows the total USDC cost for the size you want.

For machine-friendly output, use `-o json` and `jq`:

```bash
thetanuts -o json book orders --underlying ETH --type PUT | jq '.[] | {index, strike: (.strikes[0] | tonumber / 1e8), expiry, pricePerContract}'
```

> Need to disambiguate at fill time? Use `--underlying ETH --type PUT --strike 2100 --expiry <ts>` instead of `--order-index <n>`. The selector group is stable across calls; `--order-index` is not.

### Step 5 — Preview the fill

Use the stable selector flags (`--underlying / --type / --strike / --expiry`) instead of `--order-index` — the live book reshuffles between commands and indices move. The `book preview` table renders humanized top-level fields (ticker, $-formatted strikes/premium/totalCollateral); the nested `payout` block is easier to read in JSON mode. Pass `--scenarios` for the payoff table at expiry:

```bash
thetanuts -o json book preview --underlying ETH --type PUT --strike 2075 --expiry 1779177600 --collateral 0.01 --scenarios
```

```json
{
  "numContracts": "11516",
  "maxContracts": "4819277",
  "collateralToken": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "pricePerContract": "86834316",
  "totalCollateral": "10000",
  "referrer": "0x0000000000000000000000000000000000000000",
  "maker": "0xEcda1D002FBC55F2Fd3386bB4B9B95F859f3C39E",
  "expiry": "1779177600",
  "isCall": false,
  "strikes": ["207500000000"],
  "payout": {
    "direction": "buy",
    "contracts": 0.011516,
    "premiumPerContract": "0.86834316 USDC",
    "totalPremium": "0.00999984 USDC",
    "maxLoss": "0.00999984 USDC (premium paid if option expires OTM)",
    "maxGain": "23.8857 USDC (max intrinsic minus premium)",
    "note": "Estimates assume fill at the listed premium. Actual maker quote may beat reserve."
  }
}
```

Followed by the scenarios table:

```
┌────────────────┬───────────────────┬─────────────┬────────────────────┐
│ spotAtExpiry   │ payoutPerContract │ totalPayout │ netPnl             │
├────────────────┼───────────────────┼─────────────┼────────────────────┤
│ $1867.5        │ $207.50           │ $0.02       │ +$0.01 (+139%)     │
│ $1971.25       │ $103.75           │ $0.01       │ +$0.001948 (+19%)  │
│ $2023.13       │ $51.87            │ $0.005973   │ -$0.004026 (-40%)  │
│ $2075 (strike) │ $0.00             │ $0.00       │ -$0.010000 (-100%) │
│ $2126.88       │ $0.00             │ $0.00       │ -$0.010000 (-100%) │
└────────────────┴───────────────────┴─────────────┴────────────────────┘
```

Reading the payout: 0.01 USDC buys 0.00011516 contracts of a $2075 PUT at $86.83 per contract; max loss is the $0.01 premium if ETH stays above $2075 at expiry; max gain is $0.229 if ETH crashes to zero.

> **Why the selector flags?** `--order-index N` resolves to whatever order sits at N **at the moment of broadcast**. The book reshuffles when fresh fills land — between your `--dry-run` and the actual broadcast, index 0 can become a different option entirely. The selector flags (`--underlying / --type / --strike / --expiry`) are stable across calls; when multiple orders match, the CLI picks the cheapest for BUY (pass `--strict` to error instead).

### Step 6 — Dry-run the fill

Always run `--dry-run` first to see the actual calldata.

```bash
thetanuts book fill --underlying ETH --type PUT --strike 2075 --expiry 1779177600 --collateral 0.01 --dry-run
```

The command prints the same preview table from Step 5, then a dry-run block:

```
┌─────────┬───────────────────────────────────────────────────────────────────────────────┐
│ key     │ value                                                                         │
├─────────┼───────────────────────────────────────────────────────────────────────────────┤
│ dryRun  │ true                                                                          │
│ approve │ (none — allowance sufficient)                                                 │
│ fill    │ {"to":"0x1bDff855d6811728acaDC00989e79143a2bdfDed","data":"0xa4761ec1…00000000 (1482 chars)"} │
└─────────┴───────────────────────────────────────────────────────────────────────────────┘
```

If the wallet doesn't have enough allowance, the `approve` cell shows the approval calldata that would be sent first. Both calldatas are always emitted under `-o json` regardless of current allowance, so the dry-run is reproducible for hand-off.

### Step 7 — Broadcast the real fill

```bash
thetanuts book fill --underlying ETH --type PUT --strike 2075 --expiry 1779177600 --collateral 0.01
# Interactive prompt: Confirm fill? (y/N)
# Or non-interactively: add --yes
```

After confirmation, the CLI prints the same preview table once more (for the auditable record) and then a receipt:

```
┌──────────────┬────────────────────────────────────────────────────────────────────┐
│ key          │ value                                                              │
├──────────────┼────────────────────────────────────────────────────────────────────┤
│ txHash       │ 0x2f4400c833397591538a5086638c7f769b0ad4882bfe0d374ce965e72222a0b8 │
│ status       │ success                                                            │
│ blockNumber  │ 46185821                                                           │
│ gasUsed      │ 643214                                                             │
│ gasPriceGwei │ 0.006                                                              │
│ feeEth       │ 0.000004                                                           │
│ feeUsd       │ $0.0082                                                            │
└──────────────┴────────────────────────────────────────────────────────────────────┘
```

With the selector flags (`--underlying / --type / --strike / --expiry`), the fill resolves by structure identity — the CLI re-fetches the live book at broadcast time and matches the same `(underlying, type, strike, expiry)` combination, picking the cheapest match if multiple makers are quoting it. Stable across calls. (The legacy `--order-index N` path still works but resolves to whatever order sits at index `N` *at broadcast time*; the book reshuffles when fresh fills land, so you may end up filling a different option than your dry-run quoted.)

### Step 8 — Inspect your new position

```bash
thetanuts position list
```

```
┌────────────────────────────────────────────┬────────────────────────────────────────────┬────────┬───────┬──────────────────────┬────────────┬───────────┬────────────────┬─────────────────┐
│ id                                         │ optionAddress                              │ source │ side  │ createdAt            │ expiry     │ contracts │ premium        │ pnl             │
├────────────────────────────────────────────┼────────────────────────────────────────────┼────────┼───────┼──────────────────────┼────────────┼───────────┼────────────────┼─────────────────┤
│ 0x5F712F331c1f0f30F913c22b053985bf2ac88dc4 │ 0x5F712F331c1f0f30F913c22b053985bf2ac88dc4 │ book   │ buyer │ 2026-05-19T03:23:09Z │ 2026-05-19 │ 0.01135   │ $0.009999 USDC │ $-0.01 (-67.4%) │
└────────────────────────────────────────────┴────────────────────────────────────────────┴────────┴───────┴──────────────────────┴────────────┴───────────┴────────────────┴─────────────────┘
```

`pnl` shows `—` when neither the indexer's pre-computed PnL nor a fresh MM mark-to-market quote is reachable; otherwise it's `+/-$X.XX (+/-Y.Y%)` from whichever source resolved. Scripts can read `pnlSource` from `-o json` (`"indexer"`, `"mtm"`, or `"unavailable"`).

> **What `—` means.** If you see `—` in the `pnl` column (or any price-derived field), it means the market maker had **no live quote** for that strike at fetch time. Common near expiry: the MM rotates out of strikes 1–3 hours before expiration. It's **not** a CLI bug or a zero — re-run `thetanuts position list` in a minute and the quote usually returns. To force a closing trade at your own price regardless of MM quotes, use `thetanuts position close --address <addr> --reserve-price <usd-per-contract>`.

To see the structure terms (strike, type, expiry, collateral):

```bash
thetanuts position info --address 0x5F712F331c1f0f30F913c22b053985bf2ac88dc4
```

```
┌─────────────────┬───────────────────────────────────────────────────┐
│ key             │ value                                             │
├─────────────────┼───────────────────────────────────────────────────┤
│ address         │ 0x5F712F331c1f0f30F913c22b053985bf2ac88dc4        │
│ optionType      │ PUT (vanilla)                                     │
│ optionTypeRaw   │ 257                                               │
│ strikes         │ 2075 USD                                          │
│ strikesRaw      │ ["207500000000"]                                  │
│ expiry          │ 1779177600 (2026-05-19T08:00:00.000Z)             │
│ collateralToken │ USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) │
│ underlyingToken │ ETH (derived from priceFeed)                      │
│ priceFeed       │ 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70        │
└─────────────────┴───────────────────────────────────────────────────┘
```

After expiry, inspect the automatic payout:

```bash
thetanuts position payout --address 0x5F71...8dc4
```

Pre-expiry, the command prints `option has not expired yet` and exits non-zero. On r12 there is no user-callable `claim()`/`payout()` transaction: the factory settles automatically and sends any buyer payout directly to the holder wallet. After expiry, this command prints the resolved TWAP, `numContracts`, `strikes`, and simulated payout so you can verify the result.

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

### Step 2 — Approve collateral for the OptionFactory

For BUY-side RFQs, the OptionFactory escrows your `reservePrice` at request time. Approve enough.

```bash
thetanuts wallet approve --token USDC --for optionFactory --amount 10
```

Vanilla ETH calls use `INVERSE_CALL`, so they require WETH instead:

```bash
thetanuts wallet approve --token WETH --for optionFactory --amount 0.001
```

### Step 3 — Discover what's tradeable

```bash
thetanuts rfq quote --underlying ETH --type put
```

```
┌────────────┬────────────┬────────┬──────┬─────────────────────┬───────────┬───────────┬──────────┬────────────┬────────────┐
│ expiry     │ date       │ strike │ type │ ticker              │ bid       │ ask       │ mark     │ usdcAsk    │ wethAsk    │
├────────────┼────────────┼────────┼──────┼─────────────────────┼───────────┼───────────┼──────────┼────────────┼────────────┤
│ 1779177600 │ 2026-05-19 │ 2050   │ P    │ ETH-19MAY26-2050-P  │ 0.0000875 │ 0.000225  │ 0.000159 │ 0.00026815 │ 0.00025331 │
│ 1779177600 │ 2026-05-19 │ 2075   │ P    │ ETH-19MAY26-2075-P  │ 0.000175  │ 0.0003375 │ 0.000339 │ 0.00038447 │ 0.00036919 │
│ 1779177600 │ 2026-05-19 │ 2100   │ P    │ ETH-19MAY26-2100-P  │ 0.0006125 │ 0.001125  │ 0.00091  │ 0.00119604 │ 0.00118031 │
│ 1779177600 │ 2026-05-19 │ 2125   │ P    │ ETH-19MAY26-2125-P  │ 0.002625  │ 0.0042    │ 0.003363 │ 0.00436373 │ 0.00434756 │
│ 1779177600 │ 2026-05-19 │ 2150   │ P    │ ETH-19MAY26-2150-P  │ 0.0106    │ 0.0139    │ 0.011937 │ 0.01435517 │ 0.01433856 │
│ ...        │ ...        │ ...    │ ...  │ ...                 │ ...       │ ...       │ ...      │ ...        │ ...        │
└────────────┴────────────┴────────┴──────┴─────────────────────┴───────────┴───────────┴──────────┴────────────┴────────────┘
```

`bid` / `ask` / `mark` are MM-quoted prices per unit of underlying. `usdcAsk` is the implied USDC premium per contract. `wethAsk` is the WETH premium used by vanilla ETH `INVERSE_CALL` RFQs.

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
  "encodingNote": "No transaction encoded because requesterPublicKey is empty; `rfq request` will load/create the RFQ key before submission."
}
```

The CLI auto-fetches the MM's live ask price (here $44.80) and derives `contracts = 0.5 / 44.80 ≈ 0.01116`. To pass a custom reserve, add `--reserve-price 45`.

### Step 5 — Submit on-chain (dry-run first)

```bash
thetanuts rfq request --underlying ETH --type PUT --strike 2050 \
  --expiry 1779177600 --collateral-amount 0.005 --direction buy --dry-run
```

The dry-run shows the full request body and the encoded transaction calldata:

```
┌──────────────────────────┬──────────────────────────────────────────────────────────────────────┐
│ key                      │ value                                                                │
├──────────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ action                   │ requestForQuotation                                                  │
│ ticker                   │ ETH-19MAY26-2050-P                                                   │
│ structureType            │ PUT                                                                  │
│ strikes                  │ ["205000000000"]                                                     │
│ numContracts             │ 8915                                                                 │
│ reservePrice             │ 5000                                                                 │
│ expiryTimestamp          │ 1779177600                                                           │
│ offerEndTimestamp        │ 1779163303                                                           │
│ isRequestingLongPosition │ true                                                                 │
│ requesterPublicKey       │ 0x0307a613c6224e7aa34874960d13e4f1589ee26005afdca7d123b8df39e544c29c │
└──────────────────────────┴──────────────────────────────────────────────────────────────────────┘
┌─────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ key     │ value                                                                                                     │
├─────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ dryRun  │ true                                                                                                      │
│ request │ {"to":"0x8118daD971dEbffB49B9280047659174128A8B94","data":"0xb5da63e3…00000000 (1674 chars)","value":"0"} │
└─────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Drop `--dry-run` to broadcast:

```bash
thetanuts rfq request --underlying ETH --type PUT --strike 2050 \
  --expiry 1779177600 --collateral-amount 0.005 --direction buy --yes
```

```
┌──────────────┬────────────────────────────────────────────────────────────────────┐
│ key          │ value                                                              │
├──────────────┼────────────────────────────────────────────────────────────────────┤
│ txHash       │ 0xbd81e834369110267409e3740d731cb5a89c104d62ac94d835ccac875d7bcfc4 │
│ status       │ success                                                            │
│ blockNumber  │ 46186965                                                           │
│ gasUsed      │ 438900                                                             │
│ gasPriceGwei │ 0.006                                                              │
│ feeEth       │ 0.000003                                                           │
│ feeUsd       │ $0.0056                                                            │
│ quotationId  │ 25                                                                 │
└──────────────┴────────────────────────────────────────────────────────────────────┘

RFQ 25 submitted. Watch offers: thetanuts rfq offers --id 25
Cancel before deadline:           thetanuts rfq cancel --id 25
Tip: you usually don't need to call rfq accept or rfq offers — the protocol
auto-settles after the offer deadline (~45 seconds). Check fill status with:
  thetanuts rfq status --ticker ETH-19MAY26-2050-P --since 1779163272
  thetanuts position list --source rfq
```

### Step 6 — Wait for the auto-settle

After the offer deadline closes, the protocol picks the best valid maker offer and either mints your position or refunds your escrow. In practice this usually completes within 2-3 minutes of submission (offer window 45s + a short reveal/settle window).

You can walk away. If you want to inspect the offers while you wait:

```bash
thetanuts rfq offers --id 25
```

```
┌────────────────────────────────────────────┬──────────┬─────────────┬──────────────────┬──────────────┐
│ offeror                                    │ status   │ offerAmount │ offerAmountHuman │ amountSource │
├────────────────────────────────────────────┼──────────┼─────────────┼──────────────────┼──────────────┤
│ 0xEcda1D002FBC55F2Fd3386bB4B9B95F859f3C39E │ rejected │ 4852        │ 0.004852         │ indexer      │
└────────────────────────────────────────────┴──────────┴─────────────┴──────────────────┴──────────────┘
```

> **Indexer quirk to know.** The `status` column (`accepted` / `rejected`) reflects the indexer's internal labeling and **does not always match the on-chain settlement outcome** — we've seen the winning lower offer surface as "rejected" while the actual auto-settle still picks it as the fill. Treat `rfq offers` as informational; rely on `rfq status` and `position list` for the authoritative outcome.

### Step 7 — Check whether you got filled

```bash
thetanuts rfq status --ticker ETH-19MAY26-2050-P --since 1779163272
```

Filled:

```
┌─────────────┬───────────────────────────────────────────────────────────────────────────────┐
│ key         │ value                                                                         │
├─────────────┼───────────────────────────────────────────────────────────────────────────────┤
│ filled      │ true                                                                          │
│ checkParams │ {"address":"0x2f1E…","ticker":"ETH-19MAY26-2050-P","since":1779163272,…}      │
│ position    │ {"id":"0xE4bc5F4FdD7ad74d7E08ed2FCc38ee44d8535d64",…,"side":"BUYER",…}        │
│ message     │ RFQ filled. Position ETH-19MAY26-2050-P with 0.006194 contracts (BUYER).      │
└─────────────┴───────────────────────────────────────────────────────────────────────────────┘
```

Exit code `0`. Not filled (escrow auto-refunded):

```
{ "filled": false, "message": "No fill detected — no position matching the ticker yet.", … }
```

Exit code `1`.

> **`rfq status` checks both indexer sources** (book and RFQ) for the ticker; an RFQ-auto-settled position lives only on the RFQ side and won't appear in book-side queries.

### Step 8 — Inspect the filled position

```bash
thetanuts position info --address 0xE4bc5F4FdD7ad74d7E08ed2FCc38ee44d8535d64
```

```
┌─────────────────┬───────────────────────────────────────────────────┐
│ key             │ value                                             │
├─────────────────┼───────────────────────────────────────────────────┤
│ address         │ 0xE4bc5F4FdD7ad74d7E08ed2FCc38ee44d8535d64        │
│ optionType      │ PUT (vanilla)                                     │
│ optionTypeRaw   │ 257                                               │
│ strikes         │ 2050 USD                                          │
│ strikesRaw      │ ["205000000000"]                                  │
│ expiry          │ 1779177600 (2026-05-19T08:00:00.000Z)             │
│ collateralToken │ USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) │
│ underlyingToken │ ETH (derived from priceFeed)                      │
│ priceFeed       │ 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70        │
└─────────────────┴───────────────────────────────────────────────────┘
```

After expiry, inspect the automatic payout the same way as the OptionBook flow:

```bash
thetanuts position payout --address 0xE4bc...5d64
```

Pre-expiry, the command exits non-zero with `option has not expired yet`. On r12 settlement is automatic: the factory sends any buyer payout directly to the holder wallet, and no manual claim transaction exists. After expiry, `position payout` displays the resolved TWAP and simulated payout for verification.

#### How the `pnl` column is computed

The CLI tries three sources in order, stopping at the first one that produces a number — same logic the [Thetanuts options dashboard](https://app.thetanuts.finance) uses:

1. **`indexer`** — pre-computed PnL from the protocol's settlement worker, where available.
2. **`mtm`** — a live mark-to-market valuation using the market maker's current bid/ask. Buyer/seller formulas mirror the dApp's `pnlCalculations.ts` byte-for-byte: buyer's PnL = `currentValue − entryPremium`; seller's PnL = `premium − closeCost`.
3. **`unavailable`** — neither source resolved (option settled/expired, or MM has no live quote right now). The pnl column shows `—` and a stderr note suggests retrying.

Scripts can branch on the `pnlSource` field in `-o json` output.

#### Closing an RFQ position early — `position close`

To unwind a position before expiry, open an **opposite-direction RFQ on the same option** — same flow the dApp's "Close" button uses (`useRfqActions.ts:701 handleClosePosition`). The CLI wraps that as one command:

```bash
thetanuts position close --address 0xE4bc...5d64 --dry-run     # preview
thetanuts position close --address 0xE4bc...5d64               # broadcast
```

Closes work for both USDC- and WETH-collateralized positions. `--reserve-price` is denominated in the position's own collateral — USDC for cash structures, WETH for inverse calls — and reserve sizing is exact bigint arithmetic, so 18-decimal amounts are not rounded through a float.

By default, the CLI fetches the MM's current bid (for closing a long) or ask (for closing a short) and uses it as the reserve price. To override (useful when the MM has retreated and the auto-fetch fails):

```bash
thetanuts position close --address 0xE4bc...5d64 --reserve-price 0.50
```

For a SHORT position you're buying back, you'll need OptionFactory to escrow the reserve — pass `--ensure-allowance` so the CLI runs the approval first:

```bash
thetanuts position close --address 0x2D55...01282 --ensure-allowance
```

**What gets printed.** A preview table (ticker, side, closingDirection, contracts, closingPricePerContract, reservePrice), then a confirm prompt, then a receipt with `txHash` / `gasUsed` / `feeUsd` / `quotationId`. After broadcast, the protocol auto-settles within the 60-second deadline; check fill via `rfq status` or `position list --source rfq`.

**Flags:**

| Flag | Meaning |
| ---- | ------- |
| `--address <addr>` | Option contract to close (copy from `position list`) |
| `--reserve-price <n>` | Override the MM-derived closing price (USDC per contract). Required when MM has no live quote. |
| `--deadline-minutes <n>` | Offer window length (default 1 = 60 s) |
| `--fill-or-kill` | Only accept a full-size match — partial fills rejected |
| `--ensure-allowance` | Approve collateral on OptionFactory before submission (SHORT close path) |
| `--approve-amount <max\|n>` | Allowance amount when `--ensure-allowance` fires (default: exact reservePrice) |
| `--yes`, `--dry-run` | Standard global flags |

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
thetanuts chain tokens              # configured tokens (USDC for cash structures, WETH for inverse calls)
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

thetanuts wallet transfer --token USDC --to 0xRecipient --amount 5.50 --dry-run
thetanuts wallet transfer --token USDC --to 0xRecipient --amount 5.50
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

**Flags for `wallet transfer`:**

| Flag | Meaning |
| ---- | ------- |
| `--token <sym>` | Token symbol (USDC, WETH, cbBTC, …) or 0x-address |
| `--to <addr>` | Recipient 0x-address |
| `--amount <n>` | Decimal amount in token units (e.g. `5.50` for 5.50 USDC). Balance pre-checked. |
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
thetanuts book orders --underlying ETH                                   # eligible cash USDC asks
thetanuts book orders --underlying ETH --type PUT                        # filter by type

# Preview / max contracts by structure identity (recommended)
thetanuts book preview --underlying ETH --type PUT --strike 2100 --expiry 1779177600 --collateral 1
thetanuts book preview --underlying ETH --type PUT --strike 2100 --expiry 1779177600 --collateral 1 --scenarios
thetanuts book max-contracts --underlying ETH --type PUT --strike 2100 --expiry 1779177600

# Pre-trade liquidity check (any configured underlying, not just ETH/BTC)
thetanuts book check --underlying ETH --type PUT --strike 2200 \
                     --expiry 1778832000 --direction buy

# Fill (always dry-run first)
thetanuts book fill --underlying ETH --type PUT --strike 2100 --expiry 1779177600 --collateral 1 --dry-run
thetanuts book fill --underlying ETH --type PUT --strike 2100 --expiry 1779177600 --collateral 1

# Legacy --order-index is read-only/dry-run because indices are volatile:
thetanuts book fill --order-index 0 --collateral 1 --dry-run
```

**Flags for `book fill`:**

| Flag | Meaning |
| ---- | ------- |
| `--underlying <ETH\|BTC>` + `--type <PUT\|CALL>` + `--strike <usd>` + `--expiry <ts>` | Preferred: select by structure identity. Stable across calls. For multi-leg, pass `--strikes <csv>` instead of `--strike`. |
| `--strict` | When the selector matches multiple orders, error instead of picking the cheapest. |
| `--order-index <n>` | Legacy read-only path. Allowed with `--dry-run`; live fills require stable selector flags. |

#### `book check` output

`book check` scans the **same** eligible-order set and uses the **same** matcher
as `book preview` / `book fill`, so the two commands cannot disagree about what
the book holds. It recommends `rfq` only when that shared matcher finds nothing
at the requested expiry.

Roughly half the live book is multi-leg (spreads, flies, rangers). When your
strike exists only as a *leg* of a live structure, `check` still reports
`recommendation: "orderbook"` — you can stay on the book and keep orderbook
credit — and lists the structures in `structureMatches`:

| Field | Meaning |
| ----- | ------- |
| `recommendation` | `orderbook` when the book can fill (exact instrument **or** a structure carrying your strike), else `rfq`. |
| `orderbookOrders` | Exact standalone matches only. `bestPrice` / `availableSize` describe these. |
| `structureMatches` | Live multi-leg orders carrying your strike, cheapest first. `structurePrice` is the premium for the **whole structure** — not comparable to a vanilla ask. Each carries a runnable `nextStep`. |
| `cliExecutable` | `false` for `--direction sell`: the book may have bids, but the CLI executes buys only. |
| `liveExpiries` | Every expiry with liquidity for this underlying/type, with vanilla and structure counts. |
| `didYouMean` | Listed expiries falling on the same UTC date as the one you passed. Never auto-applied — the book carries e.g. both an 03:00Z and an 08:00Z expiry on some dates. |

Tickers are structure-honest: a 4-strike ranger renders as
`ETH-28AUG26-2150/2200/2250/2300-RANGER`, never as a vanilla `…-2150-C`.

Multi-leg strike order does not matter — `--strikes 2150,2200` and
`--strikes 2200,2150` resolve to the same order.

> **Seeing a CLI fill in the Odette web UI.** The UI only renders positions
> whose `referrer` matches Odette's own address, so pass `--referrer` (or set it
> in config) or the trade will not show. The UI also reads a different indexer
> than the SDK, refreshed on a 60-minute cron — the browser pokes it after its
> own trades, the CLI does not. After a CLI fill, run
> `curl https://odette.fi/api/update` and reload, or wait for the cron.
> `thetanuts position list` reads the SDK's indexer and reflects a fill
> immediately.

| `--collateral <n>` | USDC amount to spend. CLI derives contracts from the order's price. Omit to fill the max available. |
| `--approve-amount <val>` | If allowance is short. Default: exact. `max` approves MaxUint256 (WARNING printed). |
| `--yes` | Skip both prompts (approval + fill) |
| `--dry-run` | Emit `{ approve, fill }` calldata; do not broadcast |
| `--referrer <address>` | Global flag. Referrer credited a share of the fee. Also `THETANUTS_REFERRER` / config `referrer`. Unset → zero address + stderr warning. |

### Position

```bash
thetanuts position list                                  # all your open positions
thetanuts position list --source book                    # only OptionBook fills
thetanuts position list --source rfq                     # only RFQ settlements
thetanuts position info --address 0x...                  # decoded terms
thetanuts position full --address 0x...                  # full on-chain math
thetanuts position close --address 0x... --dry-run       # close early via flipped-direction RFQ
thetanuts position payout --address 0x...                # inspect automatic post-expiry payout
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

A `—` in the PnL column means the market maker had no live quote for that strike at fetch time — not a CLI bug, not a zero. Re-run after a minute to retry, or use `position close --reserve-price <n>` to force a closing trade at your own price.

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
# Vanilla ETH CALL: explicit WETH is required and amounts are in WETH
thetanuts rfq build --underlying ETH --type CALL --strike 1950 \
  --expiry 1779177600 --collateral-amount 0.0001 --direction buy \
  --collateral-token WETH

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
- `--collateral-amount <n>` (budget for BUY; collateral deposit for SELL, in the selected collateral token)
  - BUY without `--reserve-price` → CLI fetches the live MM ask and derives contracts.
  - SELL → CLI computes contracts offline from the structure's max-loss formula.

Vanilla ETH calls require explicit `--collateral-token WETH` and route to `INVERSE_CALL`. The CLI intentionally rejects vanilla CALL + USDC because the active maker does not support `LINEAR_CALL`. PUTs and multi-leg structures continue to use USDC.

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
thetanuts config set referrer 0xYourReferrerAddress   # OptionBook fee attribution
thetanuts config unset referrer
thetanuts config validate           # checks RPC + key still work
```

## Common Workflows

### Browse before trading

```bash
thetanuts market data
thetanuts book orders --underlying ETH --type PUT
thetanuts pricing all --underlying ETH
thetanuts book preview --underlying ETH --type PUT --strike 2100 --expiry 1779177600 --collateral 1
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
- **`--dry-run` always emits encoded calldata without broadcasting.** For `book fill` it emits both the `approve` and `fill` blocks. Table mode abbreviates long calldata to `0x<selector>…<tail> (N chars)`; use `-o json` for the full bytes. Addresses, tx hashes, and RFQ public keys are never abbreviated.
- **Order freshness check.** `book fill` re-fetches the order book between confirmation and broadcast, re-resolving the exact EIP-712 signature. Odette reuses nonces across products, so `(maker, nonce)` is not treated as unique. If the signed order disappeared or liquidity changed, the CLI aborts cleanly.
- **MM grid gating.** RFQ submissions are rejected if the (strike, expiry) isn't in the MM's live quote grid — run `rfq quote` first.
- **RFQ deadline freshness.** The CLI refreshes `offerEndTimestamp` immediately before broadcast, after any approval and confirmation prompts, so makers receive the full requested quote window.
- **Gas accounting.** Every successful write tx renders `gasUsed`, `gasPriceGwei`, `feeEth`, and `feeUsd` after the receipt.
- **Fill identity.** A successful book fill also renders the created option address, ticker, buyer/seller, and an on-chain `position info` command; `position list` may lag briefly while the indexer catches up.
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
