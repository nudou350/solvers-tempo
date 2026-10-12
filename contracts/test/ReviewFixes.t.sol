// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {SolversTestBase} from "./utils/SolversTestBase.sol";
import {SolversRegistry} from "../src/SolversRegistry.sol";
import {ITIP403ReceivePolicies} from "../src/interfaces/ISolversSatellites.sol";
import {SaleKind} from "../src/SolversTypes.sol";
import {WiringStub} from "./Registry.t.sol";

/// @notice Regression tests for the phase-2 review findings: purchase ids scoped by payer, satellite wiring checks,
/// TIP-20 addresses rejected as treasury, and the fail-closed receive-policy check.
contract ReviewFixesTest is SolversTestBase {
    address internal constant TIP403 = 0x403c000000000000000000000000000000000000;

    function _ref(SaleKind kind, uint256 ref) internal pure returns (bytes32) {
        return bytes32((uint256(uint8(kind)) << 248) | ref);
    }

    /// A third party who learns a purchase id (e.g. derived from a Pix charge) cannot burn it: the platform's
    /// fulfilment with the same id still succeeds, because ids are scoped by payer.
    function test_purchaseId_cannotBeGriefedByAnotherPayer() public {
        _registerActive(creator, AGENT);
        bytes32 pixPid = keccak256("solvers:v1:mp-123456");

        vm.startPrank(stranger);
        usd.approve(address(license), PRICE);
        license.purchaseLicense(AGENT, PRICE, pixPid); // the attacker pays for their own license with the known id
        vm.stopPrank();

        vm.startPrank(platform);
        usd.approve(address(license), PRICE);
        uint256 tokenId = license.purchaseLicenseFor(buyer, AGENT, PRICE, pixPid);
        vm.stopPrank();
        assertEq(license.ownerOf(tokenId), buyer);
        assertEq(registry.purchaseRef(platform, pixPid), _ref(SaleKind.License, tokenId));
        assertEq(registry.purchaseRef(stranger, pixPid), _ref(SaleKind.License, 1));
    }

    function test_setSatellites_rejectsMiswiredSatellites() public {
        SolversRegistry r = SolversRegistry(
            address(
                new ERC1967Proxy(
                    address(new SolversRegistry()),
                    abi.encodeCall(
                        SolversRegistry.initialize,
                        (admin, 0, address(token), treasury, FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE)
                    )
                )
            )
        );
        address good = address(new WiringStub(address(r), address(token)));
        address otherRegistry = address(new WiringStub(address(registry), address(token)));
        address otherToken = address(new WiringStub(address(r), makeAddr("other-token")));

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.SatelliteMismatch.selector, otherRegistry));
        r.setSatellites(good, good, good, good, otherRegistry);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.SatelliteMismatch.selector, otherToken));
        r.setSatellites(otherToken, good, good, good, good);
        r.setSatellites(good, good, good, good, good);
        vm.stopPrank();
    }

    function test_treasury_cannotBeATip20Address() public {
        address tip20Like = 0x20C0000000000000000000000000000000000001; // AlphaUSD
        vm.prank(admin);
        vm.expectRevert(SolversRegistry.InvalidTreasury.selector);
        registry.setConfig(tip20Like, FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE);
        vm.prank(admin);
        vm.expectRevert(SolversRegistry.InvalidTreasury.selector);
        registry.setConfig(address(token), FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE);
    }

    /// If the TIP-403 registry answers unexpectedly, payouts are deferred (claimable) instead of risking a redirect.
    function test_receivePolicyCheck_failsClosed() public {
        _registerActive(creator, AGENT);
        vm.mockCall(TIP403, abi.encodeWithSelector(ITIP403ReceivePolicies.validateReceivePolicy.selector), hex"01");
        uint256 c0 = _bal(creator);
        _buy(buyer, AGENT);
        vm.clearMockedCalls();
        assertEq(_bal(creator), c0, "creator share not pushed");
        assertEq(license.deferredOf(creator), 9_000_000, "creator share deferred");
        assertEq(license.deferredOf(treasury), 1_000_000, "fee deferred");
        vm.prank(creator);
        license.claim();
        assertEq(_bal(creator) - c0, 9_000_000);
    }
}
