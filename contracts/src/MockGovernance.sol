// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice The slice of MockLendingPool that MockGovernance needs. Keeping this
///         minimal hides the pool's Position/close machinery from governance.
interface ILendingPool {
    function setLiquidationThreshold(uint256 thresholdBps) external;
    function liquidationThresholdBps() external view returns (uint256);
}

/// @notice Minimal owner-gated governance mock for the GovExit demo: the Demo
///         Admin queues a liquidation-threshold Proposal, a Timelock runs, then
///         anyone may execute it.
contract MockGovernance is Ownable {
    enum ProposalState {
        NONE,
        QUEUED,
        EXECUTED,
        CANCELLED
    }

    struct Proposal {
        uint256 id;
        uint256 newThresholdBps;
        uint256 executeAfter;
        ProposalState state;
    }

    uint256 public timelockSeconds = 60;
    ILendingPool public immutable pool;

    uint256 private _nextProposalId = 1;
    mapping(uint256 => Proposal) private _proposals;

    error ZeroAddress();
    error UnknownProposal(uint256 proposalId);
    error ProposalNotQueued(uint256 proposalId, ProposalState state);
    error TimelockActive(uint256 proposalId, uint256 executeAfter);

    event ProposalQueued(
        uint256 indexed proposalId,
        uint256 currentThreshold,
        uint256 newThreshold,
        uint256 executeAfter
    );
    event ProposalExecuted(uint256 indexed proposalId, uint256 newThreshold);
    event ProposalCancelled(uint256 indexed proposalId);

    constructor(address pool_, address initialOwner) Ownable(initialOwner) {
        if (pool_ == address(0)) {
            revert ZeroAddress();
        }
        pool = ILendingPool(pool_);
    }

    function queueThresholdChange(uint256 newThresholdBps) external onlyOwner returns (uint256) {
        uint256 proposalId = _nextProposalId++;
        Proposal storage proposal = _proposals[proposalId];
        proposal.id = proposalId;
        proposal.newThresholdBps = newThresholdBps;
        proposal.executeAfter = block.timestamp + timelockSeconds;
        proposal.state = ProposalState.QUEUED;

        emit ProposalQueued(
            proposalId,
            pool.liquidationThresholdBps(),
            newThresholdBps,
            proposal.executeAfter
        );
        return proposalId;
    }

    function setTimelock(uint256 newTimelockSeconds) external onlyOwner {
        timelockSeconds = newTimelockSeconds;
    }

    function executeProposal(uint256 proposalId) external {
        Proposal storage proposal = _queuedProposal(proposalId);
        if (block.timestamp < proposal.executeAfter) {
            revert TimelockActive(proposalId, proposal.executeAfter);
        }
        proposal.state = ProposalState.EXECUTED;

        emit ProposalExecuted(proposalId, proposal.newThresholdBps);

        pool.setLiquidationThreshold(proposal.newThresholdBps);
    }

    function cancelProposal(uint256 proposalId) external onlyOwner {
        Proposal storage proposal = _queuedProposal(proposalId);
        proposal.state = ProposalState.CANCELLED;

        emit ProposalCancelled(proposalId);
    }

    function getProposal(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }

    /// @dev Single source of truth for "a Proposal that may still transition":
    ///      it exists and is QUEUED. Shared by execute and cancel so the guards
    ///      cannot drift.
    function _queuedProposal(uint256 proposalId) private view returns (Proposal storage) {
        Proposal storage proposal = _proposals[proposalId];
        if (proposal.id == 0) {
            revert UnknownProposal(proposalId);
        }
        if (proposal.state != ProposalState.QUEUED) {
            revert ProposalNotQueued(proposalId, proposal.state);
        }
        return proposal;
    }
}
