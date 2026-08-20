# Paying for an RFQ with a Different Token

An RFQ's collateral token is decided by the structure you trade, not by you. If
you don't hold that token, `--pay-with` funds it from something you *do* hold —
in the same transaction, through `OptionFactory.swapAndCall`.

> Available in the CLI (`thetanuts rfq request --pay-with`). SDK users can build
> the same call with `client.optionFactory.encodeSwapAndCall()`; see
> [Overview](overview.md#advanced-swap-and-create-in-one-tx).

## BUY requests only

`--pay-with` applies to `--direction BUY` (a long request), which escrows
`reservePrice` at the moment it is submitted. That escrow is what the swap
funds.

A `--direction SELL` request escrows **nothing** when it is submitted — the
factory pulls collateral from the seller at *settlement*, after a maker fills —
so there is nothing to fund up front and the CLI refuses the combination.
Approve the collateral token before settlement instead (see
[Create an RFQ](create-rfq.md)), or acquire it separately.

## Which collateral does my structure use?

| Structure | Collateral | Notes |
| --- | --- | --- |
| Single-strike ETH CALL | **WETH** | This is `INVERSE_CALL`. The CLI requires `--collateral-token WETH` explicitly, and `--collateral-amount` is denominated in WETH. |
| Puts, call spreads, put spreads, butterflies, condors, iron condors | **USDC** | Passing `--collateral-token WETH` is rejected for these. |
| BTC calls | not yet exposed | Would require cbBTC collateral. |

The collateral row in `rfq build` / `rfq request` output shows the symbol
alongside the address, so you can confirm before submitting.

## What can I pay with?

| Your product's collateral | You can pay with | You cannot pay with |
| --- | --- | --- |
| **WETH** (ETH calls) | `eth` — wrapped 1:1 inside the factory, no approval, no aggregator<br>`usdc`, `cbbtc`, `cbdoge`, `cbxrp`, or any routable Base ERC-20 | `weth` — it is already the collateral |
| **USDC** (everything else) | `weth`, `cbbtc`, `cbdoge`, `cbxrp`, or any routable Base ERC-20 | `eth` — see below<br>`usdc` — already the collateral |

### Native ETH only ever becomes WETH

`swapAndCall` has two mutually exclusive paths, and neither takes native ETH to
a token other than WETH:

- **Wrap path** (`swapRouter = address(0)`): the factory calls
  `swapDstToken.call{value: msg.value}("")`. That only succeeds against a
  contract with a payable `receive()` — i.e. WETH. A USDC destination reverts
  `WrapperTransferFailed`.
- **Swap path** (`swapRouter != address(0)`): sending any `msg.value` reverts
  `NativeTokenNotAllowedForSwap`.

So there is no ETH → USDC route. To fund a USDC-collateral product from ETH,
wrap to WETH first and use `--pay-with weth`.

## Examples

```bash
# Hold USDC, want an ETH call (WETH collateral) — swap happens in the same tx
thetanuts rfq request \
  --underlying ETH --type CALL --strike 4000 --expiry 1787904000 \
  --collateral-token WETH --direction BUY --contracts 0.1 \
  --pay-with usdc --pay-amount 500

# Hold native ETH, same product — wraps 1:1, no approval, no aggregator
thetanuts rfq request ... --collateral-token WETH --pay-with eth

# Hold WETH, want a USDC-collateral put spread
thetanuts rfq request ... --pay-with weth --pay-amount 0.2
```

`--expiry` is a Unix timestamp in **seconds**, and the strike/expiry pair must
exist in the market maker's live quote grid — run
`thetanuts rfq quote --underlying ETH --type call` to see what is currently
tradeable.

Add `--dry-run` to any of these to see the quote, the approval target, and the
calldata without broadcasting.

## Sizing

- `--pay-amount` is **required** for an ERC-20: the CLI cannot quote a route
  without knowing how much you intend to spend.
- `--pay-amount` is **optional** for `eth`: the wrap is exactly 1:1, so it is
  sized automatically from the required deposit.
- **Excess is refunded** by the contract, so erring high is safe.

The required deposit is the request's `reservePrice` — the maximum total the
factory escrows from a buyer. If the quote cannot cover it after slippage, the
CLI refuses before you sign and suggests a larger `--pay-amount` rather than
letting the transaction revert on-chain.

## Safety rails

| Flag | Default | Behaviour |
| --- | --- | --- |
| `--slippage-bps <n>` | `100` (1%) | Aggregator slippage tolerance. Values above 500 bps require `--force-slippage`. |
| `--max-price-impact-bps <n>` | `200` (2%) | Refuses to broadcast above this price impact. |
| `--force-slippage` | off | Accepts impact/slippage above the caps, and accepts a route the aggregator returned without USD pricing. |

Every one of these is evaluated while the plan is built — *before* any approval
transaction is broadcast — so a rejected route costs you no gas.

Additionally, and without any flag:

- Your wallet's balance of the pay-with token (or of ETH, on the wrap path) is
  checked up front, so a shortfall is a readable error rather than an opaque
  transfer revert after the approval has already mined.
- The router is checked against `OptionFactory.authorizedRouters` **on-chain**
  before you are asked to sign.
- The route is re-quoted at the broadcast boundary, never carried through the
  confirmation prompt, and both the price-impact and minimum-output checks
  re-run against the fresh quote.
- **The minimum you are shown is the minimum that is enforced.** Re-quoting
  refreshes the route's internals and its deadline; it can never lower the
  floor you approved. If the refreshed route guarantees less, nothing is
  broadcast and the CLI tells you to quote again. A 0.5% re-quote allowance is
  already priced into the `minReceived` figure at the prompt, so ordinary
  second-to-second price movement does not abort the run.
- **The aggregator's executable calldata is decoded before you sign**, and the
  trade encoded in it is checked against the one you were quoted: the tokens
  spent and bought, the amount, the destination receiver, and the minimum the
  router will enforce on-chain. That decoded minimum — not the plaintext figure
  the API reports alongside it — is what the floor above is compared against.
  A route carrying a router-level fee, or one using an entrypoint the CLI
  cannot decode, is refused rather than signed.
- A route with no USD pricing is refused rather than treated as zero impact.
- The configured chain is asserted against the RPC before the approval and the
  swap are sent.

## Approve the OptionFactory, not the router

The **factory** executes the swap, not your wallet. So the ERC-20 approval goes
to the `OptionFactory` address, and the aggregator route is built with `sender`
and `recipient` both set to the factory. The CLI handles this for you and prints
the approval target explicitly in `--dry-run` output. If you are building the
call yourself with the SDK, approving the router instead of the factory is the
single most common way to mis-wire this flow.

`--pay-with` cannot be combined with `--ensure-allowance`: the latter targets
the collateral token, which is not what you spend on this path.

## Limitations

- BUY (`--direction BUY`) requests only — see [above](#buy-requests-only).
- Base (chainId 8453) only. ERC-20 `--pay-with` is unavailable on other chains.
- `rfq request` only. `book fill` does not support swapping yet — see
  [Fill Orders](../optionbook/fill-orders.md#swapandfillorder) for the
  contract-level equivalent.
- The pay-with token needs a KyberSwap route on Base. Aave receipt tokens
  (`aBasWETH`, `aBascbBTC`, `aBasUSDC`) are in chain config but are unlikely to
  route.
- Cannot be used to close an existing option: `existingOptionAddress` must be
  zero, or the contract reverts `SwapAndRFQNotAllowedForExistingOptions`.

## See Also

- [Create an RFQ](create-rfq.md)
- [RFQ Overview](overview.md)
- [RFQ Lifecycle](lifecycle.md)
