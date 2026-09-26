/**
 * Pure, chain-free decision logic for the GovExit Keeper.
 *
 * Everything here is deterministic and has no I/O or viem dependency, matching
 * the project rule that there is no AI (and no discretion) in the trigger path:
 * `GovExit._shouldExit` is the single source of truth for the decision, and the
 * Keeper only gates on the rule's own state plus that view result.
 */

export interface RuleState {
  minimumThresholdBps: bigint
  active: boolean
  triggered: boolean
}

export interface BlockRange {
  fromBlock: bigint
  toBlock: bigint
}

/**
 * Split an inclusive block range into ordered, non-overlapping chunks of at
 * most `maxSpan` blocks. The Fuji public RPC has no `eth_newFilter` and weights
 * `eth_getLogs` at 200 CU, so a scan from `DEPLOY_BLOCK` to `latest` must be
 * chunked. An inverted range yields no chunks; a non-positive span is a bug.
 */
export function planChunks(fromBlock: bigint, toBlock: bigint, maxSpan: bigint): BlockRange[] {
  if (maxSpan <= 0n) {
    throw new Error('maxSpan must be a positive number of blocks')
  }
  const chunks: BlockRange[] = []
  if (toBlock < fromBlock) {
    return chunks
  }
  let start = fromBlock
  while (start <= toBlock) {
    const end = start + maxSpan - 1n
    chunks.push({ fromBlock: start, toBlock: end < toBlock ? end : toBlock })
    start = end + 1n
  }
  return chunks
}

/** A rule may act only while it is active and has not already Triggered. */
export function isActionable(rule: RuleState): boolean {
  return rule.active && !rule.triggered
}

/**
 * The Keeper's whole decision: act only when the rule is actionable AND the
 * Exit agent's view reports `true`. The contract re-verifies this predicate in
 * `checkAndExit`, so this gate is an optimization against guaranteed reverts,
 * never the authority.
 */
export function decideExit(rule: RuleState, shouldExit: boolean): boolean {
  return isActionable(rule) && shouldExit
}

/** Exponential backoff (capped) for HTTP 429 pressure on `eth_getLogs`. */
export function backoffDelayMs(attempt: number, baseMs = 500, maxMs = 15_000): number {
  const safeAttempt = Math.max(0, Math.floor(attempt))
  const delay = baseMs * 2 ** safeAttempt
  return Math.min(delay, maxMs)
}
