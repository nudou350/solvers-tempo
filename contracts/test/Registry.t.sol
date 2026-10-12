// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {ITIP403Registry} from "tempo-std/interfaces/ITIP403Registry.sol";
import {StdPrecompiles} from "tempo-std/StdPrecompiles.sol";

import {Vm} from "forge-std/Vm.sol";

import {SolversTestBase} from "./utils/SolversTestBase.sol";
import {SolversRegistry} from "../src/SolversRegistry.sol";
import {SolversLicense} from "../src/SolversLicense.sol";
import {SolversCredits} from "../src/SolversCredits.sol";
import {SolversReviews} from "../src/SolversReviews.sol";
import {SolversEscrow} from "../src/SolversEscrow.sol";
import {SolversStaking} from "../src/SolversStaking.sol";
import {AgentRegistration, AgentView, Eval, Reputation, SaleAuth} from "../src/interfaces/ISolversRegistry.sol";
import {
    AgentStatus,
    SaleKind,
    PLATFORM_ROLE,
    VERIFIER_ROLE,
    USAGE_ROLE,
    GUARDIAN_ROLE,
    PAUSE_ENTRIES,
    PAUSE_PAYMENTS,
    PAUSE_TRANSFERS,
    AgentNotFound,
    NotCreator,
    InvalidAmount,
    ZeroAddress,
    Paused,
    NotSatellite,
    PriceTooLow,
    PriceChanged
} from "../src/SolversTypes.sol";

/// @dev ERC-20 metadata stub reporting 18 decimals (initialize must reject it).
contract Decimals18Token {
    function decimals() external pure returns (uint8) {
        return 18;
    }
}

/// @dev Token whose `decimals()` reverts.
contract RevertingDecimalsToken {
    function decimals() external pure returns (uint8) {
        revert("no decimals");
    }
}

/// @notice Helpers shared by the Registry suites (Registry*, Upgrade).
abstract contract RegistryHelpers is SolversTestBase {
    uint96 internal constant MS_AMOUNT = 2_000_000;
    uint32 internal constant WINDOW = 3600;

    function _ms(uint256 n, uint96 each) internal pure returns (SolversEscrow.MilestoneInput[] memory ms) {
        ms = new SolversEscrow.MilestoneInput[](n);
        for (uint256 i; i < n; ++i) {
            ms[i] = SolversEscrow.MilestoneInput({amount: each, criteriaHash: keccak256(abi.encode("criteria", i))});
        }
    }

    function _createEscrow(address who, bytes32 agentId, uint256 n) internal returns (uint256 escrowId) {
        vm.startPrank(who);
        usd.approve(address(escrow), uint256(MS_AMOUNT) * n);
        escrowId = escrow.createEscrow(agentId, _ms(n, MS_AMOUNT), WINDOW, 0, _pid());
        vm.stopPrank();
    }

    function _buyCredits(address who, bytes32 agentId, uint32 amount) internal {
        vm.startPrank(who);
        usd.approve(address(credits), uint256(PRICE_PER_USE) * amount);
        credits.buyCredits(agentId, amount, uint256(PRICE_PER_USE) * amount, _pid());
        vm.stopPrank();
    }

    function _setPause(uint8 flags) internal {
        vm.prank(admin);
        registry.setPause(flags);
    }

    function _setConfig(uint16 feeBps, uint16 platformBps, uint96 minStake_, uint96 minPrice_) internal {
        vm.prank(admin);
        registry.setConfig(treasury, feeBps, platformBps, minStake_, minPrice_);
    }

    /// @dev Token-level TIP-403 blacklist that can be lifted again (`_unblacklist`).
    function _blacklistPid(address account) internal returns (uint64 pid) {
        pid = StdPrecompiles.TIP403_REGISTRY.createPolicy(address(this), ITIP403Registry.PolicyType.BLACKLIST);
        StdPrecompiles.TIP403_REGISTRY.modifyPolicyBlacklist(pid, account, true);
        token.changeTransferPolicyId(pid);
    }

    function _unblacklist(uint64 pid, address account) internal {
        StdPrecompiles.TIP403_REGISTRY.modifyPolicyBlacklist(pid, account, false);
    }

    /// @dev Partially slashes `agentId` (amount `amt`) through Staking: propose, wait 72 h, execute.
    function _slash(bytes32 agentId, uint96 amt) internal {
        vm.prank(admin);
        staking.proposeSlash(agentId, amt, keccak256("reason"));
        vm.warp(block.timestamp + staking.SLASH_DELAY());
        vm.prank(admin);
        staking.executeSlash(agentId);
    }

    function _unauthorized(address account, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, account, role);
    }

    function _ref(SaleKind kind, uint256 ref) internal pure returns (bytes32) {
        return bytes32((uint256(uint8(kind)) << 248) | ref);
    }

    function _str(uint256 len) internal pure returns (string memory s) {
        bytes memory b = new bytes(len);
        for (uint256 i; i < len; ++i) {
            b[i] = "a";
        }
        s = string(b);
    }
}

