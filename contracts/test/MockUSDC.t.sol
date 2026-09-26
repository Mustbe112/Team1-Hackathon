// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract MockUSDCTest is Test {
    MockUSDC internal usdc;

    function setUp() public {
        usdc = new MockUSDC();
    }

    function test_MintCreditsAnyCaller() public {
        address anyone = makeAddr("anyone");
        address to = makeAddr("to");

        vm.prank(anyone);
        usdc.mint(to, 130e18);

        assertEq(usdc.balanceOf(to), 130e18);
        assertEq(usdc.totalSupply(), 130e18);
    }

    function test_DecimalsIs18() public view {
        assertEq(usdc.decimals(), 18);
    }

    function test_Metadata() public view {
        assertEq(usdc.name(), "Mock USD Coin");
        assertEq(usdc.symbol(), "mUSDC");
    }
}
