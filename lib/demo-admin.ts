/**
 * Pure logic for the Demo Admin panel (issue 15).
 *
 * Dependency-free so it can be unit-tested with `node --test` and no chain:
 * the Proposal/Timelock defaults, Timelock input validation, the Demo Admin
 * owner comparison, and the friendly error copy. The panel is the only place
 * a Demo Admin transaction is sent; this module never sends one.
 */

/** The default Proposal value: 60%, expressed as 6000 basis points. */
export const DEFAULT_PROPOSAL_BPS = 6000n;

/** The default Proposal value as user-facing percent copy. */
export const DEFAULT_PROPOSAL_PERCENT = "60";

/** The default Timelock: 60 seconds — the live Fuji mock timing, not Aave's 1 day. */
export const DEFAULT_TIMELOCK_SECONDS = 60n;

/** The default Timelock as user-facing seconds copy. */
export const DEFAULT_TIMELOCK_INPUT = "60";

/** Shown whenever the connected wallet is not the Demo Admin. */
export const NOT_DEMO_ADMIN_ERROR =
  "This wallet is not the Demo Admin. Only the Demo Admin wallet can queue a Proposal or set the Timelock.";

/** Shown when the Demo Admin's own transaction fails; never the raw revert. */
export const DEMO_ADMIN_TX_ERROR =
  "That transaction failed. Confirm you are on Avalanche Fuji and try again.";

export type ParseTimelockResult =
  | { ok: true; seconds: bigint }
  | { ok: false; error: string };

/**
 * Parse a whole, positive number of seconds. The Timelock is a raw on-chain
 * `uint256`, so the only guard needed is "a non-negative integer was typed" —
 * decimals and negatives are rejected before they can be misread.
 */
export function parseTimelockSeconds(input: string): ParseTimelockResult {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: "Enter the Timelock as whole seconds, e.g. 60." };
  }
  const seconds = BigInt(trimmed);
  if (seconds <= 0n) {
    return { ok: false, error: "Enter a Timelock above 0 seconds." };
  }
  return { ok: true, seconds };
}

/** True only when the connected wallet is exactly the contract's `owner()`. */
export function isDemoAdmin(
  owner: string | undefined,
  connected: string | undefined,
): boolean {
  if (!owner || !connected) {
    return false;
  }
  return owner.toLowerCase() === connected.toLowerCase();
}

/**
 * Friendly copy for a failed Demo Admin action. Ownership is checked first so
 * a `not the owner` wallet always sees the clear demo error, and the raw revert
 * string is never surfaced.
 */
export function demoAdminTxError(
  owner: string | undefined,
  connected: string | undefined,
): string {
  return isDemoAdmin(owner, connected) ? DEMO_ADMIN_TX_ERROR : NOT_DEMO_ADMIN_ERROR;
}