contract RegistryTest is RegistryHelpers {
    // =====================================================================================================
    // 1. initialize
    // =====================================================================================================

    function _initData(
        address token_,
        address treasury_,
        uint16 fee,
        uint16 royalty,
        uint96 minStake_,
        uint96 minPrice_
    ) internal view returns (bytes memory) {
        return abi.encodeCall(
            SolversRegistry.initialize, (admin, 3 days, token_, treasury_, fee, royalty, minStake_, minPrice_)
        );
    }

    function test_initialize_storesParameters() public {
        address impl = address(new SolversRegistry());
        vm.expectEmit(true, true, true, true);
        emit SolversRegistry.ConfigUpdated(treasury, 1234, 777, 42, 5_000_001);
        SolversRegistry r = SolversRegistry(
            address(new ERC1967Proxy(impl, _initData(address(token), treasury, 1234, 777, 42, 5_000_001)))
        );
        (address t, uint16 fee, uint16 royalty, uint8 flags, uint96 minStake_, uint96 minPrice_) = r.config();
        assertEq(t, treasury);
        assertEq(fee, 1234);
        assertEq(royalty, 777);
        assertEq(flags, 0);
        assertEq(minStake_, 42);
        assertEq(minPrice_, 5_000_001);
        assertEq(r.token(), address(token));
        assertEq(r.treasury(), treasury);
        assertEq(r.minStake(), 42);
        assertEq(r.minPrice(), 5_000_001);
        assertEq(r.pauseFlags(), 0);
        assertEq(r.defaultAdmin(), admin);
        assertTrue(r.hasRole(r.DEFAULT_ADMIN_ROLE(), admin));
        assertEq(r.defaultAdminDelay(), 3 days);
        assertEq(r.agentCount(), 0);
        (address l, address c, address rv, address e, address s) = r.satellites();
        assertEq(l, address(0));
        assertEq(c, address(0));
        assertEq(rv, address(0));
        assertEq(e, address(0));
        assertEq(s, address(0));
    }

    function test_initialize_rejects18DecimalsToken() public {
        address bad = address(new Decimals18Token());
        address impl = address(new SolversRegistry());
        bytes memory data = _initData(bad, treasury, FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE);
        vm.expectRevert(SolversRegistry.BadToken.selector);
        new ERC1967Proxy(impl, data);
    }

    function test_initialize_rejectsTokenWhoseDecimalsReverts() public {
        address bad = address(new RevertingDecimalsToken());
        address impl = address(new SolversRegistry());
        bytes memory data = _initData(bad, treasury, FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE);
        vm.expectRevert(SolversRegistry.BadToken.selector);
        new ERC1967Proxy(impl, data);
    }

    // BUG? `initialize` wraps `decimals()` in try/catch, but for an address without code the call succeeds with
    // empty return data and the ABI decoding failure is NOT caught by `catch` (Solidity semantics): the
    // initialization reverts with empty data instead of `BadToken` (the ERC1967Proxy constructor then surfaces it as
    // `FailedCall()`). The deployment still fails (safe), but the error is not the documented one.
    // Fix: `if (token_.code.length == 0) revert BadToken();` before the try.
    function test_initialize_rejectsAddressWithoutCode() public {
        address eoa = makeAddr("not-a-token");
        address impl = address(new SolversRegistry());
        bytes memory data = _initData(eoa, treasury, FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE);
        vm.expectRevert(SolversRegistry.BadToken.selector);
        new ERC1967Proxy(impl, data);
    }

    function test_initialize_rejectsZeroToken() public {
        address impl = address(new SolversRegistry());
        bytes memory data = _initData(address(0), treasury, FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE);
        vm.expectRevert(ZeroAddress.selector);
        new ERC1967Proxy(impl, data);
    }

    function test_initialize_rejectsZeroAdmin() public {
        address impl = address(new SolversRegistry());
        bytes memory data = abi.encodeCall(
            SolversRegistry.initialize,
            (address(0), 0, address(token), treasury, FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE)
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, address(0)
            )
        );
        new ERC1967Proxy(impl, data);
    }

    function test_initialize_rejectsZeroTreasury() public {
        address impl = address(new SolversRegistry());
        bytes memory data = _initData(address(token), address(0), FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE);
        vm.expectRevert(SolversRegistry.InvalidTreasury.selector);
        new ERC1967Proxy(impl, data);
    }

    function test_initialize_feeBounds() public {
        address impl = address(new SolversRegistry());
        bytes memory data = _initData(address(token), treasury, 2001, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE);
        vm.expectRevert(SolversRegistry.FeeTooHigh.selector);
        new ERC1967Proxy(impl, data);
        // 2000 is the inclusive cap
        SolversRegistry r =
            SolversRegistry(address(new ERC1967Proxy(impl, _initData(address(token), treasury, 2000, 0, 0, 1))));
        (, uint16 fee,,,,) = r.config();
        assertEq(fee, 2000);
    }

    function test_initialize_royaltyBounds() public {
        address impl = address(new SolversRegistry());
        bytes memory data = _initData(address(token), treasury, FEE_BPS, 2501, MIN_STAKE, MIN_PRICE);
        vm.expectRevert(SolversRegistry.RoyaltyTooHigh.selector);
        new ERC1967Proxy(impl, data);
        SolversRegistry r =
            SolversRegistry(address(new ERC1967Proxy(impl, _initData(address(token), treasury, FEE_BPS, 2500, 0, 1))));
        (,, uint16 royalty,,,) = r.config();
        assertEq(royalty, 2500);
    }

    function test_initialize_rejectsZeroMinPrice() public {
        address impl = address(new SolversRegistry());
        bytes memory data = _initData(address(token), treasury, FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, 0);
        vm.expectRevert(InvalidAmount.selector);
        new ERC1967Proxy(impl, data);
    }

    function test_initialize_cannotRunTwice() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        registry.initialize(stranger, 0, address(token), stranger, 0, 0, 0, 1);
        vm.prank(admin);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        registry.initialize(admin, 0, address(token), treasury, 0, 0, 0, 1);
    }

    function test_initialize_implementationsAreLocked() public {
        SolversRegistry r = new SolversRegistry();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        r.initialize(admin, 0, address(token), treasury, FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE);

        SolversLicense l = new SolversLicense();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        l.initialize(address(registry), "x");

        SolversCredits c = new SolversCredits();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        c.initialize(address(registry));

        SolversReviews rv = new SolversReviews();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        rv.initialize(address(registry), address(license), address(credits));

        SolversEscrow e = new SolversEscrow();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        e.initialize(address(registry));

        SolversStaking s = new SolversStaking();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        s.initialize(address(registry));
    }

    function test_initialize_satellitesCannotRunTwice() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        license.initialize(address(registry), "x");
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        credits.initialize(address(registry));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        reviews.initialize(address(registry), address(license), address(credits));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        escrow.initialize(address(registry));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        staking.initialize(address(registry));
    }

    // =====================================================================================================
    // 2. setSatellites
    // =====================================================================================================

    function _freshRegistry() internal returns (SolversRegistry r) {
        r = SolversRegistry(
            address(
                new ERC1967Proxy(
                    address(new SolversRegistry()),
                    _initData(address(token), treasury, FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE)
                )
            )
        );
    }

    function test_setSatellites_once() public {
        SolversRegistry r = _freshRegistry();
        address[5] memory s;
        for (uint256 i; i < 5; ++i) {
            s[i] = address(new WiringStub(address(r), address(token)));
        }
        vm.expectEmit(address(r));
        emit SolversRegistry.SatellitesSet(s[0], s[1], s[2], s[3], s[4]);
        vm.prank(admin);
        r.setSatellites(s[0], s[1], s[2], s[3], s[4]);
        (address l, address c, address rv, address e, address st) = r.satellites();
        assertEq(l, s[0]);
        assertEq(c, s[1]);
        assertEq(rv, s[2]);
        assertEq(e, s[3]);
        assertEq(st, s[4]);

        vm.prank(admin);
        vm.expectRevert(SolversRegistry.SatellitesAlreadySet.selector);
        r.setSatellites(s[0], s[1], s[2], s[3], s[4]);

        // the wired registry (base setUp) also refuses a second call
        vm.prank(admin);
        vm.expectRevert(SolversRegistry.SatellitesAlreadySet.selector);
        registry.setSatellites(stranger, stranger, stranger, stranger, stranger);
    }

    function test_setSatellites_rejectsZeroAddresses() public {
        SolversRegistry r = _freshRegistry();
        address a = makeAddr("sat");
        address[5] memory s;
        for (uint256 i; i < 5; ++i) {
            for (uint256 j; j < 5; ++j) {
                s[j] = i == j ? address(0) : a;
            }
            vm.prank(admin);
            vm.expectRevert(ZeroAddress.selector);
            r.setSatellites(s[0], s[1], s[2], s[3], s[4]);
        }
        (address l,,,,) = r.satellites();
        assertEq(l, address(0));
    }

    function test_setSatellites_onlyAdmin() public {
        SolversRegistry r = _freshRegistry();
        address a = makeAddr("sat");
        address[3] memory callers = [stranger, guardian, platform];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(_unauthorized(callers[i], 0x00));
            r.setSatellites(a, a, a, a, a);
        }
    }

    function test_registerAgent_beforeSatellitesReverts() public {
        SolversRegistry r = _freshRegistry();
        vm.prank(creator);
        vm.expectRevert(NotSatellite.selector);
        r.registerAgent(_registration(AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS));
    }

    // =====================================================================================================
    // 3. setConfig
    // =====================================================================================================

    function test_setConfig_storesAndEmits() public {
        address t2 = makeAddr("treasury2");
        vm.expectEmit(address(registry));
        emit SolversRegistry.ConfigUpdated(t2, 2000, 2500, 1, 7_000_000);
        vm.prank(admin);
        registry.setConfig(t2, 2000, 2500, 1, 7_000_000);
        (address t, uint16 fee, uint16 royalty, uint8 flags, uint96 minStake_, uint96 minPrice_) = registry.config();
        assertEq(t, t2);
        assertEq(fee, 2000);
        assertEq(royalty, 2500);
        assertEq(flags, 0);
        assertEq(minStake_, 1);
        assertEq(minPrice_, 7_000_000);
    }

    function test_setConfig_validations() public {
        vm.startPrank(admin);
        vm.expectRevert(SolversRegistry.InvalidTreasury.selector);
        registry.setConfig(address(0), FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE);
        vm.expectRevert(SolversRegistry.FeeTooHigh.selector);
        registry.setConfig(treasury, 2001, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE);
        vm.expectRevert(SolversRegistry.FeeTooHigh.selector);
        registry.setConfig(treasury, type(uint16).max, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE);
        vm.expectRevert(SolversRegistry.RoyaltyTooHigh.selector);
        registry.setConfig(treasury, FEE_BPS, 2501, MIN_STAKE, MIN_PRICE);
        vm.expectRevert(InvalidAmount.selector);
        registry.setConfig(treasury, FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, 0);
        // zero fee, zero royalty, zero stake are legal
        registry.setConfig(treasury, 0, 0, 0, 1);
        vm.stopPrank();
        (, uint16 fee, uint16 royalty,, uint96 minStake_, uint96 minPrice_) = registry.config();
        assertEq(fee, 0);
        assertEq(royalty, 0);
        assertEq(minStake_, 0);
        assertEq(minPrice_, 1);
    }

    function test_setConfig_preservesPauseFlags() public {
        _setPause(PAUSE_PAYMENTS);
        _setConfig(100, 100, 1, 1);
        assertEq(registry.pauseFlags(), PAUSE_PAYMENTS);
    }

    function test_setConfig_onlyAdmin() public {
        address[4] memory callers = [stranger, guardian, platform, verifier];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(_unauthorized(callers[i], 0x00));
            registry.setConfig(treasury, FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE);
        }
    }

    function test_setConfig_doesNotTouchExistingAgentsRoyalty() public {
        _register(creator, AGENT, PRICE, PRICE_PER_USE, 2000); // 2000 + 500 = 2500
        _setConfig(FEE_BPS, 2500, MIN_STAKE, MIN_PRICE);
        AgentView memory a = registry.getAgent(AGENT);
        assertEq(a.royaltyBps, 2000);
        // the creator share is kept, the platform share is clamped at read time
        (, uint16 creatorBps,, uint16 platformBps,) = registry.royaltyParams(0);
        assertEq(creatorBps, 2000);
        assertEq(platformBps, 500);
        // and a new registration is checked against the new platform share
        vm.startPrank(creator2);
        usd.approve(address(staking), MIN_STAKE);
        vm.expectRevert(SolversRegistry.RoyaltyTooHigh.selector);
        registry.registerAgent(_registration(AGENT2, PRICE, PRICE_PER_USE, 1));
        registry.registerAgent(_registration(AGENT2, PRICE, PRICE_PER_USE, 0));
        vm.stopPrank();
    }

    // =====================================================================================================
    // 4. setPause authority (effects live in RegistryPause.t.sol)
    // =====================================================================================================

    function test_setPause_adminSetsAndClearsAnyBits() public {
        for (uint8 f; f <= 7; ++f) {
            uint8 old = registry.pauseFlags();
            vm.expectEmit(address(registry));
            emit SolversRegistry.PauseChanged(admin, old, f);
            _setPause(f);
            assertEq(registry.pauseFlags(), f);
        }
        _setPause(0);
        assertEq(registry.pauseFlags(), 0);
        _setPause(PAUSE_TRANSFERS);
        _setPause(PAUSE_ENTRIES);
        assertEq(registry.pauseFlags(), PAUSE_ENTRIES);
    }

    function test_setPause_guardianCanOnlyAdd() public {
        vm.expectEmit(address(registry));
        emit SolversRegistry.PauseChanged(guardian, 0, PAUSE_ENTRIES);
        vm.prank(guardian);
        registry.setPause(PAUSE_ENTRIES);
        vm.prank(guardian);
        registry.setPause(PAUSE_ENTRIES | PAUSE_PAYMENTS);
        assertEq(registry.pauseFlags(), 3);
        // same flags again (no-op) is allowed
        vm.prank(guardian);
        registry.setPause(3);

        vm.prank(guardian);
        vm.expectRevert(SolversRegistry.GuardianCannotUnpause.selector);
        registry.setPause(PAUSE_ENTRIES);
        vm.prank(guardian);
        vm.expectRevert(SolversRegistry.GuardianCannotUnpause.selector);
        registry.setPause(0);
        // swapping bits removes one: rejected
        vm.prank(guardian);
        vm.expectRevert(SolversRegistry.GuardianCannotUnpause.selector);
        registry.setPause(PAUSE_PAYMENTS | PAUSE_TRANSFERS);
        assertEq(registry.pauseFlags(), 3);

        // the admin clears
        _setPause(0);
        assertEq(registry.pauseFlags(), 0);
    }

    function test_setPause_anyGuardianRoleHolder() public {
        address g2 = makeAddr("guardian2");
        vm.prank(admin);
        registry.grantRole(GUARDIAN_ROLE, g2);
        vm.prank(g2);
        registry.setPause(PAUSE_PAYMENTS);
        assertEq(registry.pauseFlags(), PAUSE_PAYMENTS);
        vm.prank(admin);
        registry.revokeRole(GUARDIAN_ROLE, g2);
        vm.prank(g2);
        vm.expectRevert(SolversRegistry.NotPauseAuthority.selector);
        registry.setPause(3);
    }

    function test_setPause_invalidFlags() public {
        for (uint256 f = 8; f <= 255; f += 31) {
            vm.prank(admin);
            vm.expectRevert(SolversRegistry.InvalidPauseFlags.selector);
            registry.setPause(uint8(f));
        }
        vm.prank(admin);
        vm.expectRevert(SolversRegistry.InvalidPauseFlags.selector);
        registry.setPause(255);
        vm.prank(guardian);
        vm.expectRevert(SolversRegistry.InvalidPauseFlags.selector);
        registry.setPause(8);
        vm.prank(stranger);
        vm.expectRevert(SolversRegistry.InvalidPauseFlags.selector);
        registry.setPause(15);
    }

    function test_setPause_notAuthority() public {
        address[4] memory callers = [stranger, platform, verifier, creator];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(SolversRegistry.NotPauseAuthority.selector);
            registry.setPause(PAUSE_ENTRIES);
        }
    }

    // =====================================================================================================
    // 6. registerAgent
    // =====================================================================================================

    function test_registerAgent_storesAndPullsExactStake() public {
        uint256 creatorBefore = _bal(creator);
        uint256 stakingBefore = _bal(address(staking));
        vm.startPrank(creator);
        usd.approve(address(staking), 3 * uint256(MIN_STAKE));
        AgentRegistration memory r = _registration(AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        vm.expectEmit(address(staking));
        emit SolversStaking.StakePulled(AGENT, creator, MIN_STAKE);
        vm.expectEmit(address(registry));
        emit SolversRegistry.AgentRegistered(
            AGENT,
            creator,
            0,
            r.metadataUri,
            r.version,
            VERSION_HASH,
            PRICE,
            PRICE_PER_USE,
            CREATOR_ROYALTY_BPS,
            MIN_STAKE
        );
        registry.registerAgent(r);
        vm.stopPrank();

        assertEq(creatorBefore - _bal(creator), MIN_STAKE);
        assertEq(_bal(address(staking)) - stakingBefore, MIN_STAKE);
        assertEq(usd.allowance(creator, address(staking)), 2 * uint256(MIN_STAKE));
        assertEq(staking.totalStaked(), MIN_STAKE);
        assertEq(registry.stakeOf(AGENT), MIN_STAKE);

        AgentView memory a = registry.getAgent(AGENT);
        assertEq(a.agentId, AGENT);
        assertEq(a.creator, creator);
        assertEq(uint8(a.status), uint8(AgentStatus.Pending));
        assertEq(a.royaltyBps, CREATOR_ROYALTY_BPS);
        assertEq(a.totalSales, 0);
        assertEq(a.maxSupply, 0);
        assertEq(a.price, PRICE);
        assertEq(a.pricePerUse, PRICE_PER_USE);
        assertEq(a.disputesLost, 0);
        assertEq(a.index, 0);
        assertEq(a.stake, MIN_STAKE);
        assertEq(a.registeredAt, block.timestamp);
        assertEq(a.versionAt, block.timestamp);
        assertEq(a.versionHash, VERSION_HASH);
        assertEq(a.version, "1.0.0");
        assertEq(a.metadataUri, "https://api.test/agents/x.json");

        assertEq(registry.agentCount(), 1);
        assertEq(registry.agentIdAt(0), AGENT);
        assertTrue(registry.agentExists(AGENT));
        assertEq(registry.creatorOf(AGENT), creator);
        assertEq(uint8(registry.statusOf(AGENT)), uint8(AgentStatus.Pending));

        // second agent: index increments, stake accumulates
        vm.warp(block.timestamp + 100);
        _register(creator2, AGENT2, MIN_PRICE, 0, 0);
        assertEq(registry.agentCount(), 2);
        assertEq(registry.agentIdAt(1), AGENT2);
        assertEq(registry.getAgent(AGENT2).index, 1);
        assertEq(registry.getAgent(AGENT2).registeredAt, block.timestamp);
        assertEq(staking.totalStaked(), 2 * uint256(MIN_STAKE));
        assertEq(_bal(address(staking)) - stakingBefore, 2 * uint256(MIN_STAKE));
        // the same creator may register several agents
        bytes32 agent3 = bytes32(bytes16(keccak256("agent3")));
        _register(creator, agent3, PRICE, PRICE_PER_USE, 0);
        assertEq(registry.agentIdAt(2), agent3);
        assertEq(registry.getAgent(agent3).index, 2);
    }

    function test_registerAgent_invalidAgentId() public {
        vm.startPrank(creator);
        usd.approve(address(staking), MIN_STAKE);
        vm.expectRevert(SolversRegistry.InvalidAgentId.selector);
        registry.registerAgent(_registration(bytes32(0), PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS));
        vm.stopPrank();
    }

    function test_registerAgent_agentExists() public {
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        vm.startPrank(creator);
        usd.approve(address(staking), MIN_STAKE);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentExists.selector, AGENT));
        registry.registerAgent(_registration(AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS));
        vm.stopPrank();
        vm.startPrank(creator2);
        usd.approve(address(staking), MIN_STAKE);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentExists.selector, AGENT));
        registry.registerAgent(_registration(AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS));
        vm.stopPrank();
        assertEq(registry.agentCount(), 1);
    }

    function test_registerAgent_stringLimits() public {
        vm.startPrank(creator);
        usd.approve(address(staking), 10 * uint256(MIN_STAKE));
        AgentRegistration memory r = _registration(AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        r.metadataUri = _str(201);
        vm.expectRevert(SolversRegistry.StringTooLong.selector);
        registry.registerAgent(r);
        r.metadataUri = "ok";
        r.version = _str(17);
        vm.expectRevert(SolversRegistry.StringTooLong.selector);
        registry.registerAgent(r);
        // exact limits are accepted
        r.metadataUri = _str(200);
        r.version = _str(16);
        registry.registerAgent(r);
        vm.stopPrank();
        AgentView memory a = registry.getAgent(AGENT);
        assertEq(bytes(a.metadataUri).length, 200);
        assertEq(bytes(a.version).length, 16);
    }

    function test_registerAgent_priceRules() public {
        vm.startPrank(creator);
        usd.approve(address(staking), 10 * uint256(MIN_STAKE));
        vm.expectRevert(PriceTooLow.selector);
        registry.registerAgent(_registration(AGENT, MIN_PRICE - 1, 0, CREATOR_ROYALTY_BPS));
        vm.expectRevert(InvalidAmount.selector);
        registry.registerAgent(_registration(AGENT, PRICE, PRICE + 1, CREATOR_ROYALTY_BPS));
        // boundaries: price == minPrice, pricePerUse == price
        registry.registerAgent(_registration(AGENT, MIN_PRICE, MIN_PRICE, CREATOR_ROYALTY_BPS));
        vm.stopPrank();
        assertEq(registry.getAgent(AGENT).price, MIN_PRICE);
        assertEq(registry.getAgent(AGENT).pricePerUse, MIN_PRICE);
    }

    function test_registerAgent_royaltyCap() public {
        vm.startPrank(creator);
        usd.approve(address(staking), 10 * uint256(MIN_STAKE));
        // creator 2001 + platform 500 > 2500
        vm.expectRevert(SolversRegistry.RoyaltyTooHigh.selector);
        registry.registerAgent(_registration(AGENT, PRICE, PRICE_PER_USE, 2001));
        vm.expectRevert(SolversRegistry.RoyaltyTooHigh.selector);
        registry.registerAgent(_registration(AGENT, PRICE, PRICE_PER_USE, type(uint16).max));
        registry.registerAgent(_registration(AGENT, PRICE, PRICE_PER_USE, 2000));
        vm.stopPrank();
        assertEq(registry.getAgent(AGENT).royaltyBps, 2000);
    }

    function test_registerAgent_paused() public {
        _setPause(PAUSE_ENTRIES);
        vm.startPrank(creator);
        usd.approve(address(staking), MIN_STAKE);
        vm.expectRevert(abi.encodeWithSelector(Paused.selector, PAUSE_ENTRIES));
        registry.registerAgent(_registration(AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS));
        vm.stopPrank();
        // other bits do not block registration
        _setPause(PAUSE_PAYMENTS | PAUSE_TRANSFERS);
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        assertTrue(registry.agentExists(AGENT));
    }

    function test_registerAgent_withoutAllowanceReverts() public {
        vm.prank(creator);
        vm.expectRevert();
        registry.registerAgent(_registration(AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS));
        assertFalse(registry.agentExists(AGENT));
        assertEq(registry.agentCount(), 0);
        assertEq(staking.totalStaked(), 0);
    }

    function test_registerAgent_stakeFollowsConfig() public {
        _setConfig(FEE_BPS, PLATFORM_ROYALTY_BPS, 33_000_000, MIN_PRICE);
        uint256 before = _bal(creator);
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        assertEq(before - _bal(creator), 33_000_000);
        assertEq(registry.stakeOf(AGENT), 33_000_000);
        assertEq(staking.totalStaked(), 33_000_000);
    }

    // =====================================================================================================
    // 7. creator updates
    // =====================================================================================================

    function test_updateVersion() public {
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        vm.warp(block.timestamp + 1000);
        bytes32 v2 = keccak256("v2");
        vm.expectEmit(address(registry));
        emit SolversRegistry.AgentVersionUpdated(AGENT, "2.0.0", v2);
        vm.prank(creator);
        registry.updateVersion(AGENT, "2.0.0", v2);
        AgentView memory a = registry.getAgent(AGENT);
        assertEq(a.version, "2.0.0");
        assertEq(a.versionHash, v2);
        assertEq(a.versionAt, block.timestamp);
        assertEq(a.registeredAt, block.timestamp - 1000);

        vm.prank(creator);
        vm.expectRevert(SolversRegistry.StringTooLong.selector);
        registry.updateVersion(AGENT, _str(17), v2);
        vm.prank(creator);
        registry.updateVersion(AGENT, _str(16), v2);

        vm.prank(stranger);
        vm.expectRevert(NotCreator.selector);
        registry.updateVersion(AGENT, "3", v2);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, AGENT2));
        registry.updateVersion(AGENT2, "3", v2);
    }

    function test_updateMetadataUri() public {
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        vm.expectEmit(address(registry));
        emit SolversRegistry.AgentMetadataUpdated(AGENT, "ipfs://new");
        vm.prank(creator);
        registry.updateMetadataUri(AGENT, "ipfs://new");
        assertEq(registry.getAgent(AGENT).metadataUri, "ipfs://new");

        vm.prank(creator);
        vm.expectRevert(SolversRegistry.StringTooLong.selector);
        registry.updateMetadataUri(AGENT, _str(201));
        vm.prank(creator);
        registry.updateMetadataUri(AGENT, _str(200));
        assertEq(bytes(registry.getAgent(AGENT).metadataUri).length, 200);

        vm.prank(creator2);
        vm.expectRevert(NotCreator.selector);
        registry.updateMetadataUri(AGENT, "x");
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, AGENT2));
        registry.updateMetadataUri(AGENT2, "x");
    }

    function test_updatePricing() public {
        _registerActive(creator, AGENT);
        vm.expectEmit(address(registry));
        emit SolversRegistry.PricingUpdated(AGENT, 12_000_000, 0);
        vm.prank(creator);
        registry.updatePricing(AGENT, 12_000_000, 0);
        assertEq(registry.getAgent(AGENT).price, 12_000_000);
        assertEq(registry.getAgent(AGENT).pricePerUse, 0);

        vm.startPrank(creator);
        vm.expectRevert(PriceTooLow.selector);
        registry.updatePricing(AGENT, MIN_PRICE - 1, 0);
        vm.expectRevert(InvalidAmount.selector);
        registry.updatePricing(AGENT, MIN_PRICE, MIN_PRICE + 1);
        registry.updatePricing(AGENT, MIN_PRICE, MIN_PRICE);
        vm.stopPrank();

        vm.prank(stranger);
        vm.expectRevert(NotCreator.selector);
        registry.updatePricing(AGENT, PRICE, 0);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, AGENT2));
        registry.updatePricing(AGENT2, PRICE, 0);

        // a buyer quoting the old price is protected
        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        vm.expectRevert(abi.encodeWithSelector(PriceChanged.selector, uint256(MIN_PRICE)));
        license.purchaseLicense(AGENT, PRICE, _pid());
        vm.stopPrank();
    }

    function test_updatePricing_followsMinPrice() public {
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        _setConfig(FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, 11_000_000);
        vm.prank(creator);
        vm.expectRevert(PriceTooLow.selector);
        registry.updatePricing(AGENT, PRICE, 0);
    }

    function test_setRoyaltyBps() public {
        _registerActive(creator, AGENT);
        vm.expectEmit(address(registry));
        emit SolversRegistry.RoyaltyBpsSet(AGENT, 2000);
        vm.prank(creator);
        registry.setRoyaltyBps(AGENT, 2000);
        assertEq(registry.getAgent(AGENT).royaltyBps, 2000);

        vm.prank(creator);
        vm.expectRevert(SolversRegistry.RoyaltyTooHigh.selector);
        registry.setRoyaltyBps(AGENT, 2001);
        vm.prank(creator);
        registry.setRoyaltyBps(AGENT, 0);
        assertEq(registry.getAgent(AGENT).royaltyBps, 0);

        vm.prank(stranger);
        vm.expectRevert(NotCreator.selector);
        registry.setRoyaltyBps(AGENT, 100);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, AGENT2));
        registry.setRoyaltyBps(AGENT2, 100);

        // locked after the first sale
        _buy(buyer, AGENT);
        vm.prank(creator);
        vm.expectRevert(SolversRegistry.RoyaltyLocked.selector);
        registry.setRoyaltyBps(AGENT, 100);
        vm.prank(creator);
        vm.expectRevert(SolversRegistry.RoyaltyLocked.selector);
        registry.setRoyaltyBps(AGENT, 0);
    }

    function test_setRoyaltyBps_creditsDoNotLock() public {
        _registerActive(creator, AGENT);
        _buyCredits(buyer, AGENT, 5);
        vm.prank(creator);
        registry.setRoyaltyBps(AGENT, 1000);
        assertEq(registry.getAgent(AGENT).royaltyBps, 1000);
    }

    function test_setSupplyCap_fromUnlimited() public {
        _registerActive(creator, AGENT);
        vm.prank(creator);
        vm.expectRevert(SolversRegistry.SupplyCapTooLow.selector);
        registry.setSupplyCap(AGENT, 0);

        _buy(buyer, AGENT);
        _buy(buyer2, AGENT);
        assertEq(registry.getAgent(AGENT).totalSales, 2);
        vm.prank(creator);
        vm.expectRevert(SolversRegistry.SupplyCapTooLow.selector);
        registry.setSupplyCap(AGENT, 1);

        // == totalSales is allowed and sells out immediately
        vm.expectEmit(address(registry));
        emit SolversRegistry.SupplyCapSet(AGENT, 2);
        vm.prank(creator);
        registry.setSupplyCap(AGENT, 2);
        assertEq(registry.getAgent(AGENT).maxSupply, 2);

        vm.startPrank(stranger);
        usd.approve(address(license), PRICE);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.SoldOut.selector, AGENT, uint32(2)));
        license.purchaseLicense(AGENT, PRICE, _pid());
        vm.stopPrank();
    }

    function test_setSupplyCap_firstCapOfOneWithNoSales() public {
        _registerActive(creator, AGENT);
        vm.prank(creator);
        registry.setSupplyCap(AGENT, 1);
        _buy(buyer, AGENT);
        vm.startPrank(buyer2);
        usd.approve(address(license), PRICE);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.SoldOut.selector, AGENT, uint32(1)));
        license.purchaseLicense(AGENT, PRICE, _pid());
        vm.stopPrank();
        // the platform path hits the same cap
        vm.startPrank(platform);
        usd.approve(address(license), PRICE);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.SoldOut.selector, AGENT, uint32(1)));
        license.purchaseLicenseFor(buyer2, AGENT, PRICE, _pid());
        vm.stopPrank();
    }

    function test_setSupplyCap_raiseOnlyAndBurnNeverFrees() public {
        _registerActive(creator, AGENT);
        vm.prank(creator);
        registry.setSupplyCap(AGENT, 2);
        vm.startPrank(creator);
        vm.expectRevert(SolversRegistry.SupplyCapCannotDecrease.selector);
        registry.setSupplyCap(AGENT, 2);
        vm.expectRevert(SolversRegistry.SupplyCapCannotDecrease.selector);
        registry.setSupplyCap(AGENT, 1);
        vm.expectRevert(SolversRegistry.SupplyCapCannotDecrease.selector);
        registry.setSupplyCap(AGENT, 0);
        vm.stopPrank();

        uint256 t1 = _buy(buyer, AGENT);
        _buy(buyer2, AGENT);
        vm.prank(buyer);
        license.burn(t1);
        assertEq(registry.getAgent(AGENT).totalSales, 2);
        vm.startPrank(stranger);
        usd.approve(address(license), PRICE);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.SoldOut.selector, AGENT, uint32(2)));
        license.purchaseLicense(AGENT, PRICE, _pid());
        vm.stopPrank();

        vm.prank(creator);
        registry.setSupplyCap(AGENT, 3);
        assertEq(registry.getAgent(AGENT).maxSupply, 3);
        _buy(stranger, AGENT);
        assertEq(registry.getAgent(AGENT).totalSales, 3);

        vm.prank(stranger);
        vm.expectRevert(NotCreator.selector);
        registry.setSupplyCap(AGENT, 10);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, AGENT2));
        registry.setSupplyCap(AGENT2, 10);
    }

    // =====================================================================================================
    // 8. version-scoped evals (D6)
    // =====================================================================================================

    function test_setEval_versionScoped() public {
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        (bool measured, Eval memory e) = registry.currentEval(AGENT);
        assertFalse(measured);
        assertEq(e.at, 0);

        vm.warp(block.timestamp + 50);
        vm.expectEmit(address(registry));
        emit SolversRegistry.EvalSet(AGENT, VERSION_HASH, 8800, keccak256("report-1"), verifier);
        vm.prank(verifier);
        registry.setEval(AGENT, VERSION_HASH, 8800, keccak256("report-1"));
        (measured, e) = registry.currentEval(AGENT);
        assertTrue(measured);
        assertEq(e.scoreBps, 8800);
        assertEq(e.at, block.timestamp);
        assertEq(e.by, verifier);
        assertEq(e.evalHash, keccak256("report-1"));

        // new version: current eval is "not measured", the old one is still readable
        bytes32 v2 = keccak256("v2");
        vm.prank(creator);
        registry.updateVersion(AGENT, "2.0.0", v2);
        (measured, e) = registry.currentEval(AGENT);
        assertFalse(measured);
        Eval memory old = registry.evalOf(AGENT, VERSION_HASH);
        assertEq(old.scoreBps, 8800);
        assertEq(old.evalHash, keccak256("report-1"));

        vm.prank(verifier);
        registry.setEval(AGENT, v2, 10_000, keccak256("report-2"));
        (measured, e) = registry.currentEval(AGENT);
        assertTrue(measured);
        assertEq(e.scoreBps, 10_000);
        assertEq(registry.evalOf(AGENT, VERSION_HASH).scoreBps, 8800);

        // rolling back to v1 shows v1's eval again
        vm.prank(creator);
        registry.updateVersion(AGENT, "1.0.0", VERSION_HASH);
        (measured, e) = registry.currentEval(AGENT);
        assertTrue(measured);
        assertEq(e.scoreBps, 8800);
    }

    function test_setEval_zeroScoreIsMeasured() public {
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        vm.prank(verifier);
        registry.setEval(AGENT, VERSION_HASH, 0, bytes32(0));
        (bool measured, Eval memory e) = registry.currentEval(AGENT);
        assertTrue(measured);
        assertEq(e.scoreBps, 0);
    }

    function test_setEval_overwriteSameVersion() public {
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        vm.prank(verifier);
        registry.setEval(AGENT, VERSION_HASH, 5000, keccak256("a"));
        vm.prank(verifier);
        registry.setEval(AGENT, VERSION_HASH, 6000, keccak256("b"));
        assertEq(registry.evalOf(AGENT, VERSION_HASH).scoreBps, 6000);
        assertEq(registry.evalOf(AGENT, VERSION_HASH).evalHash, keccak256("b"));
    }

    function test_setEval_validations() public {
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        vm.prank(verifier);
        vm.expectRevert(SolversRegistry.InvalidBps.selector);
        registry.setEval(AGENT, VERSION_HASH, 10_001, bytes32(0));
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, AGENT2));
        registry.setEval(AGENT2, VERSION_HASH, 1, bytes32(0));
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger, VERIFIER_ROLE));
        registry.setEval(AGENT, VERSION_HASH, 1, bytes32(0));
        vm.prank(admin);
        vm.expectRevert(_unauthorized(admin, VERIFIER_ROLE));
        registry.setEval(AGENT, VERSION_HASH, 1, bytes32(0));
        vm.prank(creator);
        vm.expectRevert(_unauthorized(creator, VERIFIER_ROLE));
        registry.setEval(AGENT, VERSION_HASH, 1, bytes32(0));
    }

    // =====================================================================================================
    // 9. approveAgent / suspendAgent
    // =====================================================================================================

    function test_approveAgent_pendingToActive() public {
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        vm.expectEmit(address(registry));
        emit SolversRegistry.AgentStatusChanged(AGENT, AgentStatus.Active, admin);
        vm.prank(admin);
        registry.approveAgent(AGENT);
        assertEq(uint8(registry.statusOf(AGENT)), uint8(AgentStatus.Active));

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentNotPending.selector, AGENT));
        registry.approveAgent(AGENT);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, AGENT2));
        registry.approveAgent(AGENT2);
    }

    function test_suspendAndReapprove() public {
        _registerActive(creator, AGENT);
        vm.expectEmit(address(registry));
        emit SolversRegistry.AgentStatusChanged(AGENT, AgentStatus.Suspended, admin);
        vm.prank(admin);
        registry.suspendAgent(AGENT);
        assertEq(uint8(registry.statusOf(AGENT)), uint8(AgentStatus.Suspended));
        // suspending twice is harmless
        vm.prank(admin);
        registry.suspendAgent(AGENT);
        vm.prank(admin);
        registry.approveAgent(AGENT);
        assertEq(uint8(registry.statusOf(AGENT)), uint8(AgentStatus.Active));

        // a pending agent can be suspended too
        _register(creator2, AGENT2, PRICE, PRICE_PER_USE, 0);
        vm.prank(admin);
        registry.suspendAgent(AGENT2);
        assertEq(uint8(registry.statusOf(AGENT2)), uint8(AgentStatus.Suspended));

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, bytes32(uint256(1))));
        registry.suspendAgent(bytes32(uint256(1)));
    }

    function test_retiredCannotBeApprovedOrSuspended() public {
        _registerActive(creator, AGENT);
        vm.prank(creator);
        staking.requestStakeExit(AGENT);
        assertEq(uint8(registry.statusOf(AGENT)), uint8(AgentStatus.Retired));
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentRetired.selector, AGENT));
        registry.approveAgent(AGENT);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentRetired.selector, AGENT));
        registry.suspendAgent(AGENT);
        vm.stopPrank();
    }

    function test_approveAgent_requiresMinStake() public {
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        _setConfig(FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE + 1, MIN_PRICE);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.InsufficientStake.selector, MIN_STAKE, MIN_STAKE + 1));
        registry.approveAgent(AGENT);
        // topping up fixes it
        vm.startPrank(creator);
        usd.approve(address(staking), 1);
        staking.topUpStake(AGENT, 1);
        vm.stopPrank();
        vm.prank(admin);
        registry.approveAgent(AGENT);
        assertEq(uint8(registry.statusOf(AGENT)), uint8(AgentStatus.Active));
    }

    function test_approveAgent_afterPartialSlashNeedsTopUp() public {
        _registerActive(creator, AGENT);
        _slash(AGENT, 1_000_000);
        assertEq(registry.stakeOf(AGENT), MIN_STAKE - 1_000_000);
        assertEq(uint8(registry.statusOf(AGENT)), uint8(AgentStatus.Suspended));
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(SolversRegistry.InsufficientStake.selector, MIN_STAKE - 1_000_000, MIN_STAKE)
        );
        registry.approveAgent(AGENT);
    }

    function test_approveSuspend_onlyAdmin() public {
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        address[4] memory callers = [stranger, guardian, creator, verifier];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(_unauthorized(callers[i], 0x00));
            registry.approveAgent(AGENT);
            vm.prank(callers[i]);
            vm.expectRevert(_unauthorized(callers[i], 0x00));
            registry.suspendAgent(AGENT);
        }
    }

    // =====================================================================================================
    // 10. authorizeSale through the satellites
    // =====================================================================================================

    function test_authorizeSale_licenseEventsRefAndReputation() public {
        _registerActive(creator, AGENT);
        bytes32 pid = _pid();
        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        vm.expectEmit(address(registry));
        emit SolversRegistry.ReputationChanged(buyer, 1, 0, 0);
        vm.expectEmit(address(registry));
        emit SolversRegistry.SaleAuthorized(pid, AGENT, buyer, buyer, SaleKind.License, bytes32(uint256(1)));
        uint256 tokenId = license.purchaseLicense(AGENT, PRICE, pid);
        vm.stopPrank();
        assertEq(tokenId, 1);
        assertEq(registry.purchaseRef(buyer, pid), _ref(SaleKind.License, 1));
        assertEq(uint256(registry.purchaseRef(buyer, pid)) >> 248, 1);
        assertEq(registry.getAgent(AGENT).totalSales, 1);
        Reputation memory rep = registry.reputationOf(buyer);
        assertEq(rep.purchases, 1);
        assertEq(rep.disputesOpened, 0);
        assertEq(rep.disputesLost, 0);
        assertEq(registry.purchaseRef(buyer, _pid()), bytes32(0));
    }

    function test_authorizeSale_creditsRef() public {
        _registerActive(creator, AGENT);
        bytes32 pid = _pid();
        vm.startPrank(buyer);
        usd.approve(address(credits), 2 * uint256(PRICE_PER_USE) * 5);
        vm.expectEmit(address(registry));
        emit SolversRegistry.ReputationChanged(buyer, 1, 0, 0);
        vm.expectEmit(address(registry));
        emit SolversRegistry.SaleAuthorized(
            pid, AGENT, buyer, buyer, SaleKind.Credits, bytes32(uint256(uint160(buyer)))
        );
        credits.buyCredits(AGENT, 5, 5 * uint256(PRICE_PER_USE), pid);
        vm.stopPrank();
        assertEq(registry.purchaseRef(buyer, pid), _ref(SaleKind.Credits, uint160(buyer)));
        assertEq(registry.getAgent(AGENT).totalSales, 0); // credits never count against the license cap
        assertEq(registry.reputationOf(buyer).purchases, 1);

        // the platform path records the BUYER, not the payer, in the ref and the reputation
        bytes32 pid2 = _pid();
        vm.startPrank(platform);
        usd.approve(address(credits), 5 * uint256(PRICE_PER_USE));
        credits.buyCreditsFor(buyer2, AGENT, 5, 5 * uint256(PRICE_PER_USE), pid2);
        vm.stopPrank();
        assertEq(registry.purchaseRef(platform, pid2), _ref(SaleKind.Credits, uint160(buyer2)));
        assertEq(registry.reputationOf(buyer2).purchases, 1);
        assertEq(registry.reputationOf(platform).purchases, 0);
    }

    function test_authorizeSale_escrowRefNoPurchaseBump() public {
        _registerActive(creator, AGENT);
        bytes32 pid = _pid();
        vm.startPrank(buyer);
        usd.approve(address(escrow), 3 * uint256(MS_AMOUNT));
        vm.expectEmit(address(registry));
        emit SolversRegistry.SaleAuthorized(pid, AGENT, buyer, buyer, SaleKind.Escrow, bytes32(uint256(1)));
        uint256 id = escrow.createEscrow(AGENT, _ms(3, MS_AMOUNT), WINDOW, 0, pid);
        vm.stopPrank();
        assertEq(id, 1);
        assertEq(registry.purchaseRef(buyer, pid), _ref(SaleKind.Escrow, 1));
        assertEq(registry.reputationOf(buyer).purchases, 0);
        assertEq(registry.getAgent(AGENT).totalSales, 0);
    }

    function test_authorizeSale_duplicatePurchaseAcrossKinds() public {
        _registerActive(creator, AGENT);
        // license first
        bytes32 p1 = _pid();
        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        uint256 tokenId = license.purchaseLicense(AGENT, PRICE, p1);
        bytes32 r1 = _ref(SaleKind.License, tokenId);

        usd.approve(address(license), PRICE);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.DuplicatePurchase.selector, p1, r1));
        license.purchaseLicense(AGENT, PRICE, p1);
        usd.approve(address(credits), 5 * uint256(PRICE_PER_USE));
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.DuplicatePurchase.selector, p1, r1));
        credits.buyCredits(AGENT, 5, 5 * uint256(PRICE_PER_USE), p1);
        usd.approve(address(escrow), 3 * uint256(MS_AMOUNT));
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.DuplicatePurchase.selector, p1, r1));
        escrow.createEscrow(AGENT, _ms(3, MS_AMOUNT), WINDOW, 0, p1);
        vm.stopPrank();

        // credits first, by the platform for buyer2
        bytes32 p2 = _pid();
        vm.startPrank(platform);
        usd.approve(address(credits), 5 * uint256(PRICE_PER_USE));
        credits.buyCreditsFor(buyer2, AGENT, 5, 5 * uint256(PRICE_PER_USE), p2);
        bytes32 r2 = _ref(SaleKind.Credits, uint160(buyer2));
        usd.approve(address(license), PRICE);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.DuplicatePurchase.selector, p2, r2));
        license.purchaseLicenseFor(buyer, AGENT, PRICE, p2);
        usd.approve(address(escrow), 3 * uint256(MS_AMOUNT));
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.DuplicatePurchase.selector, p2, r2));
        escrow.createEscrowFor(buyer, AGENT, _ms(3, MS_AMOUNT), WINDOW, 0, p2);
        vm.stopPrank();

        // escrow first
        bytes32 p3 = _pid();
        vm.startPrank(buyer);
        usd.approve(address(escrow), 3 * uint256(MS_AMOUNT));
        uint256 escrowId = escrow.createEscrow(AGENT, _ms(3, MS_AMOUNT), WINDOW, 0, p3);
        bytes32 r3 = _ref(SaleKind.Escrow, escrowId);
        usd.approve(address(credits), 5 * uint256(PRICE_PER_USE));
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.DuplicatePurchase.selector, p3, r3));
        credits.buyCredits(AGENT, 5, 5 * uint256(PRICE_PER_USE), p3);
        usd.approve(address(license), PRICE);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.DuplicatePurchase.selector, p3, r3));
        license.purchaseLicense(AGENT, PRICE, p3);
        vm.stopPrank();

        // the same id is also refused for another agent
        _registerActive(creator2, AGENT2);
        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.DuplicatePurchase.selector, p1, r1));
        license.purchaseLicense(AGENT2, PRICE, p1);
        vm.stopPrank();

        assertEq(registry.purchaseRef(buyer, p1), r1);
        assertEq(registry.purchaseRef(platform, p2), r2);
        assertEq(registry.purchaseRef(buyer, p2), bytes32(0)); // scoped by payer
        assertEq(registry.purchaseRef(buyer, p3), r3);
    }

    function test_authorizeSale_invalidPurchaseIdAndZeroBuyer() public {
        _registerActive(creator, AGENT);
        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        vm.expectRevert(SolversRegistry.InvalidPurchaseId.selector);
        license.purchaseLicense(AGENT, PRICE, bytes32(0));
        usd.approve(address(credits), 5 * uint256(PRICE_PER_USE));
        vm.expectRevert(SolversRegistry.InvalidPurchaseId.selector);
        credits.buyCredits(AGENT, 5, 5 * uint256(PRICE_PER_USE), bytes32(0));
        usd.approve(address(escrow), 3 * uint256(MS_AMOUNT));
        vm.expectRevert(SolversRegistry.InvalidPurchaseId.selector);
        escrow.createEscrow(AGENT, _ms(3, MS_AMOUNT), WINDOW, 0, bytes32(0));
        vm.stopPrank();

        vm.startPrank(platform);
        usd.approve(address(license), PRICE);
        vm.expectRevert(ZeroAddress.selector);
        license.purchaseLicenseFor(address(0), AGENT, PRICE, _pid());
        usd.approve(address(credits), 5 * uint256(PRICE_PER_USE));
        vm.expectRevert(ZeroAddress.selector);
        credits.buyCreditsFor(address(0), AGENT, 5, 5 * uint256(PRICE_PER_USE), _pid());
        usd.approve(address(escrow), 3 * uint256(MS_AMOUNT));
        vm.expectRevert(ZeroAddress.selector);
        escrow.createEscrowFor(address(0), AGENT, _ms(3, MS_AMOUNT), WINDOW, 0, _pid());
        vm.stopPrank();
    }

    function test_authorizeSale_selfPurchase() public {
        _registerActive(creator, AGENT);
        vm.startPrank(creator);
        usd.approve(address(license), PRICE);
        vm.expectRevert(SolversRegistry.SelfPurchase.selector);
        license.purchaseLicense(AGENT, PRICE, _pid());
        usd.approve(address(credits), 5 * uint256(PRICE_PER_USE));
        vm.expectRevert(SolversRegistry.SelfPurchase.selector);
        credits.buyCredits(AGENT, 5, 5 * uint256(PRICE_PER_USE), _pid());
        vm.stopPrank();
        vm.startPrank(platform);
        usd.approve(address(license), PRICE);
        vm.expectRevert(SolversRegistry.SelfPurchase.selector);
        license.purchaseLicenseFor(creator, AGENT, PRICE, _pid());
        usd.approve(address(credits), 5 * uint256(PRICE_PER_USE));
        vm.expectRevert(SolversRegistry.SelfPurchase.selector);
        credits.buyCreditsFor(creator, AGENT, 5, 5 * uint256(PRICE_PER_USE), _pid());
        vm.stopPrank();
        // refinement (4): SelfPurchase is License + Credits only; a creator may fund a guarantee on its own agent
        uint256 id = _createEscrow(creator, AGENT, 3);
        assertEq(id, 1);
        // a creator may buy someone else's agent
        _registerActive(creator2, AGENT2);
        _buy(creator, AGENT2);
    }

    function test_authorizeSale_agentNotActive() public {
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS); // Pending
        _assertAllKindsRevert(abi.encodeWithSelector(SolversRegistry.AgentNotActive.selector, AGENT));
        vm.prank(admin);
        registry.approveAgent(AGENT);
        vm.prank(admin);
        registry.suspendAgent(AGENT); // Suspended
        _assertAllKindsRevert(abi.encodeWithSelector(SolversRegistry.AgentNotActive.selector, AGENT));
        vm.prank(admin);
        registry.approveAgent(AGENT);
        vm.prank(creator);
        staking.requestStakeExit(AGENT); // Retired
        _assertAllKindsRevert(abi.encodeWithSelector(SolversRegistry.AgentNotActive.selector, AGENT));
    }

    function test_authorizeSale_agentNotFound() public {
        _assertAllKindsRevert(abi.encodeWithSelector(AgentNotFound.selector, AGENT));
    }

    function _assertAllKindsRevert(bytes memory err) internal {
        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        vm.expectRevert(err);
        license.purchaseLicense(AGENT, PRICE, _pid());
        usd.approve(address(credits), 5 * uint256(PRICE_PER_USE));
        vm.expectRevert(err);
        credits.buyCredits(AGENT, 5, 5 * uint256(PRICE_PER_USE), _pid());
        usd.approve(address(escrow), 3 * uint256(MS_AMOUNT));
        vm.expectRevert(err);
        escrow.createEscrow(AGENT, _ms(3, MS_AMOUNT), WINDOW, 0, _pid());
        vm.stopPrank();
    }

    function test_authorizeSale_payPerUseDisabled() public {
        _register(creator, AGENT, PRICE, 0, CREATOR_ROYALTY_BPS);
        vm.prank(admin);
        registry.approveAgent(AGENT);
        vm.startPrank(buyer);
        usd.approve(address(credits), PRICE);
        vm.expectRevert(SolversRegistry.PayPerUseDisabled.selector);
        credits.buyCredits(AGENT, 5, PRICE, _pid());
        vm.stopPrank();
        _buy(buyer, AGENT); // licenses still sell
    }

    function test_authorizeSale_insufficientStakeAfterPartialSlash() public {
        _registerActive(creator, AGENT);
        _slash(AGENT, 5_000_000);
        uint96 left = MIN_STAKE - 5_000_000;
        // the admin lowers the bar to reactivate, then restores it: the agent is Active but under-staked
        _setConfig(FEE_BPS, PLATFORM_ROYALTY_BPS, left, MIN_PRICE);
        vm.prank(admin);
        registry.approveAgent(AGENT);
        _buy(buyer, AGENT);
        _setConfig(FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE);
        assertEq(uint8(registry.statusOf(AGENT)), uint8(AgentStatus.Active));
        _assertAllKindsRevert(abi.encodeWithSelector(SolversRegistry.InsufficientStake.selector, left, MIN_STAKE));
        // a top-up restores sales
        vm.startPrank(creator);
        usd.approve(address(staking), 5_000_000);
        staking.topUpStake(AGENT, 5_000_000);
        vm.stopPrank();
        _buy(buyer2, AGENT);
    }

    function test_authorizeSale_insufficientStakeAfterMinStakeRaised() public {
        _registerActive(creator, AGENT);
        _setConfig(FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE * 2, MIN_PRICE);
        _assertAllKindsRevert(
            abi.encodeWithSelector(SolversRegistry.InsufficientStake.selector, MIN_STAKE, MIN_STAKE * 2)
        );
    }

    function test_authorizeSale_buyerNotEligibleAfterThreeLostDisputes() public {
        _registerActive(creator, AGENT);
        uint256 id = _createEscrow(buyer, AGENT, 3);
        for (uint8 i; i < 2; ++i) {
            vm.expectEmit(address(registry));
            emit SolversRegistry.ReputationChanged(buyer, 0, i + 1, i);
            vm.prank(buyer);
            escrow.openDispute(id, i, keccak256("bad"));
            vm.expectEmit(address(registry));
            emit SolversRegistry.ReputationChanged(buyer, 0, i + 1, i + 1);
            vm.prank(admin);
            escrow.resolveDispute(id, i, false);
        }
        // two lost disputes: still eligible
        uint256 id2 = _createEscrow(buyer, AGENT, 3);
        vm.prank(buyer);
        escrow.openDispute(id, 2, keccak256("bad"));
        vm.prank(admin);
        escrow.resolveDispute(id, 2, false);
        Reputation memory rep = registry.reputationOf(buyer);
        assertEq(rep.purchases, 0);
        assertEq(rep.disputesOpened, 3);
        assertEq(rep.disputesLost, 3);

        vm.startPrank(buyer);
        usd.approve(address(escrow), 3 * uint256(MS_AMOUNT));
        vm.expectRevert(SolversRegistry.BuyerNotEligible.selector);
        escrow.createEscrow(AGENT, _ms(3, MS_AMOUNT), WINDOW, 0, _pid());
        vm.stopPrank();
        vm.startPrank(platform);
        usd.approve(address(escrow), 3 * uint256(MS_AMOUNT));
        vm.expectRevert(SolversRegistry.BuyerNotEligible.selector);
        escrow.createEscrowFor(buyer, AGENT, _ms(3, MS_AMOUNT), WINDOW, 0, _pid());
        vm.stopPrank();

        // the existing guarantee keeps working, and licenses / credits still sell to this buyer
        vm.prank(buyer);
        escrow.releaseMilestone(id2, 0);
        _buy(buyer, AGENT);
        _buyCredits(buyer, AGENT, 5);
        assertEq(registry.reputationOf(buyer).purchases, 2);
        // the agent's lost-dispute counter is untouched by buyer losses
        assertEq(registry.getAgent(AGENT).disputesLost, 0);
    }

    function test_recordDisputeOutcome_refundCountsAgainstAgent() public {
        _registerActive(creator, AGENT);
        uint256 id = _createEscrow(buyer, AGENT, 3);
        vm.prank(buyer);
        escrow.openDispute(id, 0, keccak256("bad"));
        vm.expectEmit(address(registry));
        emit SolversRegistry.AgentDisputeLost(AGENT, 1);
        vm.prank(admin);
        escrow.resolveDispute(id, 0, true);
        assertEq(registry.getAgent(AGENT).disputesLost, 1);
        Reputation memory rep = registry.reputationOf(buyer);
        assertEq(rep.disputesOpened, 1);
        assertEq(rep.disputesLost, 0);
    }

    function test_reputation_accumulatesAcrossKinds() public {
        _registerActive(creator, AGENT);
        _buy(buyer, AGENT);
        _buyCredits(buyer, AGENT, 5);
        _createEscrow(buyer, AGENT, 3);
        Reputation memory rep = registry.reputationOf(buyer);
        assertEq(rep.purchases, 2);
        assertEq(rep.disputesOpened, 0);
        assertEq(rep.disputesLost, 0);
        assertEq(registry.reputationOf(buyer2).purchases, 0);
    }

    function test_authorizeSale_satelliteKindBinding() public {
        _registerActive(creator, AGENT);
        bytes32 pid = _pid();
        // each satellite may only authorize its own kind
        SaleKind[4] memory kinds = [SaleKind.None, SaleKind.License, SaleKind.Credits, SaleKind.Escrow];
        address[5] memory callers =
            [address(license), address(credits), address(escrow), address(reviews), address(staking)];
        for (uint256 c; c < callers.length; ++c) {
            for (uint256 k; k < kinds.length; ++k) {
                bool allowed = (c == 0 && k == 1) || (c == 1 && k == 2) || (c == 2 && k == 3);
                if (allowed) continue;
                vm.prank(callers[c]);
                vm.expectRevert(NotSatellite.selector);
                registry.authorizeSale(AGENT, buyer, buyer, kinds[k], pid, bytes32(uint256(1)));
            }
        }
        // a direct call by the right satellite returns the sale parameters
        vm.prank(address(credits));
        SaleAuth memory auth = registry.authorizeSale(AGENT, buyer, buyer, SaleKind.Credits, pid, bytes32(uint256(7)));
        assertEq(auth.creator, creator);
        assertEq(auth.treasury, treasury);
        assertEq(auth.token, address(token));
        assertEq(auth.price, PRICE);
        assertEq(auth.pricePerUse, PRICE_PER_USE);
        assertEq(auth.feeBps, FEE_BPS);
        assertEq(auth.minPrice, MIN_PRICE);
        assertEq(auth.agentIndex, 0);
        assertEq(registry.purchaseRef(buyer, pid), _ref(SaleKind.Credits, 7));
    }

    // =====================================================================================================
    // 11. views
    // =====================================================================================================

    function test_royaltyParams_clamp() public {
        _register(creator, AGENT, PRICE, PRICE_PER_USE, 2000);
        _register(creator2, AGENT2, PRICE, PRICE_PER_USE, 500);
        (address c, uint16 cb, address t, uint16 pb, uint8 flags) = registry.royaltyParams(0);
        assertEq(c, creator);
        assertEq(cb, 2000);
        assertEq(t, treasury);
        assertEq(pb, 500);
        assertEq(flags, 0);

        // the platform raises its share: agent 0 is clamped to 2500 total, agent 1 gets the full share
        address t2 = makeAddr("treasury2");
        vm.prank(admin);
        registry.setConfig(t2, FEE_BPS, 1500, MIN_STAKE, MIN_PRICE);
        _setPause(PAUSE_TRANSFERS);
        (c, cb, t, pb, flags) = registry.royaltyParams(0);
        assertEq(cb, 2000);
        assertEq(pb, 500);
        assertEq(t, t2);
        assertEq(flags, PAUSE_TRANSFERS);
        (c, cb,, pb,) = registry.royaltyParams(1);
        assertEq(c, creator2);
        assertEq(cb, 500);
        assertEq(pb, 1500);

        vm.prank(admin);
        registry.setConfig(t2, FEE_BPS, 2500, MIN_STAKE, MIN_PRICE);
        (, cb,, pb,) = registry.royaltyParams(0);
        assertEq(uint256(cb) + pb, 2500);
        assertEq(pb, 500);
        (, cb,, pb,) = registry.royaltyParams(1);
        assertEq(pb, 2000);

        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentIndexOutOfRange.selector, uint32(2)));
        registry.royaltyParams(2);
    }

    function test_royaltyParams_creatorAtFullCapLeavesNoPlatformShare() public {
        _setConfig(FEE_BPS, 0, MIN_STAKE, MIN_PRICE);
        _register(creator, AGENT, PRICE, PRICE_PER_USE, 2500);
        _setConfig(FEE_BPS, 1000, MIN_STAKE, MIN_PRICE);
        (, uint16 cb,, uint16 pb,) = registry.royaltyParams(0);
        assertEq(cb, 2500);
        assertEq(pb, 0);
    }

    function test_paymentParamsAndConfig() public {
        (address t, address tr, uint16 fee, uint96 minP) = registry.paymentParams();
        assertEq(t, address(token));
        assertEq(tr, treasury);
        assertEq(fee, FEE_BPS);
        assertEq(minP, MIN_PRICE);
        (address tr2, uint16 fee2, uint16 royalty, uint8 flags, uint96 minS, uint96 minP2) = registry.config();
        assertEq(tr2, treasury);
        assertEq(fee2, FEE_BPS);
        assertEq(royalty, PLATFORM_ROYALTY_BPS);
        assertEq(flags, 0);
        assertEq(minS, MIN_STAKE);
        assertEq(minP2, MIN_PRICE);

        _setPause(PAUSE_ENTRIES | PAUSE_PAYMENTS);
        (,,, flags,,) = registry.config();
        assertEq(flags, 3);
        assertEq(registry.pauseFlags(), 3);
    }

    function test_satellitesView() public view {
        (address l, address c, address rv, address e, address s) = registry.satellites();
        assertEq(l, address(license));
        assertEq(c, address(credits));
        assertEq(rv, address(reviews));
        assertEq(e, address(escrow));
        assertEq(s, address(staking));
        assertEq(address(license.registry()), address(registry));
        assertEq(address(license.paymentToken()), address(token));
    }

    function test_agentIndexOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentIndexOutOfRange.selector, uint32(0)));
        registry.agentIdAt(0);
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        assertEq(registry.agentCount(), 1);
        assertEq(registry.agentIdAt(0), AGENT);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentIndexOutOfRange.selector, uint32(1)));
        registry.agentIdAt(1);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentIndexOutOfRange.selector, type(uint32).max));
        registry.agentIdAt(type(uint32).max);
    }

    function test_unknownAgentViews() public {
        assertFalse(registry.agentExists(AGENT));
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, AGENT));
        registry.getAgent(AGENT);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, AGENT));
        registry.creatorOf(AGENT);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, AGENT));
        registry.stakeOf(AGENT);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, AGENT));
        registry.statusOf(AGENT);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, AGENT));
        registry.currentEval(AGENT);
        Eval memory e = registry.evalOf(AGENT, VERSION_HASH);
        assertEq(e.at, 0);
        Reputation memory rep = registry.reputationOf(stranger);
        assertEq(rep.purchases, 0);
    }

    function test_maxBuyerDisputesLostConstant() public view {
        assertEq(registry.MAX_BUYER_DISPUTES_LOST(), 3);
    }
}

