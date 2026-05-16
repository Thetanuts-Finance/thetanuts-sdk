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
- `rfq build`, `rfq get` — builders and read views.

Keystore required (no signing wallet needed):

- `rfq offers` — lists OfferMade events for an RFQ and decrypts those
  addressed to the keystore. Needs an RFQ key from `keys generate`.

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

### Exit codes

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| `0`  | Success                                                              |
| `1`  | Generic error (network, RPC, contract revert) — also `keys show` when no RFQ key is stored |
| `2`  | Usage error (bad flags, missing required arg)                        |
| `3`  | Confirmation refused / dry-run aborted                               |
| `4`  | Config / wallet / keyfile error (missing key, bad key file)          |
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
thetanuts wallet allowance --token USDC --spender 0x...

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
thetanuts market stats                         # protocol-wide stats
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
thetanuts book max-contracts --order-index 0
thetanuts book check --underlying ETH --type PUT --strike 2200 --expiry 1778832000 --direction sell

# Write (broadcast — use --dry-run first)
thetanuts book fill --order-index 0 --collateral 1 --dry-run
```

`book check` is a deterministic port of OpenClaw's pre-trade liquidity
analyzer. It returns matching orderbook orders + best price + available
size + partial-fill availability + nearby strikes within 5% + a
recommendation (`orderbook` vs `rfq`) with reason. Useful before a
`book fill` or an `rfq request`.

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
thetanuts position payout --address 0x... --dry-run
thetanuts position calc-payout --type call --strikes 2000 --price 2150 --contracts 1
```

Flags for `position info`:

| Flag                | Meaning                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `--address <addr>`  | Option contract address.                                         |

### `keys` — ECDH keypair management for sealed-bid RFQ

The RFQ workflow uses a sealed-bid auction. Makers encrypt offer amounts
to the requester's compressed public key (ECDH + AES-256-GCM); only the
requester's matching private key can decrypt them. The `keys` group
manages that keypair — one keypair per chain, persisted under
`<config-dir>/rfq-keys/` with `chmod 700` on the directory and `chmod
600` on the key file.

```sh
thetanuts keys generate                        # generate + persist (or load existing)
thetanuts keys show                            # public key + storage path (NEVER the private key)
thetanuts keys export --out ~/rfq-key-backup.key
thetanuts keys import --in ~/rfq-key-backup.key
thetanuts keys remove --force                  # destroy the key (strands every prior RFQ — back up first!)
```

| Subcommand        | Exit codes                                                        |
| ----------------- | ----------------------------------------------------------------- |
| `keys generate`   | 0 success / 1 internal error                                      |
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

Full requester lifecycle in 8 subcommands: build → request → see offers →
accept (optional) → settle → check status. The maker side (encrypt + sign +
submit an offer) is intentionally out of scope — real makers run dedicated
MM bots, and OpenClaw is also requester-only.

```sh
# Build an RFQRequest off-chain from human inputs (no RPC).
# Multi-leg structures auto-detected from --strikes count.
thetanuts rfq build --underlying ETH --type PUT --strike 1900 \
  --expiry 1800000000 --contracts 1 --direction buy
thetanuts rfq build --underlying ETH --type PUT --strikes 1900,1800        # PUT_SPREAD
thetanuts rfq build --underlying ETH --type CALL --strikes 2000,2050,2100  # CALL_FLY
thetanuts rfq build --underlying ETH --type PUT --strikes 1800,1900,2100,2200 \
  --structure iron-condor                                                  # IRON_CONDOR

# Save a build artifact for later reuse
thetanuts rfq build --underlying ETH --type PUT --strike 1900 \
  --expiry 1800000000 --contracts 1 --direction buy --out /tmp/build.json

# Inspect a quotation by ID
thetanuts rfq get --id 42

# Submit an RFQ. Auto-stamps requesterPublicKey from the RFQ keystore
# (creates one if missing). Always dry-run first.
thetanuts rfq request --underlying ETH --type PUT --strike 1900 \
  --expiry 1800000000 --contracts 1 --direction buy --dry-run
thetanuts rfq request --underlying ETH --type PUT --strike 1900 \
  --expiry 1800000000 --contracts 1 --direction buy
thetanuts rfq request --from-build-file /tmp/build.json --dry-run

# For SHORT (--direction sell) requests, optionally ensure collateral
# allowance to the OptionFactory at request time:
thetanuts rfq request --underlying ETH --type PUT --strike 1900 \
  --expiry 1800000000 --contracts 1 --direction sell \
  --ensure-allowance --approve-amount max

# Cancel an RFQ you created (only the original requester can cancel)
thetanuts rfq cancel --id 42 --dry-run
thetanuts rfq cancel --id 42
```

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
# List every OfferMade event for an RFQ, with decrypted amounts where
# your keystore can open them. Marks undecryptable rows so you can spot
# key-mismatch / cross-chain bleed-through.
thetanuts rfq offers --id 42

# Accept a specific offer (OPTIONAL — see disclaimer below). By default,
# walks OfferMade events and decrypts the matching one to recover
# (offerAmount, nonce). Or pass them explicitly to skip decryption.
thetanuts rfq accept --id 42 --offeror 0xMakerAddress --dry-run
thetanuts rfq accept --id 42 --offeror 0xMakerAddress
thetanuts rfq accept --id 42 --offeror 0xMakerAddress \
  --offer-amount 420000 --nonce 1234567890
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
