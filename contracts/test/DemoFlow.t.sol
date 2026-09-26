// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockLendingPool} from "../src/MockLendingPool.sol";
import {MockGovernance} from "../src/MockGovernance.sol";
import {GovExit} from "../src/GovExit.sol";

/// @notice The plan's definition of done in one file: deploy the four contracts in
///         the order that resolves the governance <-> pool cycle, then drive the
///         whole happy path through their public interfaces. After `setRule` Alice
///         signs nothing; the Demo Admin queues and a third-party Keeper triggers.
contract DemoFlowTest is Test {
    MockUSDC internal usdc;
    MockLendingPool internal pool;
    MockGovernance internal gov;
    GovExit internal govExit;

    // The deployer is the pool's interim governance only long enough to hand it to
    // MockGovernance; the Demo Admin owns the Proposal queue.
    address internal deployer = makeAddr("deployer");
    address internal demoAdmin = makeAddr("demoAdmin");
    address internal alice = makeAddr("alice");
    address internal keeper = makeAddr("keeper");

    uint256 internal constant COLLATERAL = 10e18; // 10 AVAX
    uint256 internal constant BORROW = 130e18; // 130 mUSDC
    uint256 internal constant MINIMUM = 7000; // 70%

    function setUp() public {
        // 1. Mock token.
        usdc = new MockUSDC();

        // 2. MockLendingPool with the deployer as interim governance, breaking the
        //    construction cycle between the pool and MockGovernance.
        pool = new MockLendingPool(address(usdc), deployer);

        // 3. MockGovernance, owned by the Demo Admin.
        gov = new MockGovernance(address(pool), demoAdmin);

        // 4. The deployer hands the pool's governance to MockGovernance, so an
        //    executed Proposal is now the only way the Liquidation threshold moves.
        vm.prank(deployer);
        pool.setGovernance(address(gov));

        // 5. GovExit is the Exit agent, wired to the pool and MockGovernance.
        govExit = new GovExit(address(pool), address(gov));

        // 6. Fund the pool so it can lend mUSDC.
        usdc.mint(address(pool), 1_000e18);

        vm.deal(alice, 100e18);
    }

    function test_FullHappyPathClosesPositionWithNoUserSignatureAfterRule() public {
        _openAlice();
        _protectAlice();

        // No Proposal yet, so there is nothing for the rule to trigger on.
        assertFalse(govExit.shouldExit(alice, 1));

        // The Demo Admin queues 80% -> 60% with the 60-second Timelock.
        uint256 proposalId = _queue(6000);

        // Before the Keeper triggers, Alice's Position is untouched even though the
        // rule is now armed and the boundary is crossed.
        (, uint256 debtBefore, bool activeBefore) = pool.positions(alice);
        assertEq(debtBefore, BORROW);
        assertTrue(activeBefore);
        assertTrue(govExit.shouldExit(alice, proposalId));

        // Land on the last second of the Timelock window.
        vm.warp(gov.getProposal(proposalId).executeAfter - 1);

        uint256 aliceBalanceBefore = alice.balance;

        // A third-party Keeper triggers the Automatic exit; Alice signs nothing.
        vm.prank(keeper);
        govExit.checkAndExit(alice, proposalId);

        (uint256 collateral, uint256 debt, bool active) = pool.positions(alice);
        assertEq(collateral, 0);
        assertEq(debt, 0);
        assertFalse(active);

        // 130 mUSDC Debt settles at 20 mUSDC/AVAX = 6.5 AVAX retained against Debt;
        // the remaining 3.5 AVAX returns to Alice.
        assertEq(alice.balance - aliceBalanceBefore, 3.5e18);
        assertEq(address(pool).balance, 6.5e18);

        (, bool ruleActive, bool triggered) = govExit.rules(alice);
        assertTrue(ruleActive);
        assertTrue(triggered);
    }

    function test_BoundaryAtExactMinimumDoesNotExit() public {
        _openAlice();
        _protectAlice();

        // 80 -> 70, minimum 70. The boundary is strict: `7000 < 7000` is false, so
        // the rule must not fire and the Position stays open.
        uint256 proposalId = _queue(7000);

        assertFalse(govExit.shouldExit(alice, proposalId));

        vm.prank(keeper);
        vm.expectRevert(GovExit.RuleNotTriggered.selector);
        govExit.checkAndExit(alice, proposalId);

        (, uint256 debt, bool active) = pool.positions(alice);
        assertEq(debt, BORROW);
        assertTrue(active);

        (, bool ruleActive, bool triggered) = govExit.rules(alice);
        assertTrue(ruleActive);
        assertFalse(triggered);
    }

    function test_BoundaryOneBelowMinimumExits() public {
        _openAlice();
        _protectAlice();

        // 80 -> 69, minimum 70. `6999 < 7000` is true, so the Automatic exit fires
        // and Alice still signs nothing.
        uint256 proposalId = _queue(6999);

        assertTrue(govExit.shouldExit(alice, proposalId));

        uint256 aliceBalanceBefore = alice.balance;

        vm.prank(keeper);
        govExit.checkAndExit(alice, proposalId);

        (, uint256 debt, bool active) = pool.positions(alice);
        assertEq(debt, 0);
        assertFalse(active);
        assertEq(alice.balance - aliceBalanceBefore, 3.5e18);
    }

    function _openAlice() internal {
        vm.prank(alice);
        pool.openPosition{value: COLLATERAL}(BORROW);
    }

    /// @dev Alice's only signatures: approve the Exit agent, then set the rule.
    function _protectAlice() internal {
        vm.startPrank(alice);
        pool.approveExitAgent(address(govExit), true);
        govExit.setRule(MINIMUM);
        vm.stopPrank();
    }

    function _queue(uint256 newThresholdBps) internal returns (uint256) {
        vm.prank(demoAdmin);
        return gov.queueThresholdChange(newThresholdBps);
    }
}
