import { solversAbi } from "@solvers/contracts-client";
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, parseAbi, type Hex } from "viem";

/** Decoded contract error: the custom error name (or a generic kind) and a short English message for logs/UI fallbacks. */
export type SolversError = { name: string; args: readonly unknown[]; message: string };

// User-facing defaults; the web maps `name` to its own i18n strings and falls back to these.
const MESSAGES: Record<string, string> = {
  SoldOut: "This Solver is sold out: every license allowed by its cap was already issued.",
  PriceChanged: "The price changed. Review the new price and try again.",
  PriceTooLow: "The amount is below the minimum purchase.",
  DuplicatePurchase: "This purchase was already completed.",
  SelfPurchase: "Creators cannot buy their own Solver.",
  SelfReview: "Creators cannot review their own Solver.",
  AgentNotActive: "This Solver is not available for sale right now.",
  AgentNotFound: "This Solver does not exist on-chain.",
  InsufficientStake: "The creator's stake is below the minimum; sales are paused for this Solver.",
  PayPerUseDisabled: "This Solver does not sell pay-per-use credits.",
  BuyerNotEligible: "This wallet lost too many guarantee disputes to open a new guarantee.",
  Paused: "The platform paused this operation. Try again later.",
  TransfersPaused: "License transfers are paused right now.",
  RoyaltyNotPaid: "The transfer royalty could not be paid: approve the amount and keep enough balance.",
  RoyaltyChanged: "The transfer royalty changed. Review the new amount and try again.",
  NoLicense: "A license or purchased credits are required to review this Solver.",
  LicenseAlreadyReviewed: "This license was already used for a review by another wallet.",
  InvalidRating: "The rating must be between 1 and 5.",
  NoCredits: "Not enough credits.",
  NotBuyer: "Only the buyer can do this.",
  InvalidMilestoneStatus: "This step of the guarantee cannot do that in its current state.",
  AutoReleaseNotReached: "The review window of this step is still open.",
  DisputeWindowClosed: "The window to contest this step has closed.",
  DeliveryDeadlineNotReached: "The delivery deadline has not passed yet.",
  DisputeSlaNotReached: "The dispute can only be refunded automatically after 7 days without a decision.",
  StaleDisputeNeedsJudgment: "This step passed its tests; only the platform can decide the dispute.",
  NothingToClaim: "There is nothing to claim.",
  RecipientBlocked: "Your wallet's receive policy blocks this payment. Update it and try again.",
  NotCreator: "Only the Solver's creator can do this.",
  AccessControlUnauthorizedAccount: "This wallet is not allowed to do this.",
  InsufficientAllowance: "The token allowance is too low.",
  InsufficientBalance: "Not enough balance.",
  PolicyForbids: "The token's policy blocks this transfer.",
  ContractPaused: "The payment token is paused right now.",
  InvalidRecipient: "This address cannot receive the payment token.",
  PermitExpired: "The signed approval expired. Sign again.",
  InvalidSignature: "The signed approval is invalid.",
};

const GENERIC = "The transaction was rejected by the contract.";

/**
 * Decodes a contract revert from a viem error (or raw revert data) into the Solvers custom error name.
 * Falls back to `{ name: "Unknown" }` when the data matches no Solvers or TIP-20 error.
 */
export function decodeSolversError(err: unknown): SolversError {
  const data = revertData(err);
  if (data) {
    try {
      const d = decodeErrorResult({ abi: solversAbi, data });
      return { name: d.errorName, args: d.args ?? [], message: MESSAGES[d.errorName] ?? GENERIC };
    } catch {
      // not a Solvers error: try the TIP-20 errors below
    }
    try {
      const d = decodeErrorResult({ abi: TIP20_ERRORS_ABI, data });
      return { name: d.errorName, args: d.args ?? [], message: MESSAGES[d.errorName] ?? GENERIC };
    } catch {
      // not a TIP-20 precompile error either
    }
  }
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
      const name = reverted.data.errorName;
      return { name, args: reverted.data.args ?? [], message: MESSAGES[name] ?? GENERIC };
    }
  }
  return { name: "Unknown", args: [], message: GENERIC };
}

/** TIP-20 precompile errors (tempo-std ITIP20, https://tempo.xyz/developers/docs/protocol/tip20/spec). */
export const TIP20_ERRORS_ABI = parseAbi([
  "error ContractPaused()",
  "error InsufficientAllowance()",
  "error InsufficientBalance(uint256 currentBalance, uint256 expectedBalance, address token)",
  "error InvalidAmount()",
  "error InvalidRecipient()",
  "error PolicyForbids()",
  "error ProtectedAddress()",
  "error SupplyCapExceeded()",
  "error PermitExpired()",
  "error InvalidSignature()",
]);

function revertData(err: unknown): Hex | undefined {
  if (typeof err === "string" && err.startsWith("0x")) return err as Hex;
  if (err instanceof BaseError) {
    const withData = err.walk((e) => typeof (e as { data?: unknown }).data === "string");
    const d = (withData as { data?: unknown } | null)?.data;
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) return d as Hex;
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted?.raw) return reverted.raw;
  }
  return undefined;
}

/** Name → default message table (exported for the web's i18n fallback and tests). */
export const SOLVERS_ERROR_MESSAGES: Readonly<Record<string, string>> = MESSAGES;