/// @notice Deployment with `minStake == 0`: registration moves no tokens.
contract RegistryZeroStakeTest is RegistryHelpers {
    function setUp() public override {
        super.setUp();
        _deploy(0);
    }

    function test_registerAgent_withoutStake() public {
        assertEq(registry.minStake(), 0);
        uint256 creatorBefore = _bal(creator);
        uint256 stakingBefore = _bal(address(staking));
        AgentRegistration memory r = _registration(AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        vm.recordLogs();
        vm.expectEmit(address(registry));
        emit SolversRegistry.AgentRegistered(
            AGENT, creator, 0, r.metadataUri, r.version, VERSION_HASH, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS, 0
        );
        vm.prank(creator); // no approval at all
        registry.registerAgent(r);

        // no StakePulled / token Transfer happened
        bytes32 transferSig = keccak256("Transfer(address,address,uint256)");
        bytes32 pulledSig = SolversStaking.StakePulled.selector;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertGt(logs.length, 0);
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 0) continue;
            assertTrue(logs[i].topics[0] != transferSig, "token moved");
            assertTrue(logs[i].topics[0] != pulledSig, "stake pulled");
        }

        assertEq(_bal(creator), creatorBefore);
        assertEq(_bal(address(staking)), stakingBefore);
        assertEq(staking.totalStaked(), 0);
        assertEq(registry.stakeOf(AGENT), 0);
        assertEq(uint8(registry.statusOf(AGENT)), uint8(AgentStatus.Pending));

        // approval and sales work with zero stake
        vm.prank(admin);
        registry.approveAgent(AGENT);
        _buy(buyer, AGENT);
        assertEq(registry.getAgent(AGENT).totalSales, 1);
    }
}

/// @dev Minimal satellite for wiring tests: what setSatellites checks (registry and payment token).
contract WiringStub {
    address public immutable registry;
    address public immutable paymentToken;

    constructor(address registry_, address token_) {
        registry = registry_;
        paymentToken = token_;
    }
}
