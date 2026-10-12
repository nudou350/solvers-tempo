// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {IERC1967} from "@openzeppelin/contracts/interfaces/IERC1967.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {RegistryHelpers, Decimals18Token} from "./Registry.t.sol";
import {SolversRegistry} from "../src/SolversRegistry.sol";
import {SolversLicense} from "../src/SolversLicense.sol";
import {SolversCredits} from "../src/SolversCredits.sol";
import {SolversReviews} from "../src/SolversReviews.sol";
import {SolversEscrow} from "../src/SolversEscrow.sol";
import {SolversStaking} from "../src/SolversStaking.sol";
import {PAUSE_ENTRIES, PAUSE_PAYMENTS, VERIFIER_ROLE} from "../src/SolversTypes.sol";

interface IVersioned {
    function version() external pure returns (uint256);
}

contract SolversRegistryV2 is SolversRegistry {
    event MigratedV2();

    function version() external pure returns (uint256) {
        return 2;
    }

    function initializeV2() external reinitializer(2) {
        emit MigratedV2();
    }
}

contract SolversLicenseV2 is SolversLicense {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract SolversCreditsV2 is SolversCredits {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract SolversReviewsV2 is SolversReviews {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract SolversEscrowV2 is SolversEscrow {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract SolversStakingV2 is SolversStaking {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract UpgradeTest is RegistryHelpers {
    address internal newAdmin = makeAddr("newAdmin");
    uint256 internal tokenId;
    uint256 internal escrowId;

    function setUp() public override {
        super.setUp();
        _registerActive(creator, AGENT);
        tokenId = _buy(buyer, AGENT);
        _buyCredits(buyer2, AGENT, 5);
        escrowId = _createEscrow(buyer, AGENT, 3);
        vm.prank(buyer);
        reviews.submitReview(AGENT, uint64(tokenId), 4, keccak256("ok"));
        vm.prank(platform);
        credits.recordUsageBatch(AGENT, 9, keccak256("root"));
    }

    function _proxies() internal view returns (address[6] memory) {
        return
            [address(registry), address(license), address(credits), address(reviews), address(escrow), address(staking)];
    }

    function _newImpls() internal returns (address[6] memory) {
        return [
            address(new SolversRegistryV2()),
            address(new SolversLicenseV2()),
            address(new SolversCreditsV2()),
            address(new SolversReviewsV2()),
            address(new SolversEscrowV2()),
            address(new SolversStakingV2())
        ];
    }

    function _impl(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    function _assertStatePreserved() internal view {
        assertEq(registry.agentCount(), 1);
        assertEq(registry.getAgent(AGENT).creator, creator);
        assertEq(registry.getAgent(AGENT).totalSales, 1);
        assertTrue(registry.defaultAdmin() == admin || registry.defaultAdmin() == newAdmin);
        assertEq(license.ownerOf(tokenId), buyer);
        assertEq(license.totalMinted(), 1);
        (uint32 remaining, uint32 purchased) = credits.creditsOf(AGENT, buyer2);
        assertEq(remaining, 5);
        assertEq(purchased, 5);
        assertEq(credits.verifiedUsesOf(AGENT), 9);
        (uint64 sum, uint32 count) = reviews.ratingOf(AGENT);
        assertEq(sum, 4);
        assertEq(count, 1);
        assertEq(escrow.escrowCount(), 1);
        assertEq(escrow.lockedBalance(), 3 * uint256(MS_AMOUNT));
        assertEq(staking.totalStaked(), MIN_STAKE);
        assertEq(address(license.registry()), address(registry));
        assertEq(address(staking.paymentToken()), address(token));
    }

    // =====================================================================================================
    // UUPS
    // =====================================================================================================

    function test_upgrade_byDefaultAdmin_allSix() public {
        address[6] memory proxies = _proxies();
        address[6] memory impls = _newImpls();
        for (uint256 i; i < 6; ++i) {
            address oldImpl = _impl(proxies[i]);
            vm.expectEmit(proxies[i]);
            emit IERC1967.Upgraded(impls[i]);
            vm.prank(admin);
            UUPSUpgradeable(proxies[i]).upgradeToAndCall(impls[i], "");
            assertEq(_impl(proxies[i]), impls[i]);
            assertTrue(oldImpl != impls[i]);
            assertEq(IVersioned(proxies[i]).version(), 2);
        }
        _assertStatePreserved();
        // the upgraded system keeps working end to end
        _buy(buyer2, AGENT);
        vm.prank(buyer);
        escrow.releaseMilestone(escrowId, 0);
        assertEq(registry.getAgent(AGENT).totalSales, 2);
    }

    function test_upgrade_byAnyoneElseReverts() public {
        address[6] memory proxies = _proxies();
        address[6] memory impls = _newImpls();
        address[5] memory callers = [stranger, guardian, platform, verifier, creator];
        for (uint256 i; i < 6; ++i) {
            address before = _impl(proxies[i]);
            for (uint256 j; j < callers.length; ++j) {
                vm.prank(callers[j]);
                vm.expectRevert(_unauthorized(callers[j], 0x00));
                UUPSUpgradeable(proxies[i]).upgradeToAndCall(impls[i], "");
            }
            assertEq(_impl(proxies[i]), before);
        }
        // a satellite cannot upgrade the Registry either
        vm.prank(address(license));
        vm.expectRevert(_unauthorized(address(license), 0x00));
        UUPSUpgradeable(address(registry)).upgradeToAndCall(impls[0], "");
    }

    function test_upgrade_withReinitializerMigration() public {
        address impl = address(new SolversRegistryV2());
        vm.expectEmit(address(registry));
        emit SolversRegistryV2.MigratedV2();
        vm.prank(admin);
        registry.upgradeToAndCall(impl, abi.encodeCall(SolversRegistryV2.initializeV2, ()));
        assertEq(IVersioned(address(registry)).version(), 2);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        SolversRegistryV2(address(registry)).initializeV2();
        _assertStatePreserved();
    }

    function test_upgrade_rejectsNonUUPSImplementation() public {
        address bad = address(new Decimals18Token());
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ERC1967Utils.ERC1967InvalidImplementation.selector, bad));
        registry.upgradeToAndCall(bad, "");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ERC1967Utils.ERC1967InvalidImplementation.selector, bad));
        license.upgradeToAndCall(bad, "");
    }

    function test_upgrade_implementationCannotBeCalledDirectly() public {
        address implR = _impl(address(registry));
        address implL = _impl(address(license));
        address v2 = address(new SolversRegistryV2());
        address v2l = address(new SolversLicenseV2());
        vm.prank(admin);
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        UUPSUpgradeable(implR).upgradeToAndCall(v2, "");
        vm.prank(admin);
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        UUPSUpgradeable(implL).upgradeToAndCall(v2l, "");
    }

    // =====================================================================================================
    // 2-step default admin transfer (AccessControlDefaultAdminRules)
    // =====================================================================================================

    function _transferAdmin() internal {
        vm.prank(admin);
        registry.beginDefaultAdminTransfer(newAdmin);
        (address pending, uint48 schedule) = registry.pendingDefaultAdmin();
        assertEq(pending, newAdmin);
        assertEq(schedule, block.timestamp); // delay 0 at bootstrap
        vm.warp(block.timestamp + 1);
        vm.prank(newAdmin);
        registry.acceptDefaultAdminTransfer();
    }

    function test_adminTransfer_movesUpgradeAndSatelliteRights() public {
        _transferAdmin();
        assertEq(registry.defaultAdmin(), newAdmin);
        assertTrue(registry.hasRole(0x00, newAdmin));
        assertFalse(registry.hasRole(0x00, admin));
        assertEq(registry.owner(), newAdmin);

        // upgrade rights on all six proxies
        address[6] memory proxies = _proxies();
        address[6] memory impls = _newImpls();
        for (uint256 i; i < 6; ++i) {
            vm.prank(admin);
            vm.expectRevert(_unauthorized(admin, 0x00));
            UUPSUpgradeable(proxies[i]).upgradeToAndCall(impls[i], "");
            vm.prank(newAdmin);
            UUPSUpgradeable(proxies[i]).upgradeToAndCall(impls[i], "");
            assertEq(IVersioned(proxies[i]).version(), 2);
        }

        // Registry admin functions
        vm.prank(admin);
        vm.expectRevert(_unauthorized(admin, 0x00));
        registry.setConfig(treasury, 0, 0, 0, 1);
        vm.prank(newAdmin);
        registry.setPause(PAUSE_PAYMENTS);
        vm.prank(newAdmin);
        registry.setPause(0);
        vm.prank(newAdmin);
        registry.grantRole(VERIFIER_ROLE, stranger);
        assertTrue(registry.hasRole(VERIFIER_ROLE, stranger));

        // satellite admin functions follow the Registry's default admin
        vm.prank(admin);
        vm.expectRevert(_unauthorized(admin, 0x00));
        license.setBaseURI("x");
        vm.prank(newAdmin);
        license.setBaseURI("https://new/");

        vm.prank(buyer);
        escrow.openDispute(escrowId, 0, keccak256("r"));
        vm.prank(admin);
        vm.expectRevert(_unauthorized(admin, 0x00));
        escrow.resolveDispute(escrowId, 0, true);
        vm.prank(newAdmin);
        escrow.resolveDispute(escrowId, 0, true);

        vm.prank(admin);
        vm.expectRevert(_unauthorized(admin, 0x00));
        staking.proposeSlash(AGENT, 1, bytes32(0));
        vm.prank(newAdmin);
        staking.proposeSlash(AGENT, 1, bytes32(0));
        vm.prank(newAdmin);
        staking.cancelSlash(AGENT);

        vm.prank(stranger);
        usd.transfer(address(credits), 10);
        vm.prank(admin);
        vm.expectRevert(_unauthorized(admin, 0x00));
        credits.sweepStray(admin);
        vm.prank(newAdmin);
        credits.sweepStray(newAdmin);
    }

    function test_adminTransfer_acceptBeforeScheduleReverts() public {
        vm.prank(admin);
        registry.beginDefaultAdminTransfer(newAdmin);
        (, uint48 schedule) = registry.pendingDefaultAdmin();
        vm.prank(newAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminDelay.selector, schedule
            )
        );
        registry.acceptDefaultAdminTransfer();
        // only the pending admin may accept
        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, stranger)
        );
        registry.acceptDefaultAdminTransfer();
        assertEq(registry.defaultAdmin(), admin);
    }

    function test_adminTransfer_cancel() public {
        vm.prank(admin);
        registry.beginDefaultAdminTransfer(newAdmin);
        vm.prank(admin);
        registry.cancelDefaultAdminTransfer();
        (address pending,) = registry.pendingDefaultAdmin();
        assertEq(pending, address(0));
        vm.warp(block.timestamp + 1);
        vm.prank(newAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, newAdmin)
        );
        registry.acceptDefaultAdminTransfer();
        assertEq(registry.defaultAdmin(), admin);
    }

    function test_changeDefaultAdminDelay_thenTransferWaitsTheDelay() public {
        uint48 delay = 48 hours;
        vm.prank(admin);
        registry.changeDefaultAdminDelay(delay);
        (uint48 pendingDelay, uint48 effect) = registry.pendingDefaultAdminDelay();
        assertEq(pendingDelay, delay);
        // an increase takes min(newDelay, 5 days) to apply
        assertEq(effect, block.timestamp + delay);
        assertEq(registry.defaultAdminDelay(), 0);
        vm.warp(uint256(effect) + 1);
        assertEq(registry.defaultAdminDelay(), delay);

        vm.prank(admin);
        registry.beginDefaultAdminTransfer(newAdmin);
        (, uint48 schedule) = registry.pendingDefaultAdmin();
        assertEq(schedule, block.timestamp + delay);
        vm.warp(block.timestamp + delay - 1);
        vm.prank(newAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminDelay.selector, schedule
            )
        );
        registry.acceptDefaultAdminTransfer();
        // the old admin keeps every right while the transfer is pending
        vm.prank(admin);
        registry.setPause(PAUSE_ENTRIES);
        vm.warp(uint256(schedule) + 1);
        vm.prank(newAdmin);
        registry.acceptDefaultAdminTransfer();
        assertEq(registry.defaultAdmin(), newAdmin);
        assertEq(registry.defaultAdminDelay(), delay);
        vm.prank(newAdmin);
        registry.setPause(0);
    }

    function test_rollbackDefaultAdminDelay() public {
        vm.prank(admin);
        registry.changeDefaultAdminDelay(48 hours);
        vm.prank(admin);
        registry.rollbackDefaultAdminDelay();
        (uint48 pendingDelay, uint48 effect) = registry.pendingDefaultAdminDelay();
        assertEq(pendingDelay, 0);
        assertEq(effect, 0);
        vm.warp(block.timestamp + 10 days);
        assertEq(registry.defaultAdminDelay(), 0);
    }

    function test_grantDefaultAdminRoleIsRejected() public {
        vm.prank(admin);
        vm.expectRevert(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminRules.selector);
        registry.grantRole(0x00, newAdmin);
        assertFalse(registry.hasRole(0x00, newAdmin));
        // so a second admin can never upgrade
        address v2 = address(new SolversLicenseV2());
        vm.prank(newAdmin);
        vm.expectRevert(_unauthorized(newAdmin, 0x00));
        license.upgradeToAndCall(v2, "");
    }

    // =====================================================================================================
    // ERC-7201 namespaces
    // =====================================================================================================

    function _ns(string memory id) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint256(keccak256(bytes(id))) - 1)) & ~bytes32(uint256(0xff));
    }

    function _at(bytes32 base, uint256 offset) internal pure returns (bytes32) {
        return bytes32(uint256(base) + offset);
    }

    function test_namespace_registry() public {
        _setPause(PAUSE_ENTRIES | PAUSE_PAYMENTS);
        bytes32 ns = _ns("solvers.storage.Registry");
        uint256 slotA = uint256(vm.load(address(registry), ns));
        assertEq(address(uint160(slotA)), treasury);
        assertEq(uint16(slotA >> 160), FEE_BPS);
        assertEq(uint16(slotA >> 176), PLATFORM_ROYALTY_BPS);
        assertEq(uint8(slotA >> 192), 3);
        uint256 slotB = uint256(vm.load(address(registry), _at(ns, 1)));
        assertEq(uint96(slotB), MIN_STAKE);
        assertEq(uint96(slotB >> 96), MIN_PRICE);
        assertEq(address(uint160(uint256(vm.load(address(registry), _at(ns, 2))))), address(token));
        assertEq(address(uint160(uint256(vm.load(address(registry), _at(ns, 3))))), address(license));
        assertEq(address(uint160(uint256(vm.load(address(registry), _at(ns, 7))))), address(staking));
    }

    function test_namespace_license() public view {
        bytes32 ns = _ns("solvers.storage.License");
        assertEq(uint256(vm.load(address(license), ns)), 1); // nextId
    }

    function test_namespace_credits() public view {
        bytes32 ns = _ns("solvers.storage.Credits");
        // verifiedUses[AGENT] lives at keccak(AGENT, ns + 1)
        bytes32 slot = keccak256(abi.encode(AGENT, _at(ns, 1)));
        assertEq(uint256(vm.load(address(credits), slot)), 9);
        // credits[AGENT][buyer2] = {remaining: 5, purchased: 5}
        bytes32 inner = keccak256(abi.encode(AGENT, ns));
        uint256 c = uint256(vm.load(address(credits), keccak256(abi.encode(buyer2, inner))));
        assertEq(uint32(c), 5);
        assertEq(uint32(c >> 32), 5);
    }

    function test_namespace_reviews() public view {
        bytes32 ns = _ns("solvers.storage.Reviews");
        assertEq(address(uint160(uint256(vm.load(address(reviews), ns)))), address(license));
        // slot 1 packs `credits` (20 bytes) with `nextReviewId` (uint64) right after it
        uint256 slot1 = uint256(vm.load(address(reviews), _at(ns, 1)));
        assertEq(address(uint160(slot1)), address(credits));
        assertEq(uint64(slot1 >> 160), 1); // nextReviewId
    }

    function test_namespace_escrow() public view {
        bytes32 ns = _ns("solvers.storage.Escrow");
        assertEq(uint256(vm.load(address(escrow), ns)), 1); // nextId
        assertEq(uint256(vm.load(address(escrow), _at(ns, 1))), 3 * uint256(MS_AMOUNT)); // totalLocked
    }

    function test_namespace_staking() public view {
        bytes32 ns = _ns("solvers.storage.Staking");
        assertEq(uint256(vm.load(address(staking), ns)), MIN_STAKE); // totalStaked
    }

    function test_namespace_satelliteBase() public view {
        bytes32 ns = _ns("solvers.storage.Satellite");
        address[5] memory sats =
            [address(license), address(credits), address(reviews), address(escrow), address(staking)];
        for (uint256 i; i < sats.length; ++i) {
            assertEq(address(uint160(uint256(vm.load(sats[i], ns)))), address(registry));
            assertEq(address(uint160(uint256(vm.load(sats[i], _at(ns, 1))))), address(token));
        }
    }

    function test_namespace_payouts() public {
        uint64 pid = _blacklistPid(creator);
        _buy(buyer2, AGENT);
        _unblacklist(pid, creator);
        uint256 owed = license.deferredOf(creator);
        assertGt(owed, 0);
        bytes32 ns = _ns("solvers.storage.Payouts");
        assertEq(uint256(vm.load(address(license), keccak256(abi.encode(creator, ns)))), owed); // deferred[creator]
        assertEq(uint256(vm.load(address(license), _at(ns, 1))), owed); // totalDeferred
    }

    function test_namespace_noCollisions() public pure {
        bytes32[12] memory slots = [
            _ns("solvers.storage.Registry"),
            _ns("solvers.storage.License"),
            _ns("solvers.storage.Credits"),
            _ns("solvers.storage.Reviews"),
            _ns("solvers.storage.Escrow"),
            _ns("solvers.storage.Staking"),
            _ns("solvers.storage.Satellite"),
            _ns("solvers.storage.Payouts"),
            _ns("openzeppelin.storage.AccessControl"),
            _ns("openzeppelin.storage.AccessControlDefaultAdminRules"),
            _ns("openzeppelin.storage.ERC721"),
            _ns("openzeppelin.storage.Initializable")
        ];
        for (uint256 i; i < slots.length; ++i) {
            // each namespace keeps at least 256 slots of room before the next one
            for (uint256 j = i + 1; j < slots.length; ++j) {
                uint256 a = uint256(slots[i]);
                uint256 b = uint256(slots[j]);
                assertGt(a > b ? a - b : b - a, 255);
            }
        }
    }
}
