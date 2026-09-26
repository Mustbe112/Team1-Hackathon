# GovExit risk review

Reviewed 2026-09-26 against the current working tree, including the recent UI and proposal-execution changes. The highest risk is missing an automatic exit while the dashboard gives the user confidence that protection is active.

Scope: all first-party files in app/, components/, lib/, keeper/, contracts/src/, contracts/test/, contracts/script/, and scripts/; repository and package configuration, environment template, documentation, dependency lock metadata, submodule pins, and both Fuji deployment artifacts. Vendored OpenZeppelin/forge-std code and generated bundles were not independently audited. Environment configuration was checked without exposing credentials. This is a local source and behavior review; no browser checks, live transactions, or dependency vulnerability-database scan were performed.

## Highest-priority findings

### 1. High — keeper scheduling can miss the exit deadline

Locations: keeper/index.ts:217, keeper/index.ts:283, contracts/src/GovExit.sol:137.

Every discovered proposal and user stays in a Set forever. Each tick visits all historical proposal/user pairs serially, oldest proposals first, re-reading the same rules and checking expired/cancelled proposals. Transaction confirmations also block the loop. The time to reach a fresh proposal therefore grows with all past activity, rather than the number of actionable proposals.

Additionally, readRule and shouldExit run outside the per-pair try/catch. A read failure propagates to the outer tick handler, skipping every remaining pair in that tick. A mocked-client probe confirmed that an RPC failure for the first user prevented the second user from being visited.

Consequence: delayed startup scans, RPC errors, rate limits, or a historical backlog can consume the 60-second protection window. Once the deadline passes, GovExit refuses the exit even when the proposal remains unexecuted.

Fix: maintain only queued, unexpired proposals; prioritize fresh deadlines; isolate failures per pair; read each user's rule once per cycle; use bounded work scheduling with serialized nonce management for writes; checkpoint scans and expose deadline/keeper health alerts. Add runner tests with slow/erroring clients and multiple users/proposals.

### 2. High — governance can remove the protection window

Locations: contracts/src/MockGovernance.sol:75, contracts/src/GovExit.sol:137, lib/demo-admin.ts:46.

setTimelock accepts zero without a minimum. A local contract probe set it to zero, queued a 50% proposal, found shouldExit false immediately, then executed the proposal in the same timestamp. Alice's position remained open and its health factor fell below one.

The frontend rejects zero but accepts one second, which is shorter than the keeper's default three-second polling interval even before network and transaction latency.

This requires the governance owner; it is a governance trust-boundary weakness, not an unprivileged bypass. Existing queued proposals retain their captured deadlines.

Fix: enforce a meaningful minimum in the contract, constrain the UI to the same minimum, and consider delayed changes to the timelock itself. Distinguish rule registration from guaranteed execution availability.

### 3. High — reverted exit transactions are permanently marked handled

Location: keeper/index.ts:310.

After waitForTransactionReceipt, the keeper adds the user/proposal pair to handled regardless of receipt.status. A transaction can pass simulation but revert after state changes between simulation and mining. The keeper then suppresses all retries for that pair during that process lifetime.

A mocked-client probe returned a reverted receipt and confirmed that the second tryExit neither read the rule nor sent another transaction.

Fix: mark a pair handled only after a successful receipt and an appropriate resulting state. Preserve retries while the on-chain predicate remains true. Record distinct pending/succeeded/failed transaction states.

### 4. High — re-arming a rule does not reset keeper deduplication

Locations: keeper/index.ts:241, keeper/index.ts:284, contracts/src/GovExit.sol:80.

The contract allows setRule to clear triggered. If a user exits, opens another position, and re-arms while the same risky proposal is still inside its timelock, the contract permits another exit. The running keeper skips that user/proposal pair because its handled key contains no rule generation, and RuleCreated processing never clears the key.

A mocked-client probe confirmed that a fresh actionable rule was not read after a successful prior exit for that pair. This is limited to reusing a proposal during its still-open window; new proposal IDs are not suppressed by the same key.

Fix: associate deduplication with a rule generation or invalidate user-specific handled entries on RuleCreated. Let the contract's triggered flag enforce replay protection rather than keeping permanent process-level suppression across re-arms.

