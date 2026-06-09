// Workflow: RFQ (Factory) — Create custom options via sealed-bid auction
/**
 * RFQ Creation Example
 *
 * This example demonstrates how to create RFQs (Request for Quotation)
 * for both BUY and SELL positions using the Thetanuts SDK.
 *
 * IMPORTANT: collateralAmount is ALWAYS 0 in RFQ params.
 * Collateral is pulled at settlement, not RFQ creation.
 */

import { ethers } from 'ethers';
import { ThetanutsClient, MemoryStorageProvider } from '@thetanuts-finance/thetanuts-client';

// =============================================================================
// Configuration
// =============================================================================

const RPC_URL = 'https://mainnet.base.org';
const PRIVATE_KEY = 'YOUR_PRIVATE_KEY'; // Replace with your key

// =============================================================================
// Initialize Client
// =============================================================================

async function initClient(): Promise<ThetanutsClient> {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);

  const client = new ThetanutsClient({
    chainId: 8453, // Base mainnet
    provider,
    signer,
  });

  return client;
}

// =============================================================================
// Example 1: Create BUY Position RFQ
// =============================================================================

/**
 * Create an RFQ to BUY an option (go long).
 *
 * For BUY positions:
 * - No token approval needed (counterparty provides collateral)
 * - Optional reserve price = maximum you're willing to pay
 */
async function createBuyRFQ(client: ThetanutsClient): Promise<string> {
  const userAddress = await client.signer!.getAddress();

  // Calculate expiry (7 days from now)
  const expiry = Math.floor(Date.now() / 1000) + 86400 * 7;

  // Generate (or load) the ECDH keypair used to decrypt offers from market makers.
  // Keys are automatically persisted to `.thetanuts-keys/` in Node.js; subsequent
  // calls return the same keypair. BACK THIS UP — if you lose the private key,
  // you cannot decrypt offers made to your public key.
  const keyPair = await client.rfqKeys.getOrCreateKeyPair();

  // Build RFQ request using helper
  // This automatically:
  // - Sets collateralAmount = 0 (CRITICAL)
  // - Resolves addresses from chain config
  // - Handles decimal conversions
  const request = client.optionFactory.buildRFQRequest({
    requester: userAddress,
    underlying: 'ETH',           // 'ETH' or 'BTC'
    optionType: 'PUT',           // 'CALL' or 'PUT'
    strike: 1850,                // Human-readable price ($1850)
    expiry: expiry,              // Unix timestamp
    numContracts: 1.5,           // Number of contracts
    isLong: true,                // true = BUY (going long)
    offerDeadlineMinutes: 60,    // Market makers have 60 mins to respond
    collateralToken: 'USDC',     // Collateral token

    // BUY: max price you're willing to pay per contract
    reservePrice: 0.015,         // $0.015 per contract (in USDC)

    // ECDH public key for encrypted offers (real key from above — never a placeholder)
    requesterPublicKey: keyPair.compressedPublicKey,
  });

  // Encode the transaction
  const { to, data } = client.optionFactory.encodeRequestForQuotation(request);

  console.log('Creating BUY RFQ...');
  console.log('To:', to);
  console.log('Strike:', request.params.strikes[0]);
  console.log('Contracts:', request.params.numContracts);

  // Send transaction
  const tx = await client.signer!.sendTransaction({ to, data });
  console.log('Transaction hash:', tx.hash);

  // Wait for confirmation
  const receipt = await tx.wait();
  console.log('RFQ created in block:', receipt?.blockNumber);

  return tx.hash;
}

// =============================================================================
// Example 2: Create SELL Position RFQ
// =============================================================================

/**
 * Create an RFQ to SELL an option (go short).
 *
 * For SELL positions:
 * - MUST approve collateral tokens BEFORE creating RFQ
 * - Collateral calculation depends on option type:
 *   - PUT: approval = strike * numContracts
 *   - CALL (inverse): approval = numContracts (1:1 with underlying)
 */
