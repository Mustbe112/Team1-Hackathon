// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice The slice of MockLendingPool that GovExit needs: Position reads for the
///         active/solvency checks and the exit-agent approval. Keeping this minimal
///         hides the pool's borrow/close machinery from the Exit agent.
interface IGovExitPool {
    function positions(address user) external view returns (uint256 collateral, uint256 debt, bool active);

    function exitAgents(address user, address agent) external view returns (bool);

    function AVAX_PRICE_USD() external view returns (uint256);

    function closePositionFor(address user) external;
}

/// @notice The slice of MockGovernance that GovExit needs: the Proposal and its state.
interface IGovExitGovernance {
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

    function getProposal(uint256 proposalId) external view returns (Proposal memory);
}

/// @notice The Exit agent: holds each Protected user's pre-committed Exit rule and
///         reports whether a queued threshold Proposal should trigger an exit.
contract GovExit is ReentrancyGuard {
    struct ExitRule {
        uint256 minimumThresholdBps;
        bool active;
        bool triggered;
    }

    mapping(address => ExitRule) public rules;

    IGovExitPool public immutable pool;
    IGovExitGovernance public immutable governance;

    error NotExitAgent();
    error ZeroAddress();
    error RuleNotTriggered();

    event RuleCreated(address indexed user, uint256 minimumThresholdBps);
    event RuleDisabled(address indexed user);
    event ExitTriggered(
        address indexed user,
        uint256 indexed proposalId,
        uint256 userMinimum,
        uint256 proposedThreshold
    );

    constructor(address pool_, address governance_) {
        if (pool_ == address(0) || governance_ == address(0)) {
            revert ZeroAddress();
        }
        pool = IGovExitPool(pool_);
        governance = IGovExitGovernance(governance_);
    }

    /// @notice Create or re-arm an Exit rule. Reverts unless the caller has already
    ///         approved this contract as their Exit agent, so a rule can never exist
    ///         that silently cannot fire. A re-set clears Triggered.
    function setRule(uint256 minimumThresholdBps) external {
        if (!pool.exitAgents(msg.sender, address(this))) {
            revert NotExitAgent();
        }
        rules[msg.sender] = ExitRule({minimumThresholdBps: minimumThresholdBps, active: true, triggered: false});
        emit RuleCreated(msg.sender, minimumThresholdBps);
    }

    function disableRule() external {
        rules[msg.sender].active = false;
        emit RuleDisabled(msg.sender);
    }

    function shouldExit(address user, uint256 proposalId) external view returns (bool) {
        return _shouldExit(user, proposalId);
    }

    /// @notice Permissionless: any Keeper may call. Re-verifies every condition through
    ///         the shared `_shouldExit`; the caller is never trusted.
    function checkAndExit(address user, uint256 proposalId) external nonReentrant {
        if (!_shouldExit(user, proposalId)) {
            revert RuleNotTriggered();
        }
        // Read the two boundary values the predicate just validated; capturing them
        // before the interaction keeps the emitted data stable across reentrancy.
        uint256 userMinimum = rules[user].minimumThresholdBps;
        uint256 proposedThreshold = governance.getProposal(proposalId).newThresholdBps;

        // Effects before interactions: Triggered is the replay guard, so it is set
        // before the pool closes the Position.
        rules[user].triggered = true;
        pool.closePositionFor(user);

        emit ExitTriggered(user, proposalId, userMinimum, proposedThreshold);
    }

    /// @dev Single source of truth for the exit decision, shared by `shouldExit`
    ///      and (issue 06) `checkAndExit` so their predicates cannot drift.
    function _shouldExit(address user, uint256 proposalId) internal view returns (bool) {
        ExitRule storage rule = rules[user];
        if (!_ruleAllows(rule)) {
            return false;
        }
        if (!_proposalAllows(proposalId, rule.minimumThresholdBps)) {
            return false;
        }
        return _positionAllows(user);
    }

    /// @dev Conditions 1-2: the rule is active and not Triggered.
    function _ruleAllows(ExitRule storage rule) private view returns (bool) {
        return rule.active && !rule.triggered;
    }

    /// @dev Conditions 3-5: a QUEUED Proposal, still inside its Timelock, whose new
    ///      threshold is strictly below the user's Minimum threshold.
    function _proposalAllows(uint256 proposalId, uint256 minimumThresholdBps) private view returns (bool) {
        IGovExitGovernance.Proposal memory proposal = governance.getProposal(proposalId);
        if (proposal.state != IGovExitGovernance.ProposalState.QUEUED) {
            return false;
        }
        if (block.timestamp >= proposal.executeAfter) {
            return false;
        }
        return proposal.newThresholdBps < minimumThresholdBps;
    }

    /// @dev Conditions 6-8: an active Position, approved Exit agent, and solvency
    ///      re-read from the pool at the fixed price.
    function _positionAllows(address user) private view returns (bool) {
        (uint256 collateral, uint256 debt, bool active) = pool.positions(user);
        if (!active) {
            return false;
        }
        if (!pool.exitAgents(user, address(this))) {
            return false;
        }
        uint256 collateralValue = (collateral * pool.AVAX_PRICE_USD()) / 1e18;
        return debt <= collateralValue;
    }
}
