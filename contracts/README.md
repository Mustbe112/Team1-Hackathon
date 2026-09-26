# GovExit Contracts

Solidity contracts for GovExit, built with Foundry. Four contracts: `MockUSDC`,
`MockLendingPool`, `MockGovernance`, and `GovExit` (the Exit agent).

## Toolchain (frozen)

- Solidity `0.8.24`, `evm_version = "cancun"` — Avalanche implements Cancun, not Pectra,
  while `solc >= 0.8.30` defaults to `prague`.
- OpenZeppelin Contracts v5 (git submodule, pinned in `foundry.lock`).
- Foundry 1.8.3.

## Commands

```shell
forge build
forge test
forge test --match-path test/GovExit.t.sol
```

## Dependencies

Installed as git submodules under `lib/`. Clone the repository with:

```shell
git clone --recurse-submodules <repo-url>
```

## Deploy

```shell
set -a; source ../.env; set +a
forge script script/Deploy.s.sol --rpc-url fuji --broadcast \
  --private-key "$DEMO_ADMIN_PRIVATE_KEY"
```

The script deploys the four contracts in the order that breaks the
governance ↔ pool construction cycle (the broadcaster is the pool's interim
governance just long enough to call `setGovernance`), then seeds the pool with
1,000 mUSDC so it can lend.

## Verification

Foundry 1.8.3 routes `avalanche_fuji` to Etherscan V2, where a Snowtrace/Routescan key
does **not** work. Use the first-party Builder Hub verifier instead:

```shell
forge script script/Deploy.s.sol --rpc-url fuji --broadcast --verify \
  --verifier custom \
  --verifier-url https://build.avax.network/api/verify/43113/api
```

## Deployed addresses (Avalanche Fuji, chain ID 43113)

| Contract | Address |
|---|---|
| `MockUSDC` | `0x84BDD89D2081BEe20f63FBD90A20d6a1D0f9Ad94` |
| `MockLendingPool` | `0x25838379779FB4b229efbCCbb96d52aa94ddF278` |
| `MockGovernance` | `0xAb01AFe53C0aFd8348a3117eb9487A82362B95EB` |
| `GovExit` | `0x90970F046e70B4E11579566aD22F5CFb8AefC390` |

- **Deploy block:** `58732756` (bounds every Keeper `getLogs` scan via `DEPLOY_BLOCK`)
- **Demo Admin (owns `MockGovernance`):** `0x1F23EbA427de7f924C1Af1e87D99fC797877e461`

## Live proof

An automatic exit with no user signature after the rule was set:

- `checkAndExit` tx `0x16462c466a7a146b96bf39c649fe1a896546d3977703c3ba1c262796e355ea18`
  (block `58732844`).
- On chain afterwards: Position `(0, 0, inactive)` and Exit rule `(7000, active, triggered)`.

## Repeatable demo runner

`../scripts/demo-run.sh` does the whole story in one shot and can loop it, so the
demo can be replayed as many times as wanted without a browser:

```shell
scripts/demo-run.sh                          # 1 run at the small defaults
scripts/demo-run.sh 0.02 0.3 7000 6000 5     # 5 back-to-back runs
scripts/demo-run.sh 0.5 6.5 7000 6000 1      # the issue-10/11 scaled Position
```

Arguments are `[collateralAvax] [borrowMusdc] [minBps] [proposedBps] [runs]`.
Each run opens Alice's Position, (re-)sets her Exit rule (a re-set re-arms a
Triggered rule), queues a Proposal as the Demo Admin, then calls `checkAndExit`
with the Keeper key — the Keeper's exact permissionless call. It needs `cast`,
`jq`, `node`, and the repo-root `.env` keys. Like the Keeper, it ships the
canonical Fuji addresses as built-in defaults and ignores `NEXT_PUBLIC_*` (override
with `POOL_ADDRESS` / `GOVERNANCE_ADDRESS` / `GOVEXIT_ADDRESS`), so a stale browser
env cannot point it at an old deployment.

## Manual reproduction (cast)

The full flow is reproducible from the command line, independent of the UI. From
`contracts/`, with the environment loaded:

```shell
set -a; source ../.env; set +a
export POOL=0x25838379779FB4b229efbCCbb96d52aa94ddF278
export GOVERNANCE=0xAb01AFe53C0aFd8348a3117eb9487A82362B95EB
export GOVEXIT=0x90970F046e70B4E11579566aD22F5CFb8AefC390

cast call $POOL 'liquidationThresholdBps()(uint256)' --rpc-url fuji
cast call $GOVEXIT 'shouldExit(address,uint256)(bool)' $ALICE <proposalId> --rpc-url fuji
cast logs --address $GOVEXIT --from-block 58732756 --to-block latest --rpc-url fuji
```

> **Scaled Position.** Testnet funds are scarce, so the demo uses a small Position
> (e.g. 0.5 AVAX Collateral / 6.5 mUSDC Debt) instead of the PRD's 10 / 130 — the
> same 1:13 ratio and 80% Liquidation threshold story, scaled down. At the fixed
> `AVAX_PRICE_USD = 20e18`, Debt settles against `collateral / 20` AVAX and the pool
> returns the remainder to the user.

See the repository root `README.md` for the full project context.