async function createSellRFQ(client: ThetanutsClient): Promise<string> {
  const userAddress = await client.signer!.getAddress();
  const chainConfig = client.chainConfig;

  // Option parameters
  const strike = 1850;       // $1850 strike
  const numContracts = 1.5;  // 1.5 contracts
  const expiry = Math.floor(Date.now() / 1000) + 86400 * 7;

  // ==========================================================================
  // Step 1: Calculate and approve collateral
  // ==========================================================================

  // For PUT options: approval = strike * numContracts
  // Using USDC (6 decimals)
  const usdcDecimals = chainConfig.tokens.USDC.decimals; // 6
  const approvalAmount = BigInt(Math.round(strike * numContracts * 10 ** usdcDecimals));

  console.log('Approving collateral...');
  console.log('Amount:', approvalAmount.toString(), 'USDC (raw)');

  // Approve USDC for OptionFactory
  await client.erc20.approve(
    chainConfig.tokens.USDC.address,
    client.optionFactory.contractAddress,
    approvalAmount
  );

  console.log('Collateral approved!');

  // ==========================================================================
  // Step 2: Create RFQ (collateralAmount is ALWAYS 0)
  // ==========================================================================

  const keyPair = await client.rfqKeys.getOrCreateKeyPair();

  const request = client.optionFactory.buildRFQRequest({
    requester: userAddress,
    underlying: 'ETH',
    optionType: 'PUT',
    strike: strike,
    expiry: expiry,
    numContracts: numContracts,
    isLong: false,               // false = SELL (going short)
    offerDeadlineMinutes: 60,
    collateralToken: 'USDC',

    // Optional: minimum price you're willing to receive per contract
    reservePrice: 0.010,         // $0.010 per contract minimum

    requesterPublicKey: keyPair.compressedPublicKey,
  });

  // Note: collateralAmount in request.params is 0n (set by buildRFQRequest)
  console.log('collateralAmount:', request.params.collateralAmount); // 0n

  const { to, data } = client.optionFactory.encodeRequestForQuotation(request);

  console.log('Creating SELL RFQ...');
  const tx = await client.signer!.sendTransaction({ to, data });
  console.log('Transaction hash:', tx.hash);

  const receipt = await tx.wait();
  console.log('RFQ created in block:', receipt?.blockNumber);

  return tx.hash;
}

// =============================================================================
// Example 3: Using buildRFQParams (Lower Level)
// =============================================================================

/**
 * If you need more control, use buildRFQParams directly.
 * This returns just the QuotationParameters without tracking/reserve price.
 */
async function createRFQWithParams(client: ThetanutsClient): Promise<void> {
  const userAddress = await client.signer!.getAddress();
  const keyPair = await client.rfqKeys.getOrCreateKeyPair();

  // Build just the params
  const params = client.optionFactory.buildRFQParams({
    requester: userAddress,
    underlying: 'ETH',
    optionType: 'PUT',
    strike: 1850,
    expiry: Math.floor(Date.now() / 1000) + 86400 * 7,
    numContracts: 1.5,
    isLong: true,
    offerDeadlineMinutes: 60,
    collateralToken: 'USDC',
  });

  // collateralAmount is enforced to be 0
  console.log('collateralAmount:', params.collateralAmount); // 0n

  // Encode manually with tracking and reserve price
  const { to, data } = client.optionFactory.encodeRequestForQuotation({
    params,
    tracking: {
      referralId: BigInt(0),  // Or your referral ID
      eventCode: BigInt(0),   // Or your event code
    },
    reservePrice: BigInt(15000), // 0.015 USDC in 6 decimals
    requesterPublicKey: keyPair.compressedPublicKey,
  });

  console.log('Encoded transaction ready');
  console.log('To:', to);
}

// =============================================================================
// Example 4: CALL Option (Inverse Call)
// =============================================================================

/**
 * Create a CALL option RFQ.
 *
 * For CALL options (inverse calls):
 * - Collateral is in underlying token (WETH for ETH calls)
 * - SELL approval: numContracts (1:1 ratio)
 */
async function createCallRFQ(client: ThetanutsClient): Promise<void> {
  const userAddress = await client.signer!.getAddress();
  const chainConfig = client.chainConfig;

  const numContracts = 2.0;

  // For SELL CALL positions, approve WETH
  // Approval = numContracts in WETH (18 decimals)
  const wethDecimals = chainConfig.tokens.WETH.decimals; // 18
  const approvalAmount = BigInt(Math.round(numContracts * 10 ** wethDecimals));

  console.log('Approving WETH for CALL option...');

  await client.erc20.approve(
    chainConfig.tokens.WETH.address,
    client.optionFactory.contractAddress,
    approvalAmount
  );

  const keyPair = await client.rfqKeys.getOrCreateKeyPair();

  const request = client.optionFactory.buildRFQRequest({
    requester: userAddress,
    underlying: 'ETH',
    optionType: 'CALL',          // CALL option
    strike: 2200,                // $2200 strike
    expiry: Math.floor(Date.now() / 1000) + 86400 * 14, // 14 days
    numContracts: numContracts,
    isLong: false,               // SELL
    offerDeadlineMinutes: 60,
    collateralToken: 'WETH',     // WETH for CALL options
    requesterPublicKey: keyPair.compressedPublicKey,
  });

  const { to, data } = client.optionFactory.encodeRequestForQuotation(request);

  console.log('CALL RFQ ready');
  console.log('To:', to);
}

// =============================================================================
// Helper: Generate ECDH Keypair with Persistent Storage
// =============================================================================

/**
 * Generate ECDH keypair for encrypted offers.
 * In Node.js, keys are automatically persisted to .thetanuts-keys/ directory.
 * Store the private key securely - you need it to decrypt MM offers.
 */
