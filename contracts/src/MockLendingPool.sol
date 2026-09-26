// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Minimal lending pool for the GovExit demo: custodies AVAX Collateral,
///         lends mUSDC as Debt, and settles at the fixed mock price.
contract MockLendingPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Position {
        uint256 collateral;
        uint256 debt;
        bool active;
    }

    /// @notice Fixed mock price: 1 AVAX = 20 mUSDC, scaled to 1e18.
    uint256 public constant AVAX_PRICE_USD = 20e18;

    uint256 public liquidationThresholdBps = 8000;
    address public governance;

    IERC20 public immutable mUSDC;

    mapping(address => Position) public positions;
    mapping(address => mapping(address => bool)) public exitAgents;

    error InsufficientCollateral();
    error NotExitAgent();
    error NoPosition();
    error NotGovernance();
    error InvalidThresholdBps();
    error ZeroAddress();

    constructor(address mUSDC_, address initialGovernance) {
        if (mUSDC_ == address(0) || initialGovernance == address(0)) {
            revert ZeroAddress();
        }
        mUSDC = IERC20(mUSDC_);
        governance = initialGovernance;
    }

    function openPosition(uint256 borrowAmount) external payable nonReentrant {
        Position storage position = positions[msg.sender];

        uint256 newCollateral = position.collateral + msg.value;
        uint256 newDebt = position.debt + borrowAmount;
        // A Position must hold Collateral; this also blocks a zero-value, zero-debt open.
        if (newCollateral == 0) {
            revert InsufficientCollateral();
        }
        // Multiply before dividing: collateralValue * threshold, all in one ratio.
        uint256 debtCeiling =
            (newCollateral * AVAX_PRICE_USD * liquidationThresholdBps) / (1e18 * 10_000);
        if (newDebt > debtCeiling) {
            revert InsufficientCollateral();
        }

        position.collateral = newCollateral;
        position.debt = newDebt;
        position.active = true;

        mUSDC.safeTransfer(msg.sender, borrowAmount);
    }

    function closePosition() external nonReentrant {
        _close(msg.sender);
    }

    function closePositionFor(address user) external nonReentrant {
        if (!exitAgents[user][msg.sender]) {
            revert NotExitAgent();
        }
        _close(user);
    }

    function approveExitAgent(address agent, bool approved) external {
        exitAgents[msg.sender][agent] = approved;
    }

    function setLiquidationThreshold(uint256 thresholdBps) external {
        if (msg.sender != governance) {
            revert NotGovernance();
        }
        if (thresholdBps == 0 || thresholdBps > 10_000) {
            revert InvalidThresholdBps();
        }
        liquidationThresholdBps = thresholdBps;
    }

    function setGovernance(address newGovernance) external {
        if (msg.sender != governance) {
            revert NotGovernance();
        }
        if (newGovernance == address(0)) {
            revert ZeroAddress();
        }
        governance = newGovernance;
    }

    /// @notice Aave-style health factor scaled to 1e18: weighted Collateral value
    ///         divided by Debt. `>= 1e18` is solvent; `type(uint256).max` when Debt is 0.
    function healthFactor(address user) external view returns (uint256) {
        Position storage position = positions[user];
        if (position.debt == 0) {
            return type(uint256).max;
        }
        return (position.collateral * AVAX_PRICE_USD * liquidationThresholdBps * 1e18)
            / (1e18 * 10_000 * position.debt);
    }

    /// @dev Single settle path shared by both close entry points. Checks, then
    ///      effects, then the AVAX send last. `avaxOut` is the Collateral retained
    ///      against Debt at the fixed price; the remainder returns to `user`.
    function _close(address user) private {
        Position storage position = positions[user];
        if (!position.active) {
            revert NoPosition();
        }

        uint256 collateralValue = (position.collateral * AVAX_PRICE_USD) / 1e18;
        if (position.debt > collateralValue) {
            revert InsufficientCollateral();
        }

        uint256 avaxOut = (position.debt * 1e18) / AVAX_PRICE_USD;
        uint256 remainder = position.collateral - avaxOut;

        position.collateral = 0;
        position.debt = 0;
        position.active = false;

        (bool sent,) = payable(user).call{value: remainder}("");
        require(sent, "AVAX transfer failed");
    }
}
