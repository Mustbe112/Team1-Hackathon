// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// Minimal real OZ v5 consumer: proves the dependency artifact resolves and the
/// contract compiles under the project's pinned toolchain.
contract OwnableProbe is Ownable {
    constructor(address initialOwner) Ownable(initialOwner) {}
}

contract ToolchainTest is Test {
    function test_OpenZeppelinV5IsImportable() public {
        address owner = makeAddr("owner");
        OwnableProbe probe = new OwnableProbe(owner);
        assertEq(probe.owner(), owner);
    }
}