### 5. High — the UI overstates protection and conceals read failures

Locations: components/position-panel.tsx:124, components/position-panel.tsx:148, components/governance-panel.tsx:374.

Protection active is derived solely from an active rule, approval, and an untriggered flag. It does not establish keeper uptime, gas balance, backlog, timelock adequacy, or even that the position is active. The governance banner promises an exit before the deadline whenever shouldExit is true, although that is eligibility rather than an execution guarantee.

Query failures are also presented as empty domain state: an unavailable position becomes inactive, an unavailable approval becomes unapproved/revoked, and failed proposal or exit-log discovery can appear as no proposal/no automatic exit. Approval and health queries do not themselves poll in PositionPanel; a health label can lag an externally executed threshold change. The dashboard has no close-position, disable-rule, or revoke-approval controls, even though the contracts expose these recovery actions.

Fix: label the rule as armed, show monitoring availability separately, display loading/error/stale states explicitly, poll risk and approval reads, and expose manual recovery actions. Never promise a future exit based only on shouldExit.

### 6. High — an invalid proposal can force an unnecessary exit

Locations: contracts/src/MockGovernance.sol:58, contracts/src/MockLendingPool.sol:83, contracts/src/GovExit.sol:140.

queueThresholdChange does not validate the pool's allowable range (1–10,000 bps). A local contract probe queued 0%, confirmed shouldExit true, and closed Alice's position. Later execution reverted with InvalidThresholdBps and the pool remained at 80%.

Thus an invalid, permanently unexecutable proposal can still cause borrowers to settle their debt and surrender the corresponding AVAX. This requires governance-owner input; the UI prevents it, but direct contract callers are not constrained by UI validation.

Fix: enforce the pool's threshold bounds when queuing, before an event or proposal exists. Include an invalid-proposal regression test at the governance/GovExit boundary.

### 7. High, conditional deployment risk — default admin is a development account

Location: contracts/script/Deploy.s.sol:35.

When DEMO_ADMIN_ADDRESS is absent, deployment silently assigns governance ownership to the default Anvil account #1. That is an inappropriate fallback for a public-network deployment. There is no chain-specific guard or mandatory explicit admin on Fuji.

The current local environment has an explicit Demo Admin address, so this finding does not establish that the existing deployment used the fallback.

Fix: allow the development default only on an explicitly supported local chain; require an explicit nonzero admin for public networks and verify ownership/wiring after deployment.

## Additional risks

### 8. Medium — smart-contract wallets can be unable to close

Location: contracts/src/MockLendingPool.sol:135.

_close transfers AVAX directly to the user and reverts the whole close if their receive function rejects it. A local contract-wallet probe confirmed that shouldExit was true but checkAndExit reverted, leaving collateral and debt intact. Manual close uses the same settlement path. This affects wallets that cannot receive the native transfer, rather than ordinary externally owned wallets.

Fix: support withdrawing owed collateral separately, or an owner-authorized payout recipient, without letting a third-party keeper redirect funds.

### 9. Medium — documented keeper overrides point at a superseded deployment

Locations: keeper/README.md:39 and keeper/README.md:55; keeper/index.ts:65; lib/env.ts:23; .env.example.

keeper/index.ts defaults to the latest addresses in the root README and deployment artifacts. However, the keeper README instructs users to explicitly override them with old addresses and block 58722211. Following that command makes the keeper monitor a different deployment from the current dashboard.

The frontend also defaults its log scan to 58722211 while the latest deployment starts at 58732756. The current local environment has DEPLOY_BLOCK=58732756 but no NEXT_PUBLIC_DEPLOY_BLOCK; the frontend only reads the latter. This scans extra blocks for the current addresses rather than losing events, but increases startup RPC work. The template omits NEXT_PUBLIC_DEPLOY_BLOCK and several runner-required keys.

Fix: publish one deployment manifest and derive dashboard/keeper/script defaults from it; update the keeper instructions and environment template; verify contract wiring and chain IDs at startup.

### 10. Medium — only the latest proposal is visible

