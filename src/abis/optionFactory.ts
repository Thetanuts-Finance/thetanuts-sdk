/**
 * OptionFactory ABI - Complete contract interface for RFQ lifecycle
 * Source: /abi/OptionFactory.json
 */

/**
 * QuotationParameters struct components - used in multiple functions
 */
const QUOTATION_PARAMETERS_COMPONENTS = [
  { name: 'requester', type: 'address', internalType: 'address' },
  {
    name: 'existingOptionAddress',
    type: 'address',
    internalType: 'address',
  },
  { name: 'collateral', type: 'address', internalType: 'address' },
  {
    name: 'collateralPriceFeed',
    type: 'address',
    internalType: 'address',
  },
  { name: 'implementation', type: 'address', internalType: 'address' },
  { name: 'strikes', type: 'uint256[]', internalType: 'uint256[]' },
  { name: 'numContracts', type: 'uint256', internalType: 'uint256' },
  { name: 'requesterDeposit', type: 'uint256', internalType: 'uint256' },
  { name: 'collateralAmount', type: 'uint256', internalType: 'uint256' },
  { name: 'expiryTimestamp', type: 'uint256', internalType: 'uint256' },
  { name: 'offerEndTimestamp', type: 'uint256', internalType: 'uint256' },
  { name: 'isRequestingLongPosition', type: 'bool', internalType: 'bool' },
  { name: 'convertToLimitOrder', type: 'bool', internalType: 'bool' },
  { name: 'extraOptionData', type: 'bytes', internalType: 'bytes' },
] as const;

/**
 * QuotationState struct components - returned from quotations view function
 */
const QUOTATION_STATE_COMPONENTS = [
  { name: 'isActive', type: 'bool', internalType: 'bool' },
  { name: 'currentWinner', type: 'address', internalType: 'address' },
  {
    name: 'currentBestPriceOrReserve',
    type: 'uint256',
    internalType: 'uint256',
  },
  { name: 'feeCollected', type: 'uint256', internalType: 'uint256' },
  { name: 'optionContract', type: 'address', internalType: 'address' },
] as const;

/**
 * QuotationTracking struct components
 */
const QUOTATION_TRACKING_COMPONENTS = [
  { name: 'referralId', type: 'uint256', internalType: 'uint256' },
  { name: 'eventCode', type: 'uint256', internalType: 'uint256' },
] as const;

/**
 * OptionBook.Order struct components - used by settleQuotationEarlyByOrderBook (r12).
 * Mirrors ORDER_COMPONENTS in src/abis/optionBook.ts.
 */
const ORDER_BOOK_ORDER_COMPONENTS = [
  { name: 'maker', type: 'address', internalType: 'address' },
  { name: 'orderExpiryTimestamp', type: 'uint256', internalType: 'uint256' },
  { name: 'collateral', type: 'address', internalType: 'address' },
  { name: 'isCall', type: 'bool', internalType: 'bool' },
  { name: 'priceFeed', type: 'address', internalType: 'address' },
  { name: 'implementation', type: 'address', internalType: 'address' },
  { name: 'isLong', type: 'bool', internalType: 'bool' },
  { name: 'maxCollateralUsable', type: 'uint256', internalType: 'uint256' },
  { name: 'strikes', type: 'uint256[]', internalType: 'uint256[]' },
  { name: 'expiry', type: 'uint256', internalType: 'uint256' },
  { name: 'price', type: 'uint256', internalType: 'uint256' },
  { name: 'numContracts', type: 'uint256', internalType: 'uint256' },
  { name: 'extraOptionData', type: 'bytes', internalType: 'bytes' },
] as const;

