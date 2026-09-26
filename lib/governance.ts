/**
 * Pure logic for the Governance panel (issue 14).
 *
 * Dependency-free (except for the bps formatter) so it can be unit-tested with
 * `node --test` and no chain: countdown arithmetic anchored on an on-chain
 * clock, the queued threshold change, the proposal state enum, latest-log
 * selection, and the AVAX returned by an Automatic exit. Every amount stays an
 * integer `bigint`; only formatting happens at the UI boundary.
 */

import { bpsToCopy } from "./position.ts";

/** Mirror of `MockGovernance.ProposalState` — numeric, never a TS `enum`. */
export const ProposalState = {
  NONE: 0,
  QUEUED: 1,
  EXECUTED: 2,
  CANCELLED: 3,
} as const;

export type ProposalStateValue = (typeof ProposalState)[keyof typeof ProposalState];

/** Human copy for the proposal state; unknown values never crash the panel. */
export function proposalStateLabel(state: number): string {
  switch (state) {
    case ProposalState.NONE:
      return "None";
    case ProposalState.QUEUED:
      return "Queued";
    case ProposalState.EXECUTED:
      return "Executed";
    case ProposalState.CANCELLED:
      return "Cancelled";
    default:
      return "Unknown";
  }
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

/** Format whole seconds as `mm:ss`, or `hh:mm:ss` from an hour up. */
export function formatCountdown(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const hours = Math.floor(safe / SECONDS_PER_HOUR);
  const minutes = Math.floor((safe % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = safe % SECONDS_PER_MINUTE;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Seconds left until `executeAfter`, anchored on the on-chain clock.
 *
 * `chainNow` is the block timestamp read from the chain at fetch time; the local
 * `elapsedMs` since that read is the only client-side contribution. This keeps
 * the countdown derived from on-chain `executeAfter` rather than a wall-clock
 * guess. Never negative.
 */
export function remainingSeconds(
  executeAfter: bigint,
  chainNow: bigint,
  elapsedMs: number,
): number {
  const base = executeAfter - chainNow;
  if (base <= 0n) {
    return 0;
  }
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs)) : 0;
  // Work in milliseconds so the countdown shows the ceiling of the remaining
  // whole seconds and reaches 00:00 only once the Timelock has actually passed.
  const remainingMs = base * 1000n - BigInt(elapsed);
  if (remainingMs <= 0n) {
    return 0;
  }
  return Number(remainingMs / 1000n);
}

/** The queued change, e.g. `8000n, 6000n` -> `"80% → 60%"`. */
export function formatThresholdChange(currentBps: bigint, proposedBps: bigint): string {
  return `${bpsToCopy(currentBps)} → ${bpsToCopy(proposedBps)}`;
}

/**
 * AVAX returned to the user when the Exit agent closes the Position at the fixed
 * price: `Collateral - Debt * 1e18 / AVAX_PRICE_USD`, integer-only. Clamped at 0
 * because an underwater unwind is out of domain (the pool reverts first).
 */
export function avaxReturned(
  preCollateral: bigint,
  preDebt: bigint,
  avaxPriceUsd: bigint,
): bigint {
  if (avaxPriceUsd <= 0n) {
    return preCollateral;
  }
  const avaxOut = (preDebt * 10n ** 18n) / avaxPriceUsd;
  const remainder = preCollateral - avaxOut;
  return remainder > 0n ? remainder : 0n;
}

/** Minimal shape of a viem log needed to order two logs. */
export interface OrderedLog {
  blockNumber: bigint | null;
  logIndex: number | null;
}

/** The newest log by block then log index, or `null` for an empty scan. */
export function pickLatestLog<T extends OrderedLog>(logs: readonly T[]): T | null {
  let latest: T | null = null;
  for (const log of logs) {
    if (latest === null || isAfter(log, latest)) {
      latest = log;
    }
  }
  return latest;
}

function isAfter(candidate: OrderedLog, current: OrderedLog): boolean {
  const candidateBlock = candidate.blockNumber ?? -1n;
  const currentBlock = current.blockNumber ?? -1n;
  if (candidateBlock !== currentBlock) {
    return candidateBlock > currentBlock;
  }
  return (candidate.logIndex ?? -1) > (current.logIndex ?? -1);
}

/** A Fuji explorer link to a transaction; tolerates a trailing slash on base. */
export function explorerTxUrl(baseUrl: string, hash: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/tx/${hash}`;
}

/** Match the contract's timelock gate using the latest observed chain time. */
export function canExecuteProposal(
  state: number | undefined,
  executeAfter: bigint | undefined,
  chainNow: bigint | undefined,
): boolean {
  return state === ProposalState.QUEUED &&
    executeAfter !== undefined && chainNow !== undefined &&
    chainNow >= executeAfter;
}

export function proposalCountdownCopy(
  state: number | undefined,
  executeAfter: bigint | undefined,
  chainNow: bigint | undefined,
  elapsedMs: number,
): string {
  if (state === undefined) return "…";
  if (state !== ProposalState.QUEUED) return proposalStateLabel(state);
  if (executeAfter === undefined || chainNow === undefined) return "…";
  if (canExecuteProposal(state, executeAfter, chainNow)) return "00:00 · executable now";
  const remaining = remainingSeconds(executeAfter, chainNow, elapsedMs);
  return remaining === 0 ? "00:00 · awaiting chain confirmation" : formatCountdown(remaining);
}

type TransactionHash = `0x${string}`;
export type ProposalExecutionResult =
  | { status: "not-submitted" }
  | { status: "confirmed" | "reverted" | "unconfirmed"; hash: TransactionHash };

/** A failed receipt lookup cannot establish whether a submitted transaction succeeded. */
export async function runProposalExecution({ send, wait, refresh }: {
  send: () => Promise<TransactionHash>;
  wait: (hash: TransactionHash) => Promise<{ status: "success" | "reverted" }>;
  refresh: () => Promise<unknown>;
}): Promise<ProposalExecutionResult> {
  let hash: TransactionHash;
  try {
    hash = await send();
  } catch {
    return { status: "not-submitted" };
  }
  let result: ProposalExecutionResult;
  try {
    const receipt = await wait(hash);
    result = { status: receipt.status === "success" ? "confirmed" : "reverted", hash };
  } catch {
    result = { status: "unconfirmed", hash };
  }
  // Refresh even after confirmation failure; a refresh failure does not undo a receipt.
  try { await refresh(); } catch { /* Polling will retry the reads. */ }
  return result;
}
