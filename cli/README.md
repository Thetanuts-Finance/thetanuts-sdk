# thetanuts

TypeScript CLI for Thetanuts Finance V4. Browse the orderbook, query market pricing, fill orders, manage option positions — from a terminal or as a JSON API for scripts and agents.

> **Warning:** This is early, experimental software (v0.1). The trading surface (`book fill`, `position close`, `position split`) has not yet been exercised against a real live broadcast — only `--dry-run` calldata generation is verified. Use at your own risk and start with tiny amounts. Always verify with `--dry-run` before sending real transactions.

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

# Pure helpers, no network
thetanuts util payout --type call --strikes 2000 --price 2150 --contracts 1

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
2. Environment variables: `THETANUTS_PRIVATE_KEY`, `THETANUTS_RPC_URL`, `THETANUTS_CHAIN`
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

# Option 3 — guided wizard that bundles wallet + chain + RPC choice
thetanuts setup
```

Config file shape (`~/.config/thetanuts/config.json`):

```json
{
  "version": 1,
  "chainId": 8453,
  "rpcUrl": "https://mainnet.base.org",
  "privateKey": "0x...",
  "referrer": "0x...",
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

- `market` — spot prices, orders, daily stats, indexer positions/history
- `pricing` — MM pricing grid, ticker math, fee adjustment, collateral cost
- `chain` — chain id, contracts, tokens, implementations, feeds
- `util` — unit conversions, payout math, structure validators
- `book orders`, `book preview`, `book max-contracts`, `book check`,
  `book fees`, `book claimable-fees`, `book referrer-fee-split`,
  `book hash-order`, `book compute-nonce`, `book eip712-domain`
- `position list`, `position info`, `position full`, and every other
  `position` read
- `wallet create`, `wallet import`, `wallet show` — wallet setup (generate
  or import keys; these are how you get a wallet in the first place)

Wallet required:

- `wallet balance`, `wallet allowance` (when no `--address` is provided)
- `wallet approve`, `wallet ensure-allowance`, `wallet transfer`
- `book fill`, `book swap-and-fill`, `book cancel`, `book claim`,
  `book claim-all`, `book static-fill`, `book static-cancel`
- `position close`, `position split`, `position transfer`, `position payout`

## Output Formats

Every command accepts `-o <fmt>`:

| Format  | Use case                                       |
| ------- | ---------------------------------------------- |
| `table` | Default. Human-readable; ANSI colors on TTY.   |
| `json`  | Scripts and agents. BigInts as decimal strings. |
| `csv`   | List endpoints only (`market orders`, etc.).   |
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
thetanuts pricing all -o json | head -5
thetanuts -o json market orders --underlying ETH | jq '.[].pricePerContract'
```

both exit silently with status 0.

Errors emit on stderr by default; pass `--json-errors` for structured JSON
errors on stderr instead. Either way, exit code is non-zero.

### Exit codes

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| `0`  | Success                                                              |
| `1`  | Generic error (network, RPC, contract revert)                        |
| `2`  | Usage error (bad flags, missing required arg)                        |
| `3`  | Confirmation refused / dry-run aborted                               |
| `4`  | Config / wallet error (missing key, bad key file)                    |
| `5`  | Chain unsupported for requested operation (e.g. `wheel` on Base)     |

## Commands

Run `thetanuts <group> --help` for a group's subcommands, or
`thetanuts <group> <subcommand> --help` for flags on a specific subcommand.

### `setup` — first-run wizard

Interactive: pick chain, RPC URL, import a private key, set the referrer
address. Writes to `~/.config/thetanuts/config.json` with `chmod 600`.

```sh
thetanuts setup
```

### `config` — inspect and edit persisted config

```sh
thetanuts config show                         # private key masked
thetanuts config path
thetanuts config set chainId 8453
thetanuts config unset referrer
thetanuts config validate                     # checks RPC + key still work
```

### `chain` — chain metadata

```sh
thetanuts chain info                          # chainId, RPC, contracts
thetanuts chain tokens                        # 8 supported tokens
thetanuts chain contracts                     # contract addresses
thetanuts chain implementations               # CALL, PUT, SPREAD, FLY, CONDOR, etc.
thetanuts chain feeds                         # 8 Chainlink price feeds
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
thetanuts wallet allowance --token USDC --spender 0x...
thetanuts wallet info --token USDC            # decimals + symbol

# Writes
thetanuts wallet approve --token USDC --for optionBook --amount 100
thetanuts wallet ensure-allowance --token USDC --spender 0x... --amount 100
thetanuts wallet transfer --token USDC --to 0x... --amount 10 --dry-run
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
thetanuts market data
thetanuts market prices
thetanuts market orders --underlying ETH --type PUT
thetanuts market stats
thetanuts market daily-stats --from 1746800000
thetanuts market positions --address 0x...
thetanuts market history --address 0x...
thetanuts market option --address 0x...
thetanuts market referrer-stats --address 0x...
```

Flags for `market orders`:

| Flag                  | Meaning                                                     |
| --------------------- | ----------------------------------------------------------- |
| `--underlying <sym>`  | Filter by underlying (ETH, BTC, etc.).                      |
| `--type <PUT\|CALL>`  | Filter by option type.                                      |
| `--min-expiry <ts>`   | Filter to orders expiring after this Unix timestamp.        |

### `pricing` — market-maker quotes and ticker math

```sh
thetanuts pricing all --underlying ETH
thetanuts pricing ticker --ticker ETH-16FEB26-1800-P
thetanuts pricing array --underlying ETH
thetanuts pricing spread --underlying ETH --strikes 1800,2000 --expiry 1771228800 --type put
thetanuts pricing butterfly --underlying ETH --strikes 1700,1800,1900 --expiry 1771228800 --type call
thetanuts pricing parse-ticker ETH-16FEB26-1800-P
thetanuts pricing build-ticker --underlying ETH --expiry 1771228800 --strike 1800 --type put
```

### `util` — pure conversions, payout math, validators

```sh
thetanuts util to-price --value 2000               # → 200000000000  (8 dp)
thetanuts util to-usdc --value 100                 # → 100000000     (6 dp)
thetanuts util from-usdc --value 100000000         # → 100
thetanuts util payout --type call --strikes 2000 --price 2150 --contracts 1
thetanuts util validate-address 0x4200000000000000000000000000000000000006
thetanuts util validate-expiry 1771228800
```

### `book` — OptionBook orderflow

```sh
# Reads + pre-trade analysis
thetanuts book orders --underlying ETH
thetanuts book preview --order-index 0 --collateral 1
thetanuts book max-contracts --order-index 0
thetanuts book check --underlying ETH --type PUT --strike 2200 --expiry 1778832000 --direction sell

# Writes (broadcast — use --dry-run first)
thetanuts book fill --order-index 0 --collateral 1 --dry-run
thetanuts book cancel --order-index 0 --dry-run
thetanuts book claim --token USDC
thetanuts book claim-all

# Static reflection (no broadcast)
thetanuts book static-fill --order-index 0 --num-contracts 1
thetanuts book static-cancel --order-index 0

# Order metadata
thetanuts book hash-order --order-index 0
thetanuts book compute-nonce
thetanuts book eip712-domain

# Referrer accounting
thetanuts book fees --token USDC
thetanuts book claimable-fees
thetanuts book referrer-fee-split
```

`book check` is a deterministic port of OpenClaw's pre-trade liquidity
analyzer. It returns matching orderbook orders + best price + available
size + partial-fill availability + nearby strikes within 5% + a
recommendation (`orderbook` vs `rfq`) with reason. Useful before a
`book fill` or (once Phase 3 lands) an `rfq request`.

Flags for `book fill`:

| Flag                       | Meaning                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `--order-index <n>`        | Position in the live order book (0-indexed).                       |
| `--collateral <n>`         | Collateral amount in token units.                                  |
| `--num-contracts <n>`      | Alternative to `--collateral`.                                     |
| `--approve-amount <val>`   | Approve mode if allowance is insufficient. Default: exact (approves only what's needed). `max` approves MaxUint256 (WARNING printed). `<number>` approves a specific amount. |
| `--yes`                    | Skip both prompts (approval and fill).                             |
| `--dry-run`                | Emit `{ approve, fill }` calldata, do not broadcast.               |

`--dry-run` always emits both the `approve` and `fill` calldata blocks
regardless of current allowance, so you can inspect or hand off both
transactions without first granting an allowance on-chain.

### `position` — owned option management

```sh
thetanuts position list
thetanuts position info --address 0x...
thetanuts position full --address 0x...
thetanuts position payout-at --address 0x... --price 2100
thetanuts position simulate-payout --address 0x...
thetanuts position close --address 0x... --dry-run
thetanuts position split --address 0x... --collateral 1 --dry-run
thetanuts position transfer --address 0x... --to 0x... --dry-run
thetanuts position calc-payout --type call --strikes 2000 --price 2150 --contracts 1
```

Flags for `position info`:

| Flag                | Meaning                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `--address <addr>`  | Option contract address.                                         |

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
thetanuts setup                # guided wizard: wallet + chain + RPC in one flow

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
thetanuts position simulate-payout --address 0xYourOption...
```

### 5. Pipe JSON output to scripts

```sh
thetanuts -o json market orders --underlying ETH \
  | jq '.[].pricePerContract'

thetanuts -o json pricing all --underlying ETH \
  | jq 'to_entries | map({ticker: .key, ask: .value.rawAskPrice})'
```

## Safety

- Every write op runs a preview before prompting — you see the expected
  outcome before signing.
- `--dry-run` always emits encoded calldata without broadcasting (both
  `approve` and `fill` for `book fill`).
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
├── warn.ts                     Shared safety-warning helpers (stderr)
└── commands/
    ├── registry.ts             Wires every group's register(program)
    ├── setup.ts                Interactive first-run wizard (create | import | skip)
    ├── config.ts               Inspect/edit persisted config
    ├── chain.ts                Chain metadata
    ├── wallet.ts               Create/import wallets, balances, allowances, transfers
    ├── market.ts               Live market reads
    ├── pricing.ts              MM pricing + ticker math
    ├── util.ts                 Pure conversions and validators
    ├── book.ts                 OptionBook orderflow + pre-trade liquidity check
    └── position.ts             Owned option management
```

Roadmap groups still to land: `keys`, `rfq`, `loan`, `ranger`, `events`,
`watch`, `wheel`, `vault`. See `cli/rfq_design.md` for the next major
feature (RFQ) and `todo_cli.md` §5 / §13 for the full pending-work map.

For the full spec, see `cli/PRD.md` (working doc, gitignored).

## License

MIT
