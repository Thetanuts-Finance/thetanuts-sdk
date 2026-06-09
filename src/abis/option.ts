/**
 * BaseOption ABI - Complete contract interface for option positions
 * Source: /abi/BaseOption.json
 */

/**
 * OptionParams struct components - used in initialize function
 */
const OPTION_PARAMS_COMPONENTS = [
  { name: 'collateralToken', type: 'address', internalType: 'address' },
  { name: 'chainlinkPriceFeed', type: 'address', internalType: 'address' },
  {
    name: 'historicalTWAPConsumer',
    type: 'address',
    internalType: 'address',
  },
  { name: 'buyer', type: 'address', internalType: 'address' },
  { name: 'seller', type: 'address', internalType: 'address' },
  { name: 'strikes', type: 'uint256[]', internalType: 'uint256[]' },
  { name: 'expiryTimestamp', type: 'uint256', internalType: 'uint256' },
  { name: 'twapPeriod', type: 'uint256', internalType: 'uint256' },
  { name: 'numContracts', type: 'uint256', internalType: 'uint256' },
  { name: 'collateralAmount', type: 'uint256', internalType: 'uint256' },
  { name: 'rescueAddress', type: 'address', internalType: 'address' },
  { name: 'factoryAddress', type: 'address', internalType: 'address' },
  { name: 'extraOptionData', type: 'bytes', internalType: 'bytes' },
] as const;

