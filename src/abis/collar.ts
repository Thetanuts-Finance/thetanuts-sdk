/**
 * Collar Loan Contract ABIs
 *
 * ABIs for the CollarLoanCoordinator wrapper that sits on top of Thetanuts V4.
 * A collar loan is a zero-interest loan where the borrower buys a put at K_lo
 * (default protection) and sells a call at K_hi (cap). The MM funds the loan
 * from the call premium it earns; settlement matches the leg payouts.
 *
 * Status: collar-v12 contracts are not yet deployed on Base mainnet. Read-only
 * pricing math works against Deribit data only; write methods require live
 * contracts.
 */

export const COLLAR_COORDINATOR_ABI = [
  // ─── Reads ───
  'function tryGetMaxCapStrike(address underlying, address feed, address settlement) view returns (bool ok, uint256 max)',
  'function getMaxCapStrike(address underlying, address feed, address settlement) view returns (uint256)',
  'function previewKLo(uint256 loanAmount, address collateralToken, address settlementToken, uint256 N) view returns (uint256)',
  'function loanRequests(uint256) view returns (address requester, uint256 collateralAmount, uint256 capStrike, uint256 expiryTimestamp, address collateralToken, address settlementToken, bool isSettled, address settledOptionContract, bool loanClaimed)',
  'function fee() view returns (uint256)',
  'function optionFactory() view returns (address)',
  // ─── Writes ───
  'function requestLoan(tuple(address collateralToken, address priceFeed, address settlementToken, uint256 collateralAmount, uint256 capStrike, uint256 expiryTimestamp, uint256 offerEndTimestamp, uint256 minLoan, string requesterPublicKey) params) returns (uint256 quotationId)',
  'function settleQuotationEarly(uint256 quotationId, uint256 offerAmount, uint64 nonce, address offeror)',
  'function cancelLoan(uint256 quotationId)',
  // ─── Events ───
  'event LoanRequested(uint256 indexed quotationId, address indexed requester, address indexed collateralToken, address settlementToken, uint256 collateralAmount, uint256 minLoan, uint256 capStrike, uint256 expiryTimestamp, uint256 offerEndTimestamp)',
  'event LoanClaimed(uint256 indexed quotationId, address indexed requester, uint256 amount)',
  'event LoanCancelled(uint256 indexed quotationId, address indexed requester)',
];

/**
 * CollaredCallOption — the option contract that settles a collar at expiry.
 *
 * Three terminal states:
 *   • walk        — TWAP below trigger; borrower keeps loan, MM keeps collateral
 *   • repay       — TWAP in the band; borrower repays loanAmount, reclaims collateral
 *   • capSettle   — TWAP above cap; MM pays (cap - trigger) * N; MM keeps collateral
 */
export const COLLARED_CALL_OPTION_ABI = [
  'function exercise()',
  'function doNotExercise()',
  'function buyer() view returns (address)',
  'function seller() view returns (address)',
  'function collateralToken() view returns (address)',
  'function collateralAmount() view returns (uint256)',
  'function expiryTimestamp() view returns (uint256)',
  'function capStrike() view returns (uint256)',
  'function triggerStrike() view returns (uint256)',
  'function getTWAP() view returns (uint256)',
  'function settlementToken() view returns (address)',
  'function loanAmount() view returns (uint256)',
  'function settled() view returns (bool)',
  'event CollarExercised(address indexed buyer, address indexed seller, uint256 settlementAmount, uint8 outcome)',
];
