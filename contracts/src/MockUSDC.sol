// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock 18-decimal stablecoin for the GovExit demo.
/// @dev `mint` is intentionally open for Fuji testnet convenience. Never deploy
///      this to a network where the token has value.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USD Coin", "mUSDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