export const BASE_OPTION_ABI = [
  // ============ View Functions ============
  {
    type: 'function',
    name: 'PRICE_DECIMALS',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'buyer',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'seller',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'buyerAllowance',
    inputs: [
      { name: '', type: 'address', internalType: 'address' },
      { name: '', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'sellerAllowance',
    inputs: [
      { name: '', type: 'address', internalType: 'address' },
      { name: '', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'collateralToken',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'collateralAmount',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'chainlinkPriceFeed',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'historicalTWAPConsumer',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract HistoricalPriceConsumerV3_TWAP',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'expiryTimestamp',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'twapPeriod',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'numContracts',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'optionSettled',
    inputs: [],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'optionType',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getStrikes',
    inputs: [],
    outputs: [{ name: '', type: 'uint256[]', internalType: 'uint256[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'strikes',
    inputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getImplementation',
    inputs: [],
    outputs: [
      { name: 'implementation', type: 'address', internalType: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'factory',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'rescueAddress',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getTWAP',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'calculatePayout',
    inputs: [{ name: 'price', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'calculateRequiredCollateral',
    inputs: [
      { name: '_strikes', type: 'uint256[]', internalType: 'uint256[]' },
      { name: '_numContracts', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    // Canonical r12 ABI declares this `view`, not `pure` (TNU-AUDIT-0069).
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'simulatePayout',
    inputs: [
      { name: 'price', type: 'uint256', internalType: 'uint256' },
      { name: '_strikes', type: 'uint256[]', internalType: 'uint256[]' },
      { name: '_numContracts', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'packExtraOptionData',
    inputs: [],
    outputs: [{ name: '', type: 'bytes', internalType: 'bytes' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'unpackOptionType',
    inputs: [],
    outputs: [
      { name: 'isQuoteCollateral', type: 'bool', internalType: 'bool' },
      { name: 'isPhysicallySettled', type: 'bool', internalType: 'bool' },
      { name: 'optionStyle', type: 'uint8', internalType: 'uint8' },
      { name: 'optionStructure', type: 'uint8', internalType: 'uint8' },
    ],
    stateMutability: 'view',
  },
  // r12-additive views (BaseOption introspection)
  {
    type: 'function',
    name: 'creator',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'paramsHash',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'splitGeneration',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'optionParent',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'optionChildren',
    inputs: [{ name: '', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getReclaimFee',
    inputs: [{ name: 'ownedOption', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getSplitFee',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'calculateNumContractsForCollateral',
    inputs: [
      { name: '_strikes', type: 'uint256[]', internalType: 'uint256[]' },
      { name: '_collateralAmount', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    // Canonical r12 ABI declares this `view`, not `pure` (TNU-AUDIT-0069).
    stateMutability: 'view',
  },

  // ============ Write Functions ============
  {
    type: 'function',
    name: 'initialize',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        internalType: 'struct BaseOption.OptionParams',
        components: OPTION_PARAMS_COMPONENTS,
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'close',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  // Removed in audit fix (TNU-AUDIT-0046): zero-arg `payout()` does NOT exist
  // on the r12 BaseOption contract. The canonical ABI only declares
  // `calculatePayout(uint256)` (view) and `simulatePayout(...)` (pure); on r12
  // settlement is driven via an internal factory callback, not by an end-user
  // `payout()` call. Generating calldata for a
  // non-existent selector results in a silent on-chain revert.
  {
    type: 'function',
    name: 'split',
    inputs: [
      {
        name: 'splitCollateralAmount',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'isBuyer', type: 'bool', internalType: 'bool' },
      { name: 'target', type: 'address', internalType: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'approveTransfer',
    inputs: [
      { name: 'isBuyer', type: 'bool', internalType: 'bool' },
      { name: 'target', type: 'address', internalType: 'address' },
      { name: 'isApproved', type: 'bool', internalType: 'bool' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'rescueERC20',
    inputs: [
      { name: 'token', type: 'address', internalType: 'contract IERC20' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  // r12-additive writes (user-facing collateral flow)
  {
    type: 'function',
    name: 'reclaimCollateral',
    inputs: [{ name: 'ownedOption', type: 'address', internalType: 'address' }],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'returnExcessCollateral',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'validateParams',
    inputs: [
      { name: '_strikes', type: 'uint256[]', internalType: 'uint256[]' },
    ],
    outputs: [],
    // Canonical r12 ABI declares this `view`, not `pure` (TNU-AUDIT-0069).
    stateMutability: 'view',
  },

  // ============ Events ============
  {
    type: 'event',
    name: 'ExcessCollateralReturned',
    inputs: [
      {
        name: 'seller',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'collateralToken',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'collateralReturned',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OptionInitialized',
    inputs: [
      { name: 'buyer', type: 'address', indexed: true, internalType: 'address' },
      { name: 'seller', type: 'address', indexed: true, internalType: 'address' },
      { name: 'createdBy', type: 'address', indexed: true, internalType: 'address' },
      { name: 'optionType', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'collateralToken', type: 'address', indexed: false, internalType: 'address' },
      { name: 'priceFeed', type: 'address', indexed: false, internalType: 'address' },
      { name: 'strikes', type: 'uint256[]', indexed: false, internalType: 'uint256[]' },
      { name: 'expiryTimestamp', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'numContracts', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'collateralAmount', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'extraOptionData', type: 'bytes', indexed: false, internalType: 'bytes' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ERC20Rescued',
    inputs: [
      {
        name: 'rescueAddress',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'tokenAddress',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OptionClosed',
    inputs: [
      {
        name: 'optionAddress',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'closedBy',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'collateralReturned',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OptionExpired',
    inputs: [
      {
        name: 'optionAddress',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'settlementPrice',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OptionPayout',
    inputs: [
      {
        name: 'optionAddress',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'buyer',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'amountPaidOut',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OptionSettlementFailed',
    inputs: [],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OptionSplit',
    inputs: [
      {
        name: 'newOption',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'collateralAmount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'feePaid',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'counterparty',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RoleTransferred',
    inputs: [
      {
        name: 'optionAddress',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'from',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'to',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'isBuyer',
        type: 'bool',
        indexed: false,
        internalType: 'bool',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TransferApproval',
    inputs: [
      {
        name: 'target',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'from',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'isBuyer',
        type: 'bool',
        indexed: false,
        internalType: 'bool',
      },
      {
        name: 'isApproved',
        type: 'bool',
        indexed: false,
        internalType: 'bool',
      },
    ],
    anonymous: false,
  },
] as const;

// Export OPTION_ABI as alias for backwards compatibility
export const OPTION_ABI = BASE_OPTION_ABI;

// Export the option params components for use in types
export { OPTION_PARAMS_COMPONENTS };
