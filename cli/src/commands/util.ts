import type { Command } from 'commander';
import { getGlobalOpts } from '../options.js';
import { getClient } from '../client.js';
import { render, renderError } from '../output.js';
import {
  toBigInt,
  fromBigInt,
  isPhysicalProduct,
  isBaseCollateral,
  premiumPerContract,
  calculateNumContracts,
  calculateReservePrice,
  calculateCollateralRequired,
  calculateDeliveryAmount,
  validateButterfly,
  validateCondor,
  validateIronCondor,
  validateRanger,
  validateAddress,
  validateOrderExpiry,
  validateFillSize,
  validateBuySlippage,
  validateSellSlippage,
} from '@thetanuts-finance/thetanuts-client';
import type { ProductName } from '@thetanuts-finance/thetanuts-client';

/**
 * `thetanuts util` — pure helpers. No RPC. Most subcommands call SDK named
 * exports directly; a few (the strike/usdc/price convenience converters) use
 * `client.utils` because they're instance methods.
 */
export function register(program: Command): void {
  const grp = program
    .command('util')
    .description('Helpers: unit conversion, payout math, structure validation');

  // -------------------------------------------------- decimal conversions
  grp
    .command('to-bigint')
    .description('Convert a decimal value to bigint with given decimals')
    .requiredOption('--value <n>', 'decimal value (e.g. 1.5)')
    .requiredOption('--decimals <d>', 'target decimals (e.g. 18)')
    .action((_localOpts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ value: string; decimals: string }>();
      try {
        const result = toBigInt(local.value, Number(local.decimals));
        render({ result: result.toString() }, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('from-bigint')
    .description('Convert a bigint value to decimal string with given decimals')
    .requiredOption('--value <bn>', 'bigint value as string')
    .requiredOption('--decimals <d>', 'source decimals')
    .action((_localOpts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ value: string; decimals: string }>();
      try {
        const result = fromBigInt(BigInt(local.value), Number(local.decimals));
        render({ result }, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // Convenience decimal helpers — use client.utils.* instance methods.
  const addDecimalConv = (
    name: string,
    desc: string,
    fn: (value: string, client: ReturnType<typeof getClient>['client']) => string
  ) => {
    grp
      .command(name)
      .description(desc)
      .requiredOption('--value <n>', 'value (decimal for to-*, bigint for from-*)')
      .action((_localOpts, cmd: Command) => {
        const opts = getGlobalOpts(cmd);
        const { value } = cmd.opts<{ value: string }>();
        try {
          const { client } = getClient(opts);
          const result = fn(value, client);
          render({ result }, { output: opts.output, noColor: !opts.color });
        } catch (err) {
          renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
          process.exit(1);
        }
      });
  };

  addDecimalConv('to-price', 'Convert to 8-decimal price bigint', (v, c) =>
    c.utils.toPriceDecimals(v).toString()
  );
  addDecimalConv('to-strike', 'Convert to 8-decimal strike bigint', (v, c) =>
    c.utils.toStrikeDecimals(v).toString()
  );
  addDecimalConv('to-usdc', 'Convert to 6-decimal USDC bigint', (v, c) =>
    c.utils.toUsdcDecimals(v).toString()
  );
  addDecimalConv('from-price', 'Convert 8-decimal price bigint to string', (v, c) =>
    c.utils.fromPriceDecimals(BigInt(v))
  );
  addDecimalConv('from-strike', 'Convert 8-decimal strike bigint to string', (v, c) =>
    c.utils.fromStrikeDecimals(BigInt(v))
  );
  addDecimalConv('from-usdc', 'Convert 6-decimal USDC bigint to string', (v, c) =>
    c.utils.fromUsdcDecimals(BigInt(v))
  );

  // ---------------------------------------------------------- payout
  grp
    .command('payout')
    .description('Calculate option payout at a settlement price')
    .requiredOption('--type <type>', 'call|put|call_spread|put_spread')
    .requiredOption('--strikes <s>', 'strike(s), comma-separated (1 for vanilla, 2 for spread)')
    .requiredOption('--price <n>', 'settlement price (decimal, e.g. 2050)')
    .requiredOption('--contracts <n>', 'number of contracts (decimal, e.g. 0.1)')
    .action((_localOpts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        type: string;
        strikes: string;
        price: string;
        contracts: string;
      }>();
      try {
        const { client } = getClient(opts);
        const strikes = local.strikes
          .split(',')
          .map((s) => s.trim())
          .map((s) => client.utils.toStrikeDecimals(s));
        const settlementPrice = client.utils.toPriceDecimals(local.price);
        // PRD: contracts → toBigInt(n, 6). This matches the USDC-style payout
        // scaling (calculatePayout returns in 6-decimal USDC units by default).
        const numContracts = toBigInt(local.contracts, 6);
        const payoutBn = client.utils.calculatePayout({
          type: local.type as 'call' | 'put' | 'call_spread' | 'put_spread',
          strikes,
          settlementPrice,
          numContracts,
          // numContracts is in 6-decimal units (USDC), so sizeDecimals=6
          sizeDecimals: 6,
        });
        const payout = fromBigInt(payoutBn, 6);
        render({ payout }, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // --------------------------------------------------- num-contracts
  grp
    .command('num-contracts')
    .description('Buy formula: numContracts = usdcAmount / pricePerContract')
    .requiredOption('--usdc-amount <n>', 'USDC trade amount (decimal)')
    .requiredOption('--price-per-contract <n>', 'price per contract in USDC (decimal)')
    .option('--product <product>', 'product name (default: PUT — affects multi-leg formulas)', 'PUT')
    .action((_localOpts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ usdcAmount: string; pricePerContract: string; product: string }>();
      try {
        // The SDK's calculateNumContracts takes a structured product/strikes
        // object; for a pure "usdc / price" buy-side calc we feed it as a
        // base-collateral product (treats mmPrice as collateral-native price).
        // Result equals usdcAmount / pricePerContract.
        const result = calculateNumContracts({
          tradeAmount: Number(local.usdcAmount),
          product: local.product as ProductName,
          strikes: [],
          isBuy: true,
          mmPrice: Number(local.pricePerContract),
          // For base-collateral products, premiumPerContract === mmPrice; for
          // quote-collateral, premiumPerContract === mmPrice * spot. To make
          // this match the simple "usdcAmount / pricePerContract" formula
          // regardless of product, we treat the passed pricePerContract as
          // already-in-collateral-units by passing spot=1.
          spot: 1,
        });
        render({ numContracts: result }, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // --------------------------------------------- collateral-required
  grp
    .command('collateral-required')
    .description('Calculate seller collateral required (in collateral token units)')
    .requiredOption('--type <product>', 'product name (e.g. PUT, CALL_SPREAD, PUT_SPREAD, ...)')
    .requiredOption('--strikes <s>', 'strike(s), comma-separated decimals (e.g. 2000 or 1800,2000)')
    .requiredOption('--contracts <n>', 'number of contracts (decimal)')
    .action((_localOpts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ type: string; strikes: string; contracts: string }>();
      try {
        const product = local.type.toUpperCase() as ProductName;
        const strikes = local.strikes.split(',').map((s) => Number(s.trim()));
        const numContracts = Number(local.contracts);
        const result = calculateCollateralRequired(numContracts, product, strikes);
        render(
          { product, collateralRequired: result },
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // -------------------------------------------------- reserve-price
  grp
    .command('reserve-price')
    .description('Calculate total reserve price = numContracts * premiumPerContract')
    .requiredOption('--type <product>', 'product name')
    .requiredOption('--strikes <s>', 'strike(s) (informational; not required by formula)')
    .requiredOption('--contracts <n>', 'number of contracts')
    .requiredOption('--mm-price <n>', 'raw MM price (fraction of underlying)')
    .requiredOption('--spot <n>', 'spot price in USD')
    .action((_localOpts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        type: string;
        strikes: string;
        contracts: string;
        mmPrice: string;
        spot: string;
      }>();
      try {
        const product = local.type.toUpperCase() as ProductName;
        const result = calculateReservePrice(
          Number(local.contracts),
          Number(local.mmPrice),
          Number(local.spot),
          product
        );
        render({ product, reservePrice: result }, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ------------------------------------------------- delivery-amount
  grp
    .command('delivery-amount')
    .description('Calculate delivery amount for a physical option')
    .requiredOption('--type <product>', 'product name (PHYSICAL_CALL|PHYSICAL_PUT for physical)')
    .requiredOption('--strikes <s>', 'strike(s), comma-separated decimals')
    .requiredOption('--contracts <n>', 'number of contracts')
    .option('--underlying <sym>', 'underlying (ETH|BTC) for PHYSICAL_PUT delivery token', 'ETH')
    .action((_localOpts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        type: string;
        strikes: string;
        contracts: string;
        underlying: string;
      }>();
      try {
        const product = local.type.toUpperCase() as ProductName;
        const strikes = local.strikes.split(',').map((s) => Number(s.trim()));
        const result = calculateDeliveryAmount(
          Number(local.contracts),
          product,
          strikes,
          local.underlying.toUpperCase() as 'ETH' | 'BTC'
        );
        render(result, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // -------------------------------------------- premium-per-contract
  grp
    .command('premium-per-contract')
    .description('Convert raw MM price to per-contract premium in collateral units')
    .requiredOption('--price <n>', 'raw MM price (fraction of underlying)')
    .requiredOption('--num-contracts <n>', 'number of contracts (decimal)')
    .option('--product <product>', 'product name (decides base vs quote collateral)', 'PUT')
    .option('--spot <n>', 'spot price in USD (required for quote-collateral products)', '0')
    .action((_localOpts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        price: string;
        numContracts: string;
        product: string;
        spot: string;
      }>();
      try {
        const product = local.product.toUpperCase() as ProductName;
        // premiumPerContract is per-contract; multiply by --num-contracts for
        // the user-facing total.
        const perContract = premiumPerContract(
          Number(local.price),
          Number(local.spot),
          product
        );
        const total = perContract * Number(local.numContracts);
        render(
          { perContract, total, product },
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ------------------------------------------------------- validators
  const addValidator = (
    name: string,
    desc: string,
    strikeCount: number,
    fn: (strikes: number[]) => { valid: boolean; error?: string }
  ) => {
    grp
      .command(name)
      .description(desc)
      .requiredOption('--strikes <s>', `${strikeCount} strikes, comma-separated`)
      .action((_localOpts, cmd: Command) => {
        const opts = getGlobalOpts(cmd);
        const { strikes } = cmd.opts<{ strikes: string }>();
        const arr = strikes.split(',').map((s) => Number(s.trim()));
        const result = fn(arr);
        if (!result.valid) {
          renderError(new Error(result.error ?? `Invalid strikes for ${name}`), {
            jsonErrors: Boolean(opts.jsonErrors),
            noColor: !opts.color,
          });
          process.exit(2);
        }
        render({ valid: true }, { output: opts.output, noColor: !opts.color });
      });
  };

  addValidator('validate-butterfly', 'Validate butterfly strikes (3, equidistant)', 3, validateButterfly);
  addValidator('validate-condor', 'Validate condor strikes (4, equal spread widths)', 4, validateCondor);
  addValidator('validate-iron-condor', 'Validate iron condor strikes (4, no overlap)', 4, validateIronCondor);
  addValidator('validate-ranger', 'Validate ranger strikes (4, equal widths + zone gap)', 4, validateRanger);

  // --------------------------------------------------- validate-address
  grp
    .command('validate-address <addr>')
    .description('Validate an Ethereum address. Exit 0 if valid, 2 if not.')
    .action((addr: string, _localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        validateAddress(addr, 'address');
        render({ valid: true }, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(2);
      }
    });

  // ---------------------------------------------------- validate-expiry
  grp
    .command('validate-expiry <ts>')
    .description('Validate an order expiry (must be >60s in the future). Exit 0 if valid, 2 if not.')
    .action((ts: string, _localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        validateOrderExpiry(Number(ts));
        render({ valid: true }, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(2);
      }
    });

  // ------------------------------------------------- validate-fill-size
  grp
    .command('validate-fill-size')
    .description('Validate a fill size against available size. Exit 0 if valid, 2 if not.')
    .requiredOption('--size <n>', 'requested size (bigint as string)')
    .option('--available <n>', 'available size (bigint as string)')
    .option('--min <n>', 'minimum size (bigint as string)')
    .action((_localOpts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ size: string; available?: string; min?: string }>();
      try {
        // PRD only requires --size; default available to MAX bigint when
        // not provided so the size>0 check still runs.
        const size = BigInt(local.size);
        const available = local.available ? BigInt(local.available) : 2n ** 128n;
        const minSize = local.min ? BigInt(local.min) : undefined;
        if (minSize !== undefined) {
          validateFillSize(size, available, minSize);
        } else {
          validateFillSize(size, available);
        }
        render({ valid: true }, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(2);
      }
    });

  // ------------------------------------------------- validate-slippage
  grp
    .command('validate-slippage')
    .description('Validate price against slippage tolerance. Exit 0 if valid, 2 if not.')
    .requiredOption('--side <side>', 'buy|sell')
    .requiredOption('--price <n>', 'actual price (bigint as string)')
    .requiredOption('--slippage-bps <n>', 'slippage tolerance in basis points')
    .option('--reference-price <n>', 'reference price (bigint string); defaults to actual price')
    .action((_localOpts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        side: string;
        price: string;
        slippageBps: string;
        referencePrice?: string;
      }>();
      try {
        const actual = BigInt(local.price);
        const bps = BigInt(local.slippageBps);
        const reference = local.referencePrice ? BigInt(local.referencePrice) : actual;
        const basisPoints = 10000n;
        if (local.side.toLowerCase() === 'buy') {
          // Max acceptable price = reference + slippage
          const maxPrice = (reference * (basisPoints + bps)) / basisPoints;
          validateBuySlippage(actual, maxPrice);
        } else {
          // Min acceptable price = reference - slippage
          const minPrice = (reference * (basisPoints - bps)) / basisPoints;
          validateSellSlippage(actual, minPrice);
        }
        render({ valid: true }, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(2);
      }
    });

  // -------------------------------------------------------- is-physical
  grp
    .command('is-physical')
    .description('Check whether a product is physically settled')
    .requiredOption('--type <product>', 'product name (e.g. PHYSICAL_CALL, PUT)')
    .action((_localOpts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const { type } = cmd.opts<{ type: string }>();
      try {
        const physical = isPhysicalProduct(type.toUpperCase() as ProductName);
        render({ physical }, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // --------------------------------------------------- is-base-collateral
  grp
    .command('is-base-collateral')
    .description('Check whether a token symbol is the base (underlying) collateral for its products')
    .requiredOption('--token <sym>', 'token symbol (USDC|WETH|cbBTC)')
    .action((_localOpts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const { token } = cmd.opts<{ token: string }>();
      try {
        // The SDK's `isBaseCollateral` takes a ProductName, not a token. We
        // map the user-supplied token to the canonical "base-collateral"
        // product it represents (WETH → INVERSE_CALL, cbBTC → INVERSE_CALL,
        // USDC → PUT) and report the result. We also pull the token's
        // address from chainConfig.tokens for context.
        const { client } = getClient(opts);
        const upper = token.toUpperCase();
        const cfgKey = upper === 'WETH' ? 'WETH' : upper === 'CBBTC' ? 'cbBTC' : upper;
        const tokenCfg = (client.chainConfig.tokens as Record<string, { address: string; symbol: string; decimals: number } | undefined>)[cfgKey];
        // WETH and cbBTC are base-collateral tokens; USDC is not.
        const probeProduct: ProductName =
          upper === 'WETH' || upper === 'CBBTC' ? 'INVERSE_CALL' : 'PUT';
        const baseCollateral = isBaseCollateral(probeProduct);
        render(
          {
            token: cfgKey,
            address: tokenCfg?.address ?? null,
            baseCollateral: upper === 'WETH' || upper === 'CBBTC' ? baseCollateral : false,
          },
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });
}
