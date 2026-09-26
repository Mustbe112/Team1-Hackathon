/**
 * Pure logic for the Position / Exit-rule panel.
 *
 * Every threshold, health value, and price is an integer `bigint`: basis points
 * (bps) or 1e18-scaled. No float ever enters state logic — the functions here
 * only convert and format at the UI boundary, and they still use integer math.
 */

/** 100% expressed in basis points. */
export const BPS_DENOMINATOR = 10_000n;

/** The bps value of one whole percent (1% = 100 bps). */
const BPS_PER_PERCENT = 100n;

/** Format integer basis points as percent copy, e.g. `7050n` -> `"70.5%"`. */
export function bpsToCopy(bps: bigint): string {
  const whole = bps / BPS_PER_PERCENT;
  const fraction = bps % BPS_PER_PERCENT;
  if (fraction === 0n) {
    return `${whole}%`;
  }
  // Two decimal places, then drop a trailing zero: 50 -> "5", 10 -> "1", 01 -> "01".
  const fractionCopy = fraction.toString().padStart(2, "0").replace(/0$/, "");
  return `${whole}.${fractionCopy}%`;
}

export type ParsePercentResult =
  | { ok: true; bps: bigint }
  | { ok: false; error: string };

/**
 * Convert a user-entered percent (at most two decimals, since 1 bps = 0.01%) into
 * integer basis points. The only place a percent string becomes bps.
 */
export function parsePercentToBps(input: string): ParsePercentResult {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return { ok: false, error: "Enter a percent with at most two decimals." };
  }
  const [whole, fraction = ""] = trimmed.split(".");
  const bps = BigInt(whole) * BPS_PER_PERCENT + BigInt(fraction.padEnd(2, "0"));
  if (bps <= 0n || bps > BPS_DENOMINATOR) {
    return { ok: false, error: "Enter a percent above 0 and up to 100." };
  }
  return { ok: true, bps };
}

export type HealthStatus = "SAFE" | "UNSAFE";

/** The 1e18-scaled value at which a Position is exactly solvent. */
export const HEALTH_FACTOR_ONE = 10n ** 18n;

/** A Position is SAFE while its weighted Collateral value still covers its Debt. */
export function healthStatus(healthFactor: bigint): HealthStatus {
  return healthFactor >= HEALTH_FACTOR_ONE ? "SAFE" : "UNSAFE";
}

/** Price Collateral (1e18 AVAX) at the fixed AVAX price (1e18 USD) -> USD (1e18). */
export function collateralValueUsd(collateral: bigint, avaxPriceUsd: bigint): bigint {
  return (collateral * avaxPriceUsd) / HEALTH_FACTOR_ONE;
}

/**
 * The largest Debt the pool accepts for a Position: mirrors the pool's
 * `collateralValue * liquidationThresholdBps / 10_000`, integer-only.
 */
export function maxBorrow(
  collateral: bigint,
  avaxPriceUsd: bigint,
  liquidationThresholdBps: bigint,
): bigint {
  return (
    (collateralValueUsd(collateral, avaxPriceUsd) * liquidationThresholdBps) /
    BPS_DENOMINATOR
  );
}

/** Parse a decimal token amount into integer base units, or `null` if malformed. */
export function parseTokenAmount(input: string, decimals = 18): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    return null;
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
}

/** Print integer base units as a trimmed decimal (UI boundary; integer math only). */
export function formatDecimal(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  if (fraction === 0n) {
    return whole.toString();
  }
  const fractionCopy = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fractionCopy}`;
}

export type OpenPositionInput = {
  collateralWei: bigint;
  borrowAmountWei: bigint;
  existingCollateralWei?: bigint;
  existingDebtWei?: bigint;
  avaxPriceUsd: bigint;
  liquidationThresholdBps: bigint;
};

export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Validate an Open Position before sending it, mirroring the pool's ceiling.
 * The wallet is the source of truth; this only avoids a guaranteed revert.
 */
export function validateOpenPosition(input: OpenPositionInput): ValidationResult {
  const totalCollateral = (input.existingCollateralWei ?? 0n) + input.collateralWei;
  if (totalCollateral <= 0n) {
    return { ok: false, error: "Enter AVAX Collateral above 0." };
  }
  const ceiling = maxBorrow(
    totalCollateral,
    input.avaxPriceUsd,
    input.liquidationThresholdBps,
  );
  const totalDebt = (input.existingDebtWei ?? 0n) + input.borrowAmountWei;
  if (totalDebt > ceiling) {
    return {
      ok: false,
      error: `Total debt would be ${formatDecimal(totalDebt, 18)} mUSDC, above the ${formatDecimal(ceiling, 18)} mUSDC limit for your combined collateral. Add more AVAX or borrow less.`,
    };
  }
  return { ok: true };
}

/** Wallet providers may wrap custom errors without decoding their selector. */
export function openPositionError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/InsufficientCollateral|0x3a23d825/i.test(message)) {
    return "Your combined collateral does not cover your existing debt plus this borrow at the current safety limit. Add more AVAX or borrow less.";
  }
  if (/user rejected|user denied/i.test(message)) return "Transaction cancelled in your wallet.";
  return "Could not complete the position update. Check your wallet for a pending or failed transaction and refresh the current position before retrying.";
}
