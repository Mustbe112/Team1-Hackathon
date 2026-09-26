# GovExit Keeper

The off-chain, permissionless actor that watches Avalanche Fuji for queued
governance Proposals and calls `GovExit.checkAndExit` when a Protected user's
Exit rule trips. It has **no discretion and no custody**: `GovExit` is the user's
Exit agent and re-verifies every condition; the Keeper holds gas only. There is
no AI in the trigger path — see `logic.ts`.

## Layout

| File | Role |
|---|---|
| `index.ts` | Thin viem runner: scan → view-gate → simulate → send. |
| `logic.ts` | Pure, chain-free decisions (`planChunks`, `isActionable`, `decideExit`, `backoffDelayMs`). |
| `logic.test.ts` | `node:test` unit tests for the pure decisions. |

## Setup

```shell
cd keeper
npm install
```

`viem` is the only runtime dependency; `tsx` runs the TypeScript.

## Commands

```shell
npm test         # 7 unit tests for the pure decision + chunking logic
npm run typecheck
npm start        # poll forever; Ctrl-C stops it
```

## Environment

Loaded from `../.env` when present (values already in the environment win) or
from process env. Never logged.

| Variable | Default | Notes |
|---|---|---|
| `KEEPER_PRIVATE_KEY` | — | **Required.** Gas-only signer; holds no user funds. |
| `RPC_URL` | Fuji public RPC | |
| `DEPLOY_BLOCK` | `58722211` | Bounds every `getLogs` scan. |
| `GOVEXIT_ADDRESS` | `0xF896…4F4E` | Canonical Fuji deployment. |
| `GOVERNANCE_ADDRESS` | `0x6FDC…f305` | Canonical Fuji deployment. |
| `POLL_INTERVAL_MS` | `3000` | A few seconds keeps the 60 s Timelock window reachable. |
| `LOG_CHUNK_SIZE` | `2000` | Blocks per `eth_getLogs` call. |

The Keeper deliberately ignores the frontend `NEXT_PUBLIC_*` variables. The
repo's `.env` currently points at a **superseded** deployment (`0x8dc6…`, deploy
block `58719266`); the canonical addresses above are the built-in defaults, so a
plain `npm start` cannot be pointed at the stale one by the browser env. To pin
the canonical deploy block explicitly:

```shell
set -a; source ../.env; set +a
DEPLOY_BLOCK=58722211 GOVEXIT_ADDRESS=0xF896aFC531B18f35EE90e770bD4486Ef8ef64F4E \
  GOVERNANCE_ADDRESS=0x6FDCc06f827cd62284A63cd918A9BdEcd75fb305 npm start
```

## How it works

1. Poll `getLogs` for `RuleCreated` (at `GovExit`) and `ProposalQueued` (at
   `MockGovernance`), scanned from `DEPLOY_BLOCK` to `latest` and split with
   `planChunks` — the Fuji public RPC has no `eth_newFilter` and weights
   `eth_getLogs` at 200 CU.
2. For each Protected user with an active, untriggered Exit rule, call
   `shouldExit(user, proposalId)` as a view.
3. When `decideExit(...)` is true, `simulateContract` first (so a guaranteed
   revert is never broadcast), then send `checkAndExit(user, proposalId)` from
   the Keeper key and log the tx hash.
4. A `429` / rate-limit response on `eth_getLogs` backs off exponentially
   (capped), inside the chunk loop.
5. A malformed/missing `KEEPER_PRIVATE_KEY` or wrong chain exits non-zero; a
   transient tick error is logged and retried, never silently swallowed.

## Repro run (observed on Fuji)

1. Alice opens a scaled **Position** (`0.5 AVAX` Collateral / `6.5 mUSDC` Debt),
   approves `GovExit` as her Exit agent, and sets her Exit rule at Minimum
   threshold `7000` bps.
2. Keeper started (already polling).
3. Demo Admin queues `8000 → 6000` (`6000 < 7000`) as **proposal 2**:
   `0x9cd5918bfa9610ecb24faff13b974029ec80d6bd5bb696388a19b579fabc5faf`.
4. Keeper detected the Proposal within ~1 s, session — no Alice signature — and
   called `checkAndExit(alice, 2)`:

   **`0xfd30298f23295af6b67dadae23c999733f4f80bb687138c3cdf8d8cc8188486a`**
   (block `58722503`; `from` = Keeper `0xfD0a…95F3`).

5. Outcome: Position `(0, 0, false)` — **Debt `0`, inactive**; Exit rule
   `(7000, true, true)` (Triggered); `ExitTriggered` emitted at that block; the
   `0.175 AVAX` remainder returned (Alice `0.175 → 0.35 AVAX`).

To confirm on chain:

```shell
cast logs --address 0xF896aFC531B18f35EE90e770bD4486Ef8ef64F4E \
  --from-block 58722211 --to-block latest --rpc-url fuji \
  | grep 0x47c99ae755d0ea2874d155be033cdb04fdd79ffdcd969d0092d74678f9d58647
```

The decision was deterministic (`6000 < 7000`) and lived entirely in `GovExit`;
the Keeper had no discretion and no custody.
