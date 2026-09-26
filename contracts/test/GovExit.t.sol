// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockLendingPool} from "../src/MockLendingPool.sol";
import {MockGovernance} from "../src/MockGovernance.sol";
import {GovExit} from "../src/GovExit.sol";

contract GovExitTest is Test {
    MockUSDC internal usdc;
    MockLendingPool internal pool;
    MockGovernance internal gov;
    GovExit internal govExit;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal keeper = makeAddr("keeper");

    uint256 internal constant COLLATERAL = 10e18; // 10 AVAX
    uint256 internal constant BORROW = 130e18; // 130 mUSDC
    uint256 internal constant MINIMUM = 7000; // 70%

    function setUp() public {
        usdc = new MockUSDC();
        pool = new MockLendingPool(address(usdc), admin);
        gov = new MockGovernance(address(pool), admin);
        govExit = new GovExit(address(pool), address(gov));

        // MockGovernance is the pool's governance, so an executed Proposal is the
        // only thing that can move the liquidation threshold.
        vm.prank(admin);
        pool.setGovernance(address(gov));

        usdc.mint(address(pool), 1_000e18); // fund the pool to lend
        vm.deal(alice, 100e18);
    }

    function test_SetRuleRevertsBeforeApproval() public {
        vm.prank(alice);
        vm.expectRevert(GovExit.NotExitAgent.selector);
        govExit.setRule(MINIMUM);
    }

    function test_SetRuleRecordsRuleAndEmits() public {
        _approveGovExit();

        vm.expectEmit(address(govExit));
        emit GovExit.RuleCreated(alice, MINIMUM);

        vm.prank(alice);
        govExit.setRule(MINIMUM);

        (uint256 minimum, bool active, bool triggered) = govExit.rules(alice);
        assertEq(minimum, MINIMUM);
        assertTrue(active);
        assertFalse(triggered);
    }

    function test_DisableRuleDeactivatesAndEmits() public {
        _setRule();

        vm.expectEmit(address(govExit));
        emit GovExit.RuleDisabled(alice);

        vm.prank(alice);
        govExit.disableRule();

        (, bool active,) = govExit.rules(alice);
        assertFalse(active);
    }

    function test_ShouldExitTrueOneBelowMinimum() public {
        _openAlice();
        _setRule();
        uint256 proposalId = _queue(6999);

        assertTrue(govExit.shouldExit(alice, proposalId));
    }

    function test_ShouldExitFalseAtExactMinimum() public {
        _openAlice();
        _setRule();
        uint256 proposalId = _queue(MINIMUM);

        assertFalse(govExit.shouldExit(alice, proposalId));
    }

    function test_ShouldExitFalseWhenNoPosition() public {
        _setRule();
        uint256 proposalId = _queue(6999);

        assertFalse(govExit.shouldExit(alice, proposalId));
    }

    function test_ShouldExitFalseWhenAgentUnapproved() public {
        _openAlice();
        _setRule();
        vm.prank(alice);
        pool.approveExitAgent(address(govExit), false);

        uint256 proposalId = _queue(6999);
        assertFalse(govExit.shouldExit(alice, proposalId));
    }

    function test_ShouldExitFalseWhenUnderwater() public {
        _openAlice();
        _setRule();
        uint256 proposalId = _queue(6999);

        // `openPosition` caps Debt at collateralValue, so an underwater Position is
        // unreachable through the API. Force one to exercise condition 8, then
        // assert the real pool state so a wrong storage layout fails loudly.
        _forceUnderwater(alice, 5e18, BORROW);
        (uint256 collateral, uint256 debt, bool active) = pool.positions(alice);
        assertEq(collateral, 5e18);
        assertEq(debt, BORROW);
        assertTrue(active);

        assertFalse(govExit.shouldExit(alice, proposalId));
    }

    function test_ShouldExitFalseOnceTimelockElapsed() public {
        _openAlice();
        _setRule();
        uint256 proposalId = _queue(6000);

        vm.warp(block.timestamp + 60); // at `executeAfter`, the Timelock is over
        assertFalse(govExit.shouldExit(alice, proposalId));
    }

    function test_ShouldExitFalseWhenTriggered() public {
        _openAlice();
        _setRule();
        uint256 proposalId = _queue(6000);

        // `checkAndExit` (issue 06) is the only writer of Triggered, so force the
        // flag and assert the real rule state to catch a wrong layout.
        _forceTriggered(alice);
        (, bool active, bool triggered) = govExit.rules(alice);
        assertTrue(active);
        assertTrue(triggered);

        assertFalse(govExit.shouldExit(alice, proposalId));
    }

    function test_ShouldExitFalseWhenThresholdUnchanged() public {
        _openAlice();
        _setRule();
        uint256 proposalId = _queue(8000); // stays at 80%

        assertFalse(govExit.shouldExit(alice, proposalId));
    }

    function test_ShouldExitFalseWhenProposalAboveMinimum() public {
        _openAlice();
        _setRule();
        uint256 proposalId = _queue(7500); // 80 → 75, minimum 70

        assertFalse(govExit.shouldExit(alice, proposalId));
    }

    function test_ShouldExitTrueWhenProposalBelowMinimum() public {
        _openAlice();
        _setRule();
        uint256 proposalId = _queue(6000); // 80 → 60, minimum 70

        assertTrue(govExit.shouldExit(alice, proposalId));
    }

    function test_ShouldExitFalseWhenProposalCancelled() public {
        _openAlice();
        _setRule();
        uint256 proposalId = _queue(6000);

        vm.prank(admin);
        gov.cancelProposal(proposalId);

        assertFalse(govExit.shouldExit(alice, proposalId));
    }

    function test_ShouldExitFalseWhenProposalExecuted() public {
        _openAlice();
        _setRule();
        uint256 proposalId = _queue(6000);

        vm.warp(block.timestamp + 60);
        vm.prank(admin);
        gov.executeProposal(proposalId);

        assertFalse(govExit.shouldExit(alice, proposalId));
    }

    function test_ShouldExitFalseWhenRuleDisabled() public {
        _openAlice();
        _setRule();
        vm.prank(alice);
        govExit.disableRule();

        uint256 proposalId = _queue(6000);
        assertFalse(govExit.shouldExit(alice, proposalId));
    }

    function test_ShouldExitFalseWhenNoRule() public {
        _openAlice();
        _approveGovExit();
        uint256 proposalId = _queue(6000);

        assertFalse(govExit.shouldExit(alice, proposalId));
    }

    function test_ShouldExitFalseForUnknownProposal() public {
        _openAlice();
        _setRule();

        assertFalse(govExit.shouldExit(alice, 42));
    }

    function test_CheckAndExitRevertsWhenBoundaryNotCrossed() public {
        _openAlice();
        _setRule();
        uint256 proposalId = _queue(MINIMUM); // 7000 < 7000 is false: no exit

        vm.prank(keeper);
        vm.expectRevert(GovExit.RuleNotTriggered.selector);
        govExit.checkAndExit(alice, proposalId);
    }

    function test_CheckAndExitClosesPositionAndReturnsRemainder() public {
        _openAlice();
        _setRule();
        uint256 proposalId = _queue(6999); // 6999 < 7000: exit

        uint256 aliceBalanceBefore = alice.balance;

        vm.prank(keeper);
        govExit.checkAndExit(alice, proposalId);

        (uint256 collateral, uint256 debt, bool active) = pool.positions(alice);
        assertEq(collateral, 0);
        assertEq(debt, 0);
        assertFalse(active);

        (, bool ruleActive, bool triggered) = govExit.rules(alice);
        assertTrue(ruleActive);
        assertTrue(triggered);

        // 130 mUSDC Debt settles at 20 mUSDC/AVAX = 6.5 AVAX retained; 10 - 6.5 returned.
        assertEq(alice.balance - aliceBalanceBefore, 3.5e18);
    }

    function test_CheckAndExitEmitsExitTriggered() public {
        _openAlice();
        _setRule();
        uint256 proposalId = _queue(6999);

        vm.expectEmit(address(govExit));
        emit GovExit.ExitTriggered(alice, proposalId, MINIMUM, 6999);

        vm.prank(keeper);
        govExit.checkAndExit(alice, proposalId);
    }

    function test_CheckAndExitRevertsForRandomKeeperWhenRuleNotMet() public {
        _openAlice();
        _setRule();
        uint256 proposalId = _queue(7500); // above the Minimum threshold: not met

        vm.prank(keeper);
        vm.expectRevert(GovExit.RuleNotTriggered.selector);
        govExit.checkAndExit(alice, proposalId);

        // A failed check must not consume the rule.
        (, bool active, bool triggered) = govExit.rules(alice);
        assertTrue(active);
        assertFalse(triggered);
    }

    function test_CheckAndExitRevertsOnSecondCall() public {
        _openAlice();
        _setRule();
        uint256 proposalId = _queue(6999);

        vm.prank(keeper);
        govExit.checkAndExit(alice, proposalId);

        (uint256 collateral, uint256 debt, bool active) = pool.positions(alice);
        assertEq(collateral, 0);
        assertEq(debt, 0);
        assertFalse(active);

        // Triggered is true, so the rule cannot fire a second time.
        vm.prank(keeper);
        vm.expectRevert(GovExit.RuleNotTriggered.selector);
        govExit.checkAndExit(alice, proposalId);
    }

    function test_CheckAndExitRevertsAfterTimelock() public {
        _openAlice();
        _setRule();
        uint256 proposalId = _queue(6000);

        vm.warp(block.timestamp + 60); // at `executeAfter`, the Timelock is over

        vm.prank(keeper);
        vm.expectRevert(GovExit.RuleNotTriggered.selector);
        govExit.checkAndExit(alice, proposalId);
    }

    function test_CheckAndExitCannotCloseWithoutApproval() public {
        _openAlice();
        _setRule();
        vm.prank(alice);
        pool.approveExitAgent(address(govExit), false);

        uint256 proposalId = _queue(6000);

        vm.prank(keeper);
        vm.expectRevert(GovExit.RuleNotTriggered.selector);
        govExit.checkAndExit(alice, proposalId);
    }

    function test_CheckAndExitBoundaryPair() public {
        _openAlice();
        _setRule();

        uint256 atMinimum = _queue(MINIMUM); // 7000 < 7000 is false: no exit
        vm.prank(keeper);
        vm.expectRevert(GovExit.RuleNotTriggered.selector);
        govExit.checkAndExit(alice, atMinimum);

        uint256 oneBelow = _queue(6999); // 6999 < 7000 is true: exit
        vm.prank(keeper);
        govExit.checkAndExit(alice, oneBelow);

        (, uint256 debt, bool active) = pool.positions(alice);
        assertEq(debt, 0);
        assertFalse(active);
    }

    function test_ConstructorWiresPoolAndGovernance() public view {
        assertEq(address(govExit.pool()), address(pool));
        assertEq(address(govExit.governance()), address(gov));
    }

    function test_ConstructorRejectsZeroPool() public {
        vm.expectRevert(GovExit.ZeroAddress.selector);
        new GovExit(address(0), address(gov));
    }

    function test_ConstructorRejectsZeroGovernance() public {
        vm.expectRevert(GovExit.ZeroAddress.selector);
        new GovExit(address(pool), address(0));
    }

    function _approveGovExit() internal {
        vm.prank(alice);
        pool.approveExitAgent(address(govExit), true);
    }

    function _setRule() internal {
        _approveGovExit();
        vm.prank(alice);
        govExit.setRule(MINIMUM);
    }

    function _openAlice() internal {
        vm.prank(alice);
        pool.openPosition{value: COLLATERAL}(BORROW);
    }

    function _queue(uint256 newThresholdBps) internal returns (uint256) {
        vm.prank(admin);
        return gov.queueThresholdChange(newThresholdBps);
    }

    /// @dev `positions` is the third storage variable in MockLendingPool:
    ///      slot 0 = liquidationThresholdBps, 1 = governance, 2 = positions.
    ///      ReentrancyGuard v5.x uses transient storage, so it takes no slot.
    uint256 internal constant POOL_POSITIONS_SLOT = 2;

    function _forceUnderwater(address user, uint256 collateral, uint256 debt) internal {
        bytes32 base = keccak256(abi.encode(user, POOL_POSITIONS_SLOT));
        vm.store(address(pool), base, bytes32(collateral));
        vm.store(address(pool), bytes32(uint256(base) + 1), bytes32(debt));
        vm.store(address(pool), bytes32(uint256(base) + 2), bytes32(uint256(1)));
    }

    /// @dev GovExit has no persistent state before `rules`, so it is slot 0. Each
    ///      ExitRule packs `minimumThresholdBps` in its base slot and
    ///      `active`/`triggered` in the next (bytes 0 and 1).
    uint256 internal constant GOV_EXIT_RULES_SLOT = 0;

    function _forceTriggered(address user) internal {
        bytes32 base = keccak256(abi.encode(user, GOV_EXIT_RULES_SLOT));
        vm.store(address(govExit), bytes32(uint256(base) + 1), bytes32(uint256(0x0101)));
    }
}
