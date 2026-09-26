// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockLendingPool} from "../src/MockLendingPool.sol";
import {MockGovernance} from "../src/MockGovernance.sol";

contract MockGovernanceTest is Test {
    MockUSDC internal usdc;
    MockLendingPool internal pool;
    MockGovernance internal gov;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        usdc = new MockUSDC();
        pool = new MockLendingPool(address(usdc), admin);
        gov = new MockGovernance(address(pool), admin);

        // MockGovernance is the pool's governance, so an executed Proposal is
        // the only thing that can move the liquidation threshold.
        vm.prank(admin);
        pool.setGovernance(address(gov));
    }

    function test_QueueRevertsForNonOwner() public {
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper)
        );
        gov.queueThresholdChange(5000);
    }

    function test_QueueRecordsProposalAndLeavesThresholdUnchanged() public {
        vm.expectEmit(address(gov));
        emit MockGovernance.ProposalQueued(1, 8000, 5000, block.timestamp + 60);

        vm.prank(admin);
        uint256 proposalId = gov.queueThresholdChange(5000);

        assertEq(proposalId, 1);
        MockGovernance.Proposal memory proposal = gov.getProposal(proposalId);
        assertEq(proposal.id, 1);
        assertEq(proposal.newThresholdBps, 5000);
        assertEq(proposal.executeAfter, block.timestamp + 60);
        assertEq(uint256(proposal.state), uint256(MockGovernance.ProposalState.QUEUED));
        // The threshold moves only on execution, not on queueing.
        assertEq(pool.liquidationThresholdBps(), 8000);
    }

    function test_ExecuteRevertsBeforeTimelock() public {
        vm.prank(admin);
        uint256 proposalId = gov.queueThresholdChange(5000);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockGovernance.TimelockActive.selector,
                proposalId,
                block.timestamp + 60
            )
        );
        gov.executeProposal(proposalId);
    }

    function test_ExecuteAfterTimelockSetsThresholdPermissionlessly() public {
        vm.prank(admin);
        uint256 proposalId = gov.queueThresholdChange(5000);
        vm.warp(block.timestamp + 60);

        vm.expectEmit(address(gov));
        emit MockGovernance.ProposalExecuted(proposalId, 5000);

        // `keeper` is not the owner; execution is permissionless.
        vm.prank(keeper);
        gov.executeProposal(proposalId);

        assertEq(pool.liquidationThresholdBps(), 5000);
        assertEq(
            uint256(gov.getProposal(proposalId).state),
            uint256(MockGovernance.ProposalState.EXECUTED)
        );
    }

    function test_ExecuteRevertsWhenAlreadyExecuted() public {
        vm.prank(admin);
        uint256 proposalId = gov.queueThresholdChange(5000);
        vm.warp(block.timestamp + 60);
        vm.prank(keeper);
        gov.executeProposal(proposalId);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockGovernance.ProposalNotQueued.selector,
                proposalId,
                MockGovernance.ProposalState.EXECUTED
            )
        );
        gov.executeProposal(proposalId);
    }

    function test_CancelRevertsForNonOwner() public {
        vm.prank(admin);
        uint256 proposalId = gov.queueThresholdChange(5000);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper)
        );
        gov.cancelProposal(proposalId);
    }

    function test_CancelledProposalCannotExecute() public {
        vm.prank(admin);
        uint256 proposalId = gov.queueThresholdChange(5000);

        vm.expectEmit(address(gov));
        emit MockGovernance.ProposalCancelled(proposalId);
        vm.prank(admin);
        gov.cancelProposal(proposalId);

        assertEq(
            uint256(gov.getProposal(proposalId).state),
            uint256(MockGovernance.ProposalState.CANCELLED)
        );

        vm.warp(block.timestamp + 60);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockGovernance.ProposalNotQueued.selector,
                proposalId,
                MockGovernance.ProposalState.CANCELLED
            )
        );
        gov.executeProposal(proposalId);

        // A cancelled Proposal never touches the threshold.
        assertEq(pool.liquidationThresholdBps(), 8000);
    }

    function test_SetTimelockRevertsForNonOwner() public {
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper)
        );
        gov.setTimelock(120);
    }

    function test_OwnerCanChangeTimelock() public {
        vm.prank(admin);
        gov.setTimelock(120);
        assertEq(gov.timelockSeconds(), 120);

        vm.prank(admin);
        uint256 proposalId = gov.queueThresholdChange(5000);
        assertEq(gov.getProposal(proposalId).executeAfter, block.timestamp + 120);
    }

    function test_UnknownProposalIdReverts() public {
        uint256 unknownId = 42;

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(MockGovernance.UnknownProposal.selector, unknownId)
        );
        gov.executeProposal(unknownId);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(MockGovernance.UnknownProposal.selector, unknownId)
        );
        gov.cancelProposal(unknownId);

        MockGovernance.Proposal memory proposal = gov.getProposal(unknownId);
        assertEq(proposal.id, 0);
        assertEq(uint256(proposal.state), uint256(MockGovernance.ProposalState.NONE));
    }

    function test_ProposalsAreIndependent() public {
        vm.startPrank(admin);
        uint256 first = gov.queueThresholdChange(5000);
        uint256 second = gov.queueThresholdChange(6000);
        vm.stopPrank();

        assertEq(first, 1);
        assertEq(second, 2);

        vm.warp(block.timestamp + 60);
        vm.prank(keeper);
        gov.executeProposal(first);

        assertEq(pool.liquidationThresholdBps(), 5000);
        assertEq(
            uint256(gov.getProposal(second).state),
            uint256(MockGovernance.ProposalState.QUEUED)
        );

        vm.prank(keeper);
        gov.executeProposal(second);
        assertEq(pool.liquidationThresholdBps(), 6000);
    }

    function test_ConstructorWiresPoolAndOwner() public view {        assertEq(address(gov.pool()), address(pool));
        assertEq(gov.owner(), admin);
    }

    function test_ConstructorRejectsZeroPool() public {
        vm.expectRevert(MockGovernance.ZeroAddress.selector);
        new MockGovernance(address(0), admin);
    }
}