// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockLendingPool} from "../src/MockLendingPool.sol";
import {MockGovernance} from "../src/MockGovernance.sol";
import {GovExit} from "../src/GovExit.sol";

/// @notice Deploys the four GovExit contracts in the order that resolves the
///         governance <-> pool circular dependency, then seeds the pool with mUSDC
///         so it can lend. Plan §11.
///
///         The broadcaster (the `--private-key` / `--sender` deployer) is the pool's
///         interim governance just long enough to call `setGovernance`; ownership of
///         MockGovernance goes to the Demo Admin, never the deployer.
contract Deploy is Script {
    /// @dev Sane local default (Anvil account #1) so the script runs against Anvil
    ///      with no secrets. Override with DEMO_ADMIN_ADDRESS for Fuji. Never
    ///      hardcode a private key anywhere.
    address internal constant DEFAULT_DEMO_ADMIN = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    /// @dev Enough for the demo's 130 mUSDC borrow, with headroom.
    uint256 internal constant POOL_SEED = 1_000e18;

    function run()
        external
        returns (
            MockUSDC usdc,
            MockLendingPool pool,
            MockGovernance governance,
            GovExit govExit
        )
    {
        address demoAdmin = vm.envOr("DEMO_ADMIN_ADDRESS", DEFAULT_DEMO_ADMIN);

        vm.startBroadcast();

        // 1. Mock token.
        usdc = new MockUSDC();

        // 2. The deployer is the pool's interim governance, breaking the
        //    construction cycle between the pool and MockGovernance.
        pool = new MockLendingPool(address(usdc), msg.sender);

        // 3. MockGovernance, owned by the Demo Admin — not the deployer.
        governance = new MockGovernance(address(pool), demoAdmin);

        // 4. The deployer, still the pool's interim governance, hands it to
        //    MockGovernance; an executed Proposal is now the only way the
        //    Liquidation threshold moves.
        pool.setGovernance(address(governance));

        // 5. GovExit is the Exit agent, wired to the pool and MockGovernance.
        govExit = new GovExit(address(pool), address(governance));

        // 6. Seed the pool so it can lend mUSDC.
        usdc.mint(address(pool), POOL_SEED);

        vm.stopBroadcast();

        console2.log("MockUSDC:        ", address(usdc));
        console2.log("MockLendingPool: ", address(pool));
        console2.log("MockGovernance:  ", address(governance));
        console2.log("GovExit:         ", address(govExit));
        console2.log("Demo Admin:      ", demoAdmin);
    }
}
