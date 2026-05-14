# thetanuts-cli

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
npm link                           # exposes `thetanuts-cli` on PATH
thetanuts-cli --help
```

`npm link` symlinks the freshly-built `dist/index.js` into your npm global bin
directory. Re-run `npm run build` after editing CLI source — the symlink picks
up changes automatically.

### From npm (after publish)

```sh
npm install -g @thetanuts-finance/cli
```

The package is `@thetanuts-finance/cli`; the binary on PATH is `thetanuts-cli`
(mirrors `thetanuts-mcp` from `mcp-server/`).

Homebrew distribution is not currently planned for v0.1 — `npm install -g` is
sufficient.

## Quick Start

```sh
# No wallet needed — query live data immediately
thetanuts-cli market data
thetanuts-cli chain tokens
thetanuts-cli book orders --underlying ETH --type PUT
thetanuts-cli pricing all --underlying ETH

# Pure helpers, no network
thetanuts-cli util payout --type call --strikes 2000 --price 2150 --contracts 1

# JSON output for scripts
thetanuts-cli -o json market data | jq '.prices.ETH'
```

To trade, run setup:

```sh
thetanuts-cli setup
# Then approvals + a tiny dry-run before any real fill
thetanuts-cli wallet approve --token USDC --for optionBook --amount 100 --dry-run
thetanuts-cli book fill --order-index 0 --collateral 1 --dry-run
```

## Configuration

Precedence (highest first):

1. `--private-key <key>` flag (and `--rpc-url`, `--chain`) on any invocation
2. Environment variables: `THETANUTS_PRIVATE_KEY`, `THETANUTS_RPC_URL`, `THETANUTS_CHAIN`
3. Persisted config at `~/.config/thetanuts/config.json`

The fastest way to get configured is the interactive wizard:

```sh
thetanuts-cli setup
```

Or import a key without running the full wizard:

```sh
thetanuts-cli wallet import       # masked-input prompt
```

Config file shape (`~/.config/thetanuts/config.json`):

```json
{
  "version": 1,
  "chainId": 8453,
  "rpcUrl": "https://mainnet.base.org",
  "ethereumRpcUrl": "https://ethereum-rpc.publicnode.com",
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
- `book orders`, `book preview`, `book max-contracts`, `book fees`,
  `book claimable-fees`, `book referrer-fee-split`, `book hash-order`,
  `book compute-nonce`, `book eip712-domain`
- `position list`, `position info`, `position full`, and every other
  `position` read

Wallet required:

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
$ thetanuts-cli market data
┌────────┬──────────┐
│ key    │ value    │
├────────┼──────────┤
│ ETH    │ 2150.42  │
│ BTC    │ 64210    │
│ ...    │ ...      │
└────────┴──────────┘

$ thetanuts-cli -o json market data
{
  "prices": { "ETH": "2150.42", "BTC": "64210", ... },
  "currentTime": 1747200000,
  "lastUpdated": 1747199997
}
```

Piping works cleanly. EPIPE on stdout is handled, so:

```sh
thetanuts-cli pricing all -o json | head -5
thetanuts-cli -o json market orders --underlying ETH | jq '.[].pricePerContract'
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

Run `thetanuts-cli <group> --help` for a group's subcommands, or
`thetanuts-cli <group> <subcommand> --help` for flags on a specific subcommand.

### `setup` — first-run wizard

Interactive: pick chain, RPC URL, import a private key, set the referrer
address. Writes to `~/.config/thetanuts/config.json` with `chmod 600`.

```sh
thetanuts-cli setup
```

### `config` — inspect and edit persisted config

```sh
thetanuts-cli config show                         # private key masked
thetanuts-cli config path
thetanuts-cli config set chainId 8453
thetanuts-cli config unset referrer
thetanuts-cli config validate                     # checks RPC + key still work
```

### `chain` — chain metadata

```sh
thetanuts-cli chain info                          # chainId, RPC, contracts
thetanuts-cli chain tokens                        # 8 supported tokens
thetanuts-cli chain contracts                     # contract addresses
thetanuts-cli chain implementations               # CALL, PUT, SPREAD, FLY, CONDOR, etc.
thetanuts-cli chain feeds                         # 8 Chainlink price feeds
```

### `wallet` — balances, approvals, transfers

```sh
thetanuts-cli wallet show
thetanuts-cli wallet balance
thetanuts-cli wallet balance --token USDC
thetanuts-cli wallet allowance --token USDC --spender 0x...
thetanuts-cli wallet import
thetanuts-cli wallet approve --token USDC --for optionBook --amount 100
thetanuts-cli wallet transfer --token USDC --to 0x... --amount 10 --dry-run
```

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
thetanuts-cli market data
thetanuts-cli market prices
thetanuts-cli market orders --underlying ETH --type PUT
thetanuts-cli market stats
thetanuts-cli market daily-stats --from 1746800000
thetanuts-cli market positions --address 0x...
thetanuts-cli market history --address 0x...
thetanuts-cli market option --address 0x...
thetanuts-cli market referrer-stats --address 0x...
```

Flags for `market orders`:

| Flag                  | Meaning                                                     |
| --------------------- | ----------------------------------------------------------- |
| `--underlying <sym>`  | Filter by underlying (ETH, BTC, etc.).                      |
| `--type <PUT\|CALL>`  | Filter by option type.                                      |
| `--min-expiry <ts>`   | Filter to orders expiring after this Unix timestamp.        |

### `pricing` — market-maker quotes and ticker math

```sh
thetanuts-cli pricing all --underlying ETH
thetanuts-cli pricing ticker --ticker ETH-16FEB26-1800-P
thetanuts-cli pricing array --underlying ETH
thetanuts-cli pricing spread --underlying ETH --strikes 1800,2000 --expiry 1771228800 --type put
thetanuts-cli pricing butterfly --underlying ETH --strikes 1700,1800,1900 --expiry 1771228800 --type call
thetanuts-cli pricing parse-ticker ETH-16FEB26-1800-P
thetanuts-cli pricing build-ticker --underlying ETH --expiry 1771228800 --strike 1800 --type put
```

### `util` — pure conversions, payout math, validators

```sh
thetanuts-cli util to-price --value 2000               # → 200000000000  (8 dp)
thetanuts-cli util to-usdc --value 100                 # → 100000000     (6 dp)
thetanuts-cli util from-usdc --value 100000000         # → 100
thetanuts-cli util payout --type call --strikes 2000 --price 2150 --contracts 1
thetanuts-cli util validate-address 0x4200000000000000000000000000000000000006
thetanuts-cli util validate-expiry 1771228800
```

### `book` — OptionBook orderflow

```sh
thetanuts-cli book orders --underlying ETH
thetanuts-cli book preview --order-index 0 --collateral 1
thetanuts-cli book max-contracts --order-index 0
thetanuts-cli book fill --order-index 0 --collateral 1 --dry-run
thetanuts-cli book cancel --order-index 0 --dry-run
thetanuts-cli book claim --token USDC
thetanuts-cli book static-fill --order-index 0 --num-contracts 1
```

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
thetanuts-cli position list
thetanuts-cli position info --address 0x...
thetanuts-cli position full --address 0x...
thetanuts-cli position payout-at --address 0x... --price 2100
thetanuts-cli position simulate-payout --address 0x...
thetanuts-cli position close --address 0x... --dry-run
thetanuts-cli position split --address 0x... --collateral 1 --dry-run
thetanuts-cli position transfer --address 0x... --to 0x... --dry-run
thetanuts-cli position calc-payout --type call --strikes 2000 --price 2150 --contracts 1
```

Flags for `position info`:

| Flag                | Meaning                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `--address <addr>`  | Option contract address.                                         |

## Common Workflows

### 1. Browse and research before trading

```sh
thetanuts-cli market data
thetanuts-cli book orders --underlying ETH --type PUT
thetanuts-cli pricing all --underlying ETH
thetanuts-cli book preview --order-index 0 --collateral 1
```

### 2. First-time wallet setup and approvals

```sh
thetanuts-cli setup
thetanuts-cli wallet show
thetanuts-cli wallet balance
thetanuts-cli wallet approve --token USDC --for optionBook --amount 100
```

### 3. Fill an order with dry-run preview, then real fill

```sh
thetanuts-cli book fill --order-index 0 --collateral 1 --dry-run
# Inspect the { approve, fill } calldata. When happy:
thetanuts-cli book fill --order-index 0 --collateral 1
```

### 4. Inspect a position you own

```sh
thetanuts-cli position list
thetanuts-cli position info --address 0xYourOption...
thetanuts-cli position simulate-payout --address 0xYourOption...
```

### 5. Pipe JSON output to scripts

```sh
thetanuts-cli -o json market orders --underlying ETH \
  | jq '.[].pricePerContract'

thetanuts-cli -o json pricing all --underlying ETH \
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
├── index.ts                    Commander root, global flags, EPIPE handler
├── client.ts                   getClient() factory (flag → env → config → default)
├── config.ts                   Load/save ~/.config/thetanuts/config.json (0o600)
├── output.ts                   table / json / csv / yaml renderers; BigInt-safe
├── confirm.ts                  Preview + confirm() + dry-run plumbing
├── options.ts                  Shared Commander option declarations
├── warn.ts                     Shared safety-warning helpers (stderr)
└── commands/
    ├── registry.ts             Wires every group's register(program)
    ├── setup.ts                Interactive first-run wizard
    ├── config.ts               Inspect/edit persisted config
    ├── chain.ts                Chain metadata
    ├── wallet.ts               Balances, allowances, approvals, transfers
    ├── market.ts               Live market reads
    ├── pricing.ts              MM pricing + ticker math
    ├── util.ts                 Pure conversions and validators
    ├── book.ts                 OptionBook orderflow
    └── position.ts             Owned option management
```

For the full spec, see `cli/PRD.md` (working doc, gitignored). For the
pending-work handoff, see `todo_cli.md` at the repo root.

## License

MIT