async function generateKeyPair(client: ThetanutsClient): Promise<void> {
  // Get or create a keypair (stored automatically in the default Node.js file storage)
  const keyPair = await client.rfqKeys.getOrCreateKeyPair();

  console.log('ECDH Public Key (use in RFQ):', keyPair.compressedPublicKey);
  console.log('Private Key (keep secret):', keyPair.privateKey);

  // You can also generate a new one
  const newKeyPair = client.rfqKeys.generateKeyPair();
  console.log('New keypair:', newKeyPair.compressedPublicKey);
}

// =============================================================================
// Example 5: Initialize with Custom Key Storage
// =============================================================================

/**
 * Configure custom key storage.
 * By default, Node.js uses an internal file provider with ./.thetanuts-keys/.
 */
async function initClientWithCustomStorage(): Promise<ThetanutsClient> {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);

  // Example override for tests or ephemeral agents. Production apps can pass
  // any object implementing KeyStorageProvider.
  const keyStorage = new MemoryStorageProvider();

  const client = new ThetanutsClient({
    chainId: 8453,
    provider,
    signer,
    keyStorageProvider: keyStorage,
  });

  // Keys will be stored in ./my-secure-keys/ directory
  const keyPair = await client.rfqKeys.getOrCreateKeyPair();
  console.log('Key stored at:', keyStorage.getBasePath());
  console.log('Public key:', keyPair.compressedPublicKey);

  return client;
}

// =============================================================================
// Example 6: Access Greeks from Orders
// =============================================================================

/**
 * Fetch orders and access Greeks data.
 * Greeks (delta, gamma, theta, vega, iv) are included in order data
 * from the pricing API.
 */
async function fetchOrdersWithGreeks(client: ThetanutsClient): Promise<void> {
  const orders = await client.api.fetchOrders();

  console.log(`Found ${orders.length} orders\n`);

  for (const order of orders.slice(0, 5)) {
    console.log('Order:', order.order.option);

    if (order.rawApiData?.greeks) {
      const { delta, iv, gamma, theta, vega } = order.rawApiData.greeks;
      console.log(`  Delta: ${delta.toFixed(4)}`);
      console.log(`  IV: ${(iv * 100).toFixed(1)}%`);
      console.log(`  Gamma: ${gamma.toFixed(6)}`);
      console.log(`  Theta: ${theta.toFixed(4)}/day`);
      console.log(`  Vega: ${vega.toFixed(4)}`);
    } else {
      console.log('  Greeks: Not available');
    }
    console.log();
  }
}

// =============================================================================
// Example 7: Fetch Positions with Settlement Details
// =============================================================================

/**
 * Fetch user positions and access settlement details.
 * Settlement data includes payout amounts, settlement price, and exercise status.
 */
async function fetchPositionsWithSettlement(
  client: ThetanutsClient,
  userAddress: string
): Promise<void> {
  const positions = await client.api.getUserPositionsFromIndexer(userAddress);

  console.log(`Found ${positions.length} positions\n`);

  for (const position of positions) {
    console.log(`Position: ${position.id}`);
    console.log(`  Status: ${position.status}`);
    console.log(`  Side: ${position.side}`);
    console.log(`  Contracts: ${Number(position.amount) / 1e18}`);
    console.log(`  Collateral: ${position.collateralAmount} ${position.collateralSymbol}`);
    console.log(`  Buyer: ${position.buyer}`);
    console.log(`  Seller: ${position.seller}`);

    // Settlement details (available for settled positions)
    if (position.settlement) {
      const s = position.settlement;
      console.log('  Settlement:');
      console.log(`    Price: $${Number(s.settlementPrice) / 1e8}`);
      console.log(`    Exercised: ${s.exercised ? 'Yes' : 'No'}`);
      console.log(`    Buyer Payout: ${s.payoutBuyer}`);
      console.log(`    Seller Return: ${s.collateralReturnedSeller}`);

      if (s.oracleFailure) {
        console.log(`    Oracle Failure: ${s.oracleFailureReason}`);
      }
    }
    console.log();
  }
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  console.log('Thetanuts SDK - RFQ Creation Example\n');

  const client = await initClient();
  const chainConfig = client.chainConfig;

  console.log('Chain Config:');
  console.log('  USDC:', chainConfig.tokens.USDC.address);
  console.log('  WETH:', chainConfig.tokens.WETH.address);
  console.log('  OptionFactory:', client.optionFactory.contractAddress);
  console.log();

  // Uncomment to run examples:

  // await createBuyRFQ(client);
  // await createSellRFQ(client);
  // await createRFQWithParams(client);
  // await createCallRFQ(client);
  // await generateKeyPair(client);
  // await initClientWithCustomStorage();
  // await fetchOrdersWithGreeks(client);
  // await fetchPositionsWithSettlement(client, await client.signer!.getAddress());

  console.log('Done!');
}

main().catch(console.error);