export const OPTION_FACTORY_ABI = [
  // ============ Constructor ============
  {
    type: 'constructor',
    inputs: [
      {
        name: '_historicalTWAPConsumer',
        type: 'address',
        internalType: 'address',
      },
      { name: '_revealWindow', type: 'uint256', internalType: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },

  // ============ View Functions ============
  {
    type: 'function',
    name: 'MAX_RFQ_VALUE',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'OFFER_TYPEHASH',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'REVEAL_WINDOW',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'TWAP_PERIOD',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'authorizedRouters',
    inputs: [{ name: '', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'calculateFee',
    inputs: [
      { name: 'numContracts', type: 'uint256', internalType: 'uint256' },
      { name: 'premium', type: 'uint256', internalType: 'uint256' },
      { name: 'price', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'eip712Domain',
    inputs: [],
    outputs: [
      { name: 'fields', type: 'bytes1', internalType: 'bytes1' },
      { name: 'name', type: 'string', internalType: 'string' },
      { name: 'version', type: 'string', internalType: 'string' },
      { name: 'chainId', type: 'uint256', internalType: 'uint256' },
      { name: 'verifyingContract', type: 'address', internalType: 'address' },
      { name: 'salt', type: 'bytes32', internalType: 'bytes32' },
      { name: 'extensions', type: 'uint256[]', internalType: 'uint256[]' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getQuotationCount',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'historicalTWAPConsumer',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'owner',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'quotationTracking',
    inputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    outputs: [
      { name: 'referralId', type: 'uint256', internalType: 'uint256' },
      { name: 'eventCode', type: 'uint256', internalType: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'quotations',
    inputs: [{ name: 'quotationId', type: 'uint256', internalType: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct OptionFactory.QuotationParameters',
        components: QUOTATION_PARAMETERS_COMPONENTS,
      },
      {
        name: '',
        type: 'tuple',
        internalType: 'struct OptionFactory.QuotationState',
        components: QUOTATION_STATE_COMPONENTS,
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'referralFees',
    inputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  // r12-additive views
  {
    type: 'function',
    name: 'MAX_ORACLE_STALENESS',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'MAX_TRANSFER_DUST',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'activeRfqForOption',
    inputs: [{ name: '', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'baseSplitFee',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'claimableTransfers',
    inputs: [
      { name: '', type: 'address', internalType: 'address' },
      { name: '', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'deprecationTime',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'settlementExtension',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'totalClaimableTransfers',
    inputs: [{ name: '', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'returnReferralParameters',
    inputs: [
      { name: 'referralId', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [
      { name: 'collateral', type: 'address', internalType: 'address' },
      {
        name: 'collateralPriceFeed',
        type: 'address',
        internalType: 'address',
      },
      { name: 'implementation', type: 'address', internalType: 'address' },
      { name: 'strikes', type: 'uint256[]', internalType: 'uint256[]' },
      { name: 'expiryTimestamp', type: 'uint256', internalType: 'uint256' },
      {
        name: 'isRequestingLongPosition',
        type: 'bool',
        internalType: 'bool',
      },
      { name: 'extraOptionData', type: 'bytes', internalType: 'bytes' },
    ],
    stateMutability: 'view',
  },

  // ============ Write Functions ============
  {
    type: 'function',
    name: 'cancelOfferForQuotation',
    inputs: [{ name: 'quotationId', type: 'uint256', internalType: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'cancelQuotation',
    inputs: [{ name: 'quotationId', type: 'uint256', internalType: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'makeOfferForQuotation',
    inputs: [
      { name: 'quotationId', type: 'uint256', internalType: 'uint256' },
      { name: 'signature', type: 'bytes', internalType: 'bytes' },
      { name: 'signingKey', type: 'string', internalType: 'string' },
      {
        name: 'encryptedOfferForRequester',
        type: 'string',
        internalType: 'string',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'registerReferral',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        internalType: 'struct OptionFactory.QuotationParameters',
        components: QUOTATION_PARAMETERS_COMPONENTS,
      },
    ],
    outputs: [{ name: 'referralId', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'requestForQuotation',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        internalType: 'struct OptionFactory.QuotationParameters',
        components: QUOTATION_PARAMETERS_COMPONENTS,
      },
      {
        name: 'tracking',
        type: 'tuple',
        internalType: 'struct OptionFactory.QuotationTracking',
        components: QUOTATION_TRACKING_COMPONENTS,
      },
      { name: 'reservePrice', type: 'uint256', internalType: 'uint256' },
      { name: 'requesterPublicKey', type: 'string', internalType: 'string' },
    ],
    outputs: [{ name: 'quotationId', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'revealOffer',
    inputs: [
      { name: 'quotationId', type: 'uint256', internalType: 'uint256' },
      { name: 'offerAmount', type: 'uint256', internalType: 'uint256' },
      { name: 'nonce', type: 'uint64', internalType: 'uint64' },
      { name: 'offeror', type: 'address', internalType: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'settleQuotation',
    inputs: [{ name: 'quotationId', type: 'uint256', internalType: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'settleQuotationEarly',
    inputs: [
      { name: 'quotationId', type: 'uint256', internalType: 'uint256' },
      { name: 'offerAmount', type: 'uint256', internalType: 'uint256' },
      { name: 'nonce', type: 'uint64', internalType: 'uint64' },
      { name: 'offeror', type: 'address', internalType: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  // r12-additive writes (user-facing only — admin setters omitted)
  {
    type: 'function',
    name: 'claimEscrowedFunds',
    inputs: [{ name: 'token', type: 'address', internalType: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'settleQuotationEarlyByOrderBook',
    inputs: [
      { name: 'quotationId', type: 'uint256', internalType: 'uint256' },
      { name: 'optionBook', type: 'address', internalType: 'address' },
      {
        name: 'order',
        type: 'tuple',
        internalType: 'struct OptionBook.Order',
        components: ORDER_BOOK_ORDER_COMPONENTS,
      },
      { name: 'signature', type: 'bytes', internalType: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'swapAndCall',
    inputs: [
      { name: 'swapRouter', type: 'address', internalType: 'address' },
      { name: 'swapSrcToken', type: 'address', internalType: 'address' },
      { name: 'swapDstToken', type: 'address', internalType: 'address' },
      { name: 'swapSrcAmount', type: 'uint256', internalType: 'uint256' },
      { name: 'swapCallData', type: 'bytes', internalType: 'bytes' },
      { name: 'selfCallData', type: 'bytes', internalType: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },

  // ============ Events ============
  {
    type: 'event',
    name: 'CollateralDeposited',
    inputs: [
      {
        name: 'quotationId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'depositor',
        type: 'address',
        indexed: true,
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
    name: 'CollateralReturned',
    inputs: [
      {
        name: 'quotationId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'recipient',
        type: 'address',
        indexed: true,
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
    name: 'EIP712DomainChanged',
    inputs: [],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ExpiredReferralSwept',
    inputs: [
      {
        name: 'referralId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'token',
        type: 'address',
        indexed: true,
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
    name: 'FeePaid',
    inputs: [
      {
        name: 'quotationId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
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
    name: 'FeesWithdrawn',
    inputs: [
      {
        name: 'recipient',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'token',
        type: 'address',
        indexed: true,
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
    name: 'MaxRfqValueUpdated',
    inputs: [
      {
        name: 'oldValue',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'newValue',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OfferAcceptedEarly',
    inputs: [
      {
        name: 'quotationId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'offeror',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'offerAmount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OfferCancelled',
    inputs: [
      {
        name: 'quotationId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'offeror',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'offerSignature',
        type: 'bytes',
        indexed: false,
        internalType: 'bytes',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OfferMade',
    inputs: [
      {
        name: 'quotationId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'offeror',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'offerSignature',
        type: 'bytes',
        indexed: false,
        internalType: 'bytes',
      },
      {
        name: 'signingKey',
        type: 'string',
        indexed: false,
        internalType: 'string',
      },
      {
        name: 'signedOfferForRequester',
        type: 'string',
        indexed: false,
        internalType: 'string',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OfferRevealed',
    inputs: [
      {
        name: 'quotationId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'offeror',
        type: 'address',
        indexed: true,
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
    name: 'OwnershipTransferred',
    inputs: [
      {
        name: 'previousOwner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'newOwner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'PremiumPaid',
    inputs: [
      {
        name: 'quotationId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'recipient',
        type: 'address',
        indexed: true,
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
    name: 'QuotationCancelled',
    inputs: [
      {
        name: 'quotationId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'QuotationRequested',
    inputs: [
      {
        name: 'quotationId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'requester',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'reservePrice',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'requesterPublicKey',
        type: 'string',
        indexed: false,
        internalType: 'string',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'QuotationSettled',
    inputs: [
      {
        name: 'quotationId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'requester',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'winner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'optionAddress',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'QuotationTrackers',
    inputs: [
      {
        name: 'quotationId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'referralId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'tracking',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ReferralRFQExecuted',
    inputs: [
      {
        name: 'referralId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'quotationId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
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
    name: 'ReferralRegistered',
    inputs: [
      {
        name: 'referralId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'referrer',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  // r12-additive events
  {
    type: 'event',
    name: 'BaseSplitFeeUpdated',
    inputs: [
      { name: 'oldFee', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'newFee', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'CollateralDeposited',
    inputs: [
      { name: 'quotationId', type: 'uint256', indexed: true, internalType: 'uint256' },
      { name: 'depositor', type: 'address', indexed: true, internalType: 'address' },
      { name: 'amount', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'CollateralReturned',
    inputs: [
      { name: 'quotationId', type: 'uint256', indexed: true, internalType: 'uint256' },
      { name: 'recipient', type: 'address', indexed: true, internalType: 'address' },
      { name: 'amount', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'EscrowClaimed',
    inputs: [
      { name: 'recipient', type: 'address', indexed: true, internalType: 'address' },
      { name: 'token', type: 'address', indexed: true, internalType: 'address' },
      { name: 'amount', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ExpiredReferralSwept',
    inputs: [
      { name: 'referralId', type: 'uint256', indexed: true, internalType: 'uint256' },
      { name: 'token', type: 'address', indexed: true, internalType: 'address' },
      { name: 'amount', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'FactoryDeprecation',
    inputs: [
      { name: 'timestamp', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'MaxRfqValueUpdated',
    inputs: [
      { name: 'oldValue', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'newValue', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OfferAcceptedFromOrderBook',
    inputs: [
      { name: 'quotationId', type: 'uint256', indexed: true, internalType: 'uint256' },
      { name: 'maker', type: 'address', indexed: true, internalType: 'address' },
      { name: 'premiumAmount', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'optionAddress', type: 'address', indexed: false, internalType: 'address' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'SettlementFailedDueToStateChange',
    inputs: [
      { name: 'quotationId', type: 'uint256', indexed: true, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TransferEscrowed',
    inputs: [
      { name: 'quotationId', type: 'uint256', indexed: true, internalType: 'uint256' },
      { name: 'recipient', type: 'address', indexed: true, internalType: 'address' },
      { name: 'token', type: 'address', indexed: true, internalType: 'address' },
      { name: 'amount', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },

  // ============ Errors ============
  { type: 'error', name: 'BalanceIncorrect', inputs: [] },
  { type: 'error', name: 'InsufficientReferralBalance', inputs: [] },
  { type: 'error', name: 'InvalidOptionOwnership', inputs: [] },
  { type: 'error', name: 'InvalidPriceFeedDecimals', inputs: [] },
  { type: 'error', name: 'InvalidQuotationId', inputs: [] },
  { type: 'error', name: 'InvalidReferralId', inputs: [] },
  { type: 'error', name: 'InvalidShortString', inputs: [] },
  { type: 'error', name: 'InvalidSignature', inputs: [] },
  { type: 'error', name: 'NativeTokenNotAllowedForSwap', inputs: [] },
  { type: 'error', name: 'NoOfferMade', inputs: [] },
  { type: 'error', name: 'NoWinnerToAccept', inputs: [] },
  { type: 'error', name: 'OfferNotCompetitive', inputs: [] },
  { type: 'error', name: 'OfferPeriodEnded', inputs: [] },
  { type: 'error', name: 'OnlyRequesterAllowed', inputs: [] },
  { type: 'error', name: 'OptionExpired', inputs: [] },
  { type: 'error', name: 'OptionOwnedBySameParty', inputs: [] },
  { type: 'error', name: 'PriceFeedStale', inputs: [] },
  { type: 'error', name: 'PriceMustBePositive', inputs: [] },
  { type: 'error', name: 'QuotationNotActive', inputs: [] },
  { type: 'error', name: 'RFQExpiryAfterOptionExpiry', inputs: [] },
  { type: 'error', name: 'ReferralMustBeLong', inputs: [] },
  { type: 'error', name: 'ReferralParamMismatch', inputs: [] },
  { type: 'error', name: 'RevealPeriodEnded', inputs: [] },
  { type: 'error', name: 'RevealPeriodNotEnded', inputs: [] },
  { type: 'error', name: 'RevealPeriodNotStarted', inputs: [] },
  { type: 'error', name: 'SelfReferralNotAllowed', inputs: [] },
  { type: 'error', name: 'SettleWithWinnerViaSwapNotAllowed', inputs: [] },
  {
    type: 'error',
    name: 'StringTooLong',
    inputs: [{ name: 'str', type: 'string', internalType: 'string' }],
  },
  { type: 'error', name: 'SwapAndEarlySettleNotAllowedForShortOptions', inputs: [] },
  { type: 'error', name: 'SwapAndEarlySettleNotRequired', inputs: [] },
  { type: 'error', name: 'SwapAndRFQNotAllowedForExistingOptions', inputs: [] },
  { type: 'error', name: 'SwapFailed', inputs: [] },
  { type: 'error', name: 'TokenMismatch', inputs: [] },
  { type: 'error', name: 'UnauthorizedRouter', inputs: [] },
  { type: 'error', name: 'UnknownSelector', inputs: [] },
  { type: 'error', name: 'WrapperTransferFailed', inputs: [] },
] as const;

// Export struct components for use in types
export {
  QUOTATION_PARAMETERS_COMPONENTS,
  QUOTATION_STATE_COMPONENTS,
  QUOTATION_TRACKING_COMPONENTS,
};
