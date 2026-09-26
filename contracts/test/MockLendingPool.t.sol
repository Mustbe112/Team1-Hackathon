// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockLendingPool} from "../src/MockLendingPool.sol";

contract MockLendingPoolTest is Test {
    MockUSDC internal usdc;
    MockLendingPool internal pool;

    address internal governance = makeAddr("governance");
    address internal alice = makeAddr("alice");

    uint256 internal constant COLLATERAL = 10e18; // 10 AVAX
    uint256 internal constant BORROW = 130e18; // 130 mUSDC

    function setUp() public {
        usdc = new MockUSDC();
        pool = new MockLendingPool(address(usdc), governance);

        usdc.mint(address(pool), 1_000e18); // fund the pool to lend
        vm.deal(alice, 100e18);
    }

    function test_OpenPositionAtFixedPrice() public {
        vm.prank(alice);
        pool.openPosition{value: COLLATERAL}(BORROW);

        (uint256 collateral, uint256 debt, bool active) = pool.positions(alice);
        assertEq(collateral, COLLATERAL);
        assertEq(debt, BORROW);
        assertTrue(active);
        assertEq(usdc.balanceOf(alice), BORROW);
        assertEq(address(pool).balance, COLLATERAL);
    }

    function test_OpenRevertsWhenDebtExceedsThreshold() public {
        vm.prank(alice);
        vm.expectRevert(MockLendingPool.InsufficientCollateral.selector);
        pool.openPosition{value: COLLATERAL}(161e18);
    }

    function test_ApproveExitAgentSetsFlag() public {
        address agent = makeAddr("agent");
        vm.prank(alice);
        pool.approveExitAgent(agent, true);
        assertTrue(pool.exitAgents(alice, agent));

        vm.prank(alice);
        pool.approveExitAgent(agent, false);
        assertFalse(pool.exitAgents(alice, agent));
    }

    function test_ClosePositionForSettlesAtFixedPrice() public {
        _openAlice();
        address agent = makeAddr("agent");
        vm.prank(alice);
        pool.approveExitAgent(agent, true);

        uint256 aliceBefore = alice.balance;
        vm.prank(agent);
        pool.closePositionFor(alice);

        (, uint256 debt, bool active) = pool.positions(alice);
        assertEq(debt, 0);
        assertFalse(active);
        assertEq(alice.balance, aliceBefore + 3.5e18);
        assertEq(address(pool).balance, 6.5e18);
    }

    function test_ClosePositionForRevertsForUnapprovedCaller() public {
        _openAlice();
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(MockLendingPool.NotExitAgent.selector);
        pool.closePositionFor(alice);
    }

    function test_ClosePositionForRevertsWhenNoPosition() public {
        address agent = makeAddr("agent");
        vm.prank(alice);
        pool.approveExitAgent(agent, true);

        vm.prank(agent);
        vm.expectRevert(MockLendingPool.NoPosition.selector);
        pool.closePositionFor(alice);
    }

    function test_ClosePositionReturnsRemainderToUser() public {
        _openAlice();
        uint256 aliceBefore = alice.balance;

        vm.prank(alice);
        pool.closePosition();

        (, uint256 debt, bool active) = pool.positions(alice);
        assertEq(debt, 0);
        assertFalse(active);
        assertEq(alice.balance, aliceBefore + 3.5e18);
    }

    function _openAlice() internal {
        vm.prank(alice);
        pool.openPosition{value: COLLATERAL}(BORROW);
    }

    function test_SetLiquidationThresholdOnlyGovernance() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(MockLendingPool.NotGovernance.selector);
        pool.setLiquidationThreshold(5000);
    }

    function test_SetLiquidationThresholdRejectsZero() public {
        vm.prank(governance);
        vm.expectRevert(MockLendingPool.InvalidThresholdBps.selector);
        pool.setLiquidationThreshold(0);
    }

    function test_SetLiquidationThresholdRejectsAbove10000() public {
        vm.prank(governance);
        vm.expectRevert(MockLendingPool.InvalidThresholdBps.selector);
        pool.setLiquidationThreshold(10_001);
    }

    function test_SetLiquidationThresholdUpdatesValue() public {
        vm.prank(governance);
        pool.setLiquidationThreshold(5000);
        assertEq(pool.liquidationThresholdBps(), 5000);
    }

    function test_SetGovernanceOnlyGovernance() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(MockLendingPool.NotGovernance.selector);
        pool.setGovernance(makeAddr("newGovernance"));
    }

    function test_SetGovernanceTransfersControl() public {
        address newGovernance = makeAddr("newGovernance");
        vm.prank(governance);
        pool.setGovernance(newGovernance);
        assertEq(pool.governance(), newGovernance);
    }

    function test_HealthFactorForDemoPosition() public {
        _openAlice();
        // collateralValue = 200e18; weighted = 160e18; /130e18 = 1.230769...e18
        assertEq(pool.healthFactor(alice), 1230769230769230769);
    }

    function test_HealthFactorIsMaxWhenNoDebt() public view {
        assertEq(pool.healthFactor(alice), type(uint256).max);
    }

    function test_OpenAtExactCeilingSucceeds() public {
        // 10 AVAX -> 200e18 value; 80% ceiling = 160e18.
        vm.prank(alice);
        pool.openPosition{value: COLLATERAL}(160e18);
        (, uint256 debt,) = pool.positions(alice);
        assertEq(debt, 160e18);
    }

    function test_OpenAccumulatesIntoExistingPosition() public {
        vm.startPrank(alice);
        pool.openPosition{value: 5e18}(65e18);
        pool.openPosition{value: 5e18}(65e18);
        vm.stopPrank();

        (uint256 collateral, uint256 debt, bool active) = pool.positions(alice);
        assertEq(collateral, COLLATERAL);
        assertEq(debt, BORROW);
        assertTrue(active);
    }

    function test_ThresholdChangeConstrainsNewBorrows() public {
        vm.prank(governance);
        pool.setLiquidationThreshold(5000); // 50% of 200e18 = 100e18 ceiling

        vm.prank(alice);
        vm.expectRevert(MockLendingPool.InsufficientCollateral.selector);
        pool.openPosition{value: COLLATERAL}(130e18);
    }

    function test_SetGovernanceRejectsZeroAddress() public {
        vm.prank(governance);
        vm.expectRevert(MockLendingPool.ZeroAddress.selector);
        pool.setGovernance(address(0));
    }

    function test_ConstructorRejectsZeroToken() public {
        vm.expectRevert(MockLendingPool.ZeroAddress.selector);
        new MockLendingPool(address(0), governance);
    }

    function test_ConstructorRejectsZeroGovernance() public {
        vm.expectRevert(MockLendingPool.ZeroAddress.selector);
        new MockLendingPool(address(usdc), address(0));
    }

    function test_OpenWithNoCollateralReverts() public {
        vm.prank(alice);
        vm.expectRevert(MockLendingPool.InsufficientCollateral.selector);
        pool.openPosition(0);
    }
}