Location: components/governance-panel.tsx:91.

The UI selects one latest ProposalQueued log, while the governance contract supports independent concurrent proposals. A newer harmless proposal can hide an older risky queued proposal, its deadline, and its execute action. The keeper still considers all proposals, so this is a monitoring/control omission rather than a direct predicate bypass.

Fix: list actionable proposals and their independent deadlines, with the most urgent first. Link an exit receipt to the proposal that actually caused it.

### 11. Medium — receipt amounts are reconstructed from the wrong possible snapshot

Location: components/governance-panel.tsx:210.

The receipt reconstructs collateral/debt from block exitBlock - 1. If a position is opened or topped up earlier in the same block as its exit, this snapshot does not reflect what was actually closed. It can report zero or incorrect returned AVAX/debt. Debt remaining also substitutes zero when the current-position read is unavailable and mixes present-day state with a historical receipt.

Fix: emit settled debt and returned collateral in the settlement/exit event, or derive them from actual transaction effects. Label historical and current values separately, and show unavailable values rather than substituting zero.

### 12. Medium — frontend transaction paths do not consistently check receipt success

Locations: components/position-panel.tsx:177, components/position-panel.tsx:186, components/position-panel.tsx:231, components/demo-admin-panel.tsx:131, components/demo-admin-panel.tsx:165.

These paths await receipts without checking status. A reverted mined transaction can clear busy state and refresh queries without a failure message. The new governance execution path does check status; the older paths should follow the same behavior. In the two-transaction approval/rule flow, a failed approval can still lead to an attempted rule transaction.

Fix: centralize confirmed-transaction handling, reject reverted receipts, and stop multi-step sequences after an unsuccessful step.

### 13. Medium — top-up validation ignores the existing position

Location: components/position-panel.tsx:211; lib/position.ts:137; contracts/src/MockLendingPool.sol:47.

The contract validates total existing-plus-new collateral and debt. The UI validates only the entered increments and requires positive new collateral. For example, an existing 10 AVAX/150 mUSDC position can become above its borrowing ceiling after the limit falls from 80% to 70%. Adding 1 AVAX and borrowing 14 mUSDC then passes the UI check (14 mUSDC against the new 1 AVAX), but the contract rejects total debt of 164 mUSDC against total capacity of 154 mUSDC. Conversely, borrowing with spare existing collateral and zero added AVAX is rejected by the UI even though the contract can permit it.

Fix: validate accumulated collateral and debt using the current position and latest limit. Present total-position capacity and the incremental borrowing allowance.

## Intentional demo constraints

The open mock-token mint, fixed AVAX price, and settlement that retains AVAX instead of performing a real market swap are explicitly documented demo choices. They are blockers for treating this as a real lending integration, but were not ranked as hidden vulnerabilities in this Fuji demo. Pool token reserves are finite and not replenished by the mock settlement; repeated demos eventually need reseeding.

## Validation and limits

- Existing Solidity tests: 71/71 passed.
- Existing keeper tests: 7/7 passed; keeper type checking passed.
- Dashboard tests: 24/24 passed; dashboard type checking passed.
- Production build passed with a dependency dynamic-import warning from ox/viem.
- Shell syntax and git diff whitespace checks passed.
- Three temporary Solidity probes confirmed zero-timelock bypass, invalid-proposal forced exit, and rejecting-wallet exit failure.
- Three temporary mocked-client keeper probes confirmed reverted-receipt suppression, re-arm suppression, and tick abortion after a read error.
- Temporary probes were removed. No application or deployed-contract changes were made during this review; the review adds only this report. Earlier UI changes remain in the working tree.

Passing tests establish the existing happy-path and covered contract predicates; they do not validate keeper execution deadlines, runner recovery behavior, deployment safety, or frontend error handling. No claim is made about current keeper uptime or the current on-chain pool state.

Recommended order: fix keeper receipt handling and re-arm behavior; make scheduling deadline-aware and errors isolated; enforce governance parameter bounds; correct protection/error UI; align deployment configuration and add recovery controls. Contract changes require redeployment and coordinated frontend/keeper configuration updates.
