// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";

import {SolversRegistry} from "../src/SolversRegistry.sol";

/// @notice Second step of the admin handover, signed by the COLD admin: accepts DEFAULT_ADMIN_ROLE and then raises the
/// admin-transfer delay (default 48 h) so any future handover is visible on-chain before it can complete.
///
/// Env: REGISTRY; optional ADMIN_DELAY_SECS (172800).
///   forge script script/AcceptAdmin.s.sol --rpc-url moderato --broadcast --private-key $ADMIN_PRIVATE_KEY
contract AcceptAdmin is Script {
    function run() external {
        SolversRegistry registry = SolversRegistry(vm.envAddress("REGISTRY"));
        uint48 delay = uint48(vm.envOr("ADMIN_DELAY_SECS", uint256(48 hours)));
        vm.startBroadcast();
        registry.acceptDefaultAdminTransfer();
        registry.changeDefaultAdminDelay(delay);
        vm.stopBroadcast();
        console.log("default admin:", registry.defaultAdmin());
    }
}
