# GovExit

**A borrower's pre-committed safety rule, enforced automatically inside a governance timelock — so the protection a timelock promises is actually delivered.**

Track: **DeFi** · Network: **Avalanche Fuji (chain ID 43113)** · Live demo: yes

---

## The problem

In a DeFi lending market, governance can lower the **liquidation threshold** — the parameter that caps how much a borrower may owe against their collateral. Lowering it makes every open loan riskier and can push borrowers toward liquidation.

There is a **timelock**: a waiting period between a proposal being queued and it taking effect, meant to give borrowers time to leave. But nothing watches that window. A borrower who is asleep, offline, or simply not watching governance gets caught anyway. The timelock's protection is theoretical.

## The solution

A borrower pre-commits **one rule**: *"exit if the liquidation threshold drops below X%."*

An off-chain **Keeper** — permissionless, holding only gas — watches for queued governance proposals. When a proposal's new threshold falls **strictly below** the borrower's minimum, the Keeper triggers `GovExit`, which closes the borrower's Position **inside the timelock**, settling at the pool's fixed price and returning the remaining AVAX.

No second signature. No wallet to open. The borrower never has to notice.

## How it works

1. **Alice opens a Position** (AVAX Collateral, mUSDC Debt) and sets an **Exit rule** with a **Minimum threshold** — she has already approved `GovExit` as her **Exit agent** in the pool.
2. **The Demo Admin queues a Proposal** to change the liquidation threshold (80% → 60%). Only the governance owner can queue.
3. **The Timelock runs** (60 seconds in this mock; the real Aave delay is 1 day).
4. **The Keeper** calls `shouldExit(user, proposalId)` (a read-only check). It is `true` when the rule is active and untriggered, the proposal is still queued, `proposed < minimum`, the position is solvent, and the exit agent is approved.
5. **`GovExit.checkAndExit`** re-verifies every condition, marks the rule **Triggered** *before* the external call (replay protection), then closes the Position. It emits `ExitTriggered`.

## Live on Avalanche Fuji

| Contract | Address | Verified source |
|---|---|---|
| `MockUSDC` | `0x84BDD89D2081BEe20f63FBD90A20d6a1D0f9Ad94` | [Sourcify](https://sourcify.dev/#/lookup/0x84BDD89D2081BEe20f63FBD90A20d6a1D0f9Ad94) |
| `MockLendingPool` | `0x25838379779FB4b229efbCCbb96d52aa94ddF278` | [Snowtrace](https://testnet.snowtrace.io/address/0x25838379779FB4b229efbCCbb96d52aa94ddF278#code) |
| `MockGovernance` | `0xAb01AFe53C0aFd8348a3117eb9487A82362B95EB` | [Snowtrace](https://testnet.snowtrace.io/address/0xAb01AFe53C0aFd8348a3117eb9487A82362B95EB#code) |
| `GovExit` | `0x90970F046e70B4E11579566aD22F5CFb8AefC390` | [Snowtrace](https://testnet.snowtrace.io/address/0x90970F046e70B4E11579566aD22F5CFb8AefC390#code) |

- **Deploy block:** `58732756` (bounds every Keeper `getLogs` scan)
- **`MockUSDC` source note:** the Fuji explorer carries a stale record at this
  address and shows an unrelated contract's source. The address is fresh — its
  runtime bytecode hash matches our compiled `MockUSDC`, and it was created by our
  deploy tx `0xb3656d3d…` in block `58732756`. The correct source is verified on
  [Sourcify](https://sourcify.dev/#/lookup/0x84BDD89D2081BEe20f63FBD90A20d6a1D0f9Ad94).
- **Demo Admin (owns `MockGovernance`):** `0x1F23EbA427de7f924C1Af1e87D99fC797877e461`

**Proof — a live automatic exit with no user signature after the rule was set:**

- `checkAndExit` transaction: `0x16462c466a7a146b96bf39c649fe1a896546d3977703c3ba1c262796e355ea18` (block `58732844`)
- Result on chain: Position `(0, 0, inactive)`, Exit rule `(7000 bps, active, triggered)`
- Explorer: https://testnet.snowtrace.io/tx/0x16462c466a7a146b96bf39c649fe1a896546d3977703c3ba1c262796e355ea18

## Repository layout

| Path | What it is |
|---|---|
| `contracts/` | Foundry project: the four Solidity contracts, tests, and the deploy script |
| `keeper/` | Node + TypeScript + viem watcher that triggers the Automatic exit |
| `app/`, `components/`, `lib/` | Next.js dashboard (wagmi + viem, connects the Core wallet) |
| `scripts/demo-run.sh` | One-command, repeatable end-to-end demo run |

## Run it

```shell
# Contracts
cd contracts && forge test

# Keeper (needs KEEPER_PRIVATE_KEY in ../.env)
cd keeper && npm install && npm test && npm start

# Dashboard
pnpm install && pnpm dev          # http://localhost:3000

# Replay the whole flow from the command line, N times
scripts/demo-run.sh 0.02 0.3 7000 6000 1
```

`scripts/demo-run.sh [collateralAvax] [borrowMusdc] [minBps] [proposedBps] [runs]`

## Security properties

- **No discretion.** The Keeper cannot choose anything; it merely calls `checkAndExit`. The decision lives in `GovExit`.
- **No custody.** The Keeper holds gas only. `GovExit` is authorized for exactly one action: closing a Protected user's Position.
- **Replay-proof.** The rule is marked Triggered before the Position is closed, and the function is `nonReentrant`. A malicious Keeper calling again gets a revert.
- **Permissioned proposal source.** Only the governance owner can queue a proposal; otherwise anyone could queue `0%` and force every Protected user out.
- **No AI in the trigger path.** The decision is deterministic and auditable: `proposed 60% < minimum 70% → exit`.

## Tests

- **contracts:** 71 Foundry tests, including an end-to-end `DemoFlow` and the exact boundary (`80→70` with minimum `70` = no exit; `80→69` = exit).
- **keeper:** `node:test` cases for the pure decision logic (chunking, actionable gate, backoff).
- **dashboard:** 23 `node:test` cases for the pure display logic (bps↔percent, health, countdown, ownership, error copy).

## What is mocked (and why)

`mUSDC` is a test token, the AVAX price is a fixed mock (`AVAX_PRICE_USD = 20e18`), and the 60-second timelock stands in for Aave's real 1-day delay. Real Aave governance cannot be made to fire on demand for a live demo, so the product — the *automatic-exit mechanism* — is proven against a mock protocol on a real chain. Reading live Aave Governance V3 data is a documented stretch goal.

Out of scope: underwater unwinds, real oracles, real liquidations, DAO voting, multi-chain.
