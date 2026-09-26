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

/** A queued Proposal as the Keeper knows it from its `ProposalQueued` log. */
export interface QueuedProposal {
  id: bigint
  newThresholdBps: bigint
  executeAfter: bigint
}

/** A (user, proposal) pair worth an on-chain check. */
export interface ExitCandidate {
  user: string
  proposalId: bigint
  executeAfter: bigint
}

/**
 * Only proposals still inside their Timelock window can fire: the contract
 * refuses an exit once `block.timestamp >= executeAfter`, so a proposal at its
 * deadline is already closed. Expired proposals are dead weight — dropping
 * them keeps a growing proposal history from crowding out a fresh window.
 */
export function liveProposals(
  proposals: Iterable<QueuedProposal>,
  chainNow: bigint,
): QueuedProposal[] {
  const live: QueuedProposal[] = []
  for (const proposal of proposals) {
    if (chainNow < proposal.executeAfter) {
      live.push(proposal)
    }
  }
  return live
}

/**
 * The only pairs worth an on-chain check: an actionable rule against a live
 * proposal whose proposed threshold is strictly below the rule's minimum.
 * Ordered by nearest deadline first, so the most urgent window is acted on
 * before any other work can consume it. The contract re-verifies every
 * condition (`shouldExit` and `checkAndExit`); this selection only keeps the
 * working set small, it is never the authority.
 */
export function actionableCandidates(
  users: Iterable<string>,
  rules: ReadonlyMap<string, RuleState>,
  proposals: Iterable<QueuedProposal>,
  chainNow: bigint,
): ExitCandidate[] {
  const candidates: ExitCandidate[] = []
  for (const proposal of liveProposals(proposals, chainNow)) {
    for (const user of users) {
      const rule = rules.get(user.toLowerCase())
      if (rule === undefined || !isActionable(rule)) continue
      if (proposal.newThresholdBps >= rule.minimumThresholdBps) continue
      candidates.push({
        user,
        proposalId: proposal.id,
        executeAfter: proposal.executeAfter,
      })
    }
  }
  candidates.sort((a, b) =>
    a.executeAfter < b.executeAfter ? -1 : a.executeAfter > b.executeAfter ? 1 : 0,
  )
  return candidates
}

/** Exponential backoff (capped) for HTTP 429 pressure on `eth_getLogs`. */
export function backoffDelayMs(attempt: number, baseMs = 500, maxMs = 15_000): number {
  const safeAttempt = Math.max(0, Math.floor(attempt))
  const delay = baseMs * 2 ** safeAttempt
  return Math.min(delay, maxMs)
}
