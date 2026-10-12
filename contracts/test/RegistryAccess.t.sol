// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {RegistryHelpers} from "./Registry.t.sol";
import {SolversRegistry} from "../src/SolversRegistry.sol";
import {SolversLicense} from "../src/SolversLicense.sol";
import {SolversCredits} from "../src/SolversCredits.sol";
import {SolversReviews} from "../src/SolversReviews.sol";
import {SolversEscrow} from "../src/SolversEscrow.sol";
import {SolversStaking} from "../src/SolversStaking.sol";
import {Reputation} from "../src/interfaces/ISolversRegistry.sol";
import {
    AgentStatus,
    SaleKind,
    MilestoneStatus,
    PLATFORM_ROLE,
    VERIFIER_ROLE,
    USAGE_ROLE,
    GUARDIAN_ROLE,
    AgentNotFound,
    NotCreator,
    NotSatellite
} from "../src/SolversTypes.sol";

/// @notice Access-control matrix: every gated function of the six contracts, with the exact error for a caller
/// without the right role, and one success path per function for the right caller.
contract RegistryAccessTest is RegistryHelpers {
    struct Case {
        string name;
        address target;
        bytes data;
        bytes err;
    }

    address internal platformOnly = makeAddr("platformOnly");
    address internal usageOnly = makeAddr("usageOnly");
    uint256 internal tokenId;
    uint256 internal escrowId;

    function setUp() public override {
        super.setUp();
        vm.startPrank(admin);
        registry.grantRole(PLATFORM_ROLE, platformOnly);
        registry.grantRole(USAGE_ROLE, usageOnly);
        vm.stopPrank();
        token.mint(platformOnly, 1_000_000_000);
        _registerActive(creator, AGENT);
        _register(creator2, AGENT2, PRICE, PRICE_PER_USE, 0); // Pending
        tokenId = _buy(buyer, AGENT);
        _buyCredits(buyer, AGENT, 5);
        escrowId = _createEscrow(buyer, AGENT, 3);
    }

    function _run(address caller, Case[] memory cs) internal {
        for (uint256 i; i < cs.length; ++i) {
            vm.prank(caller);
            (bool ok, bytes memory ret) = cs[i].target.call(cs[i].data);
            assertFalse(ok, cs[i].name);
            assertEq(ret, cs[i].err, cs[i].name);
        }
    }

    function _upgradeCall() internal pure returns (bytes memory) {
        return abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (address(0xdead), ""));
    }

    // =====================================================================================================
    // stranger tables
    // =====================================================================================================

    function _registryCases(address who) internal view returns (Case[] memory cs) {
        bytes memory adminErr = _unauthorized(who, 0x00);
        cs = new Case[](25);
        uint256 n;
        cs[n++] = Case(
            "setSatellites",
            address(registry),
            abi.encodeCall(SolversRegistry.setSatellites, (who, who, who, who, who)),
            adminErr
        );
        cs[n++] = Case(
            "setConfig", address(registry), abi.encodeCall(SolversRegistry.setConfig, (who, 0, 0, 0, 1)), adminErr
        );
        cs[n++] = Case(
            "setPause",
            address(registry),
            abi.encodeCall(SolversRegistry.setPause, (1)),
            abi.encodeWithSelector(SolversRegistry.NotPauseAuthority.selector)
        );
        cs[n++] =
            Case("approveAgent", address(registry), abi.encodeCall(SolversRegistry.approveAgent, (AGENT2)), adminErr);
        cs[n++] =
            Case("suspendAgent", address(registry), abi.encodeCall(SolversRegistry.suspendAgent, (AGENT)), adminErr);
        cs[n++] = Case(
            "setEval",
            address(registry),
            abi.encodeCall(SolversRegistry.setEval, (AGENT, VERSION_HASH, 1, bytes32(0))),
            _unauthorized(who, VERIFIER_ROLE)
        );
        cs[n++] = Case(
            "grantRole", address(registry), abi.encodeCall(IAccessControl.grantRole, (PLATFORM_ROLE, who)), adminErr
        );
        cs[n++] = Case(
            "revokeRole",
            address(registry),
            abi.encodeCall(IAccessControl.revokeRole, (PLATFORM_ROLE, platform)),
            adminErr
        );
        cs[n++] = Case(
            "beginDefaultAdminTransfer",
            address(registry),
            abi.encodeCall(IAccessControlDefaultAdminRules.beginDefaultAdminTransfer, (who)),
            adminErr
        );
        cs[n++] = Case(
            "cancelDefaultAdminTransfer",
            address(registry),
            abi.encodeCall(IAccessControlDefaultAdminRules.cancelDefaultAdminTransfer, ()),
            adminErr
        );
        cs[n++] = Case(
            "changeDefaultAdminDelay",
            address(registry),
            abi.encodeCall(IAccessControlDefaultAdminRules.changeDefaultAdminDelay, (1)),
            adminErr
        );
        cs[n++] = Case(
            "rollbackDefaultAdminDelay",
            address(registry),
            abi.encodeCall(IAccessControlDefaultAdminRules.rollbackDefaultAdminDelay, ()),
            adminErr
        );
        cs[n++] = Case(
            "acceptDefaultAdminTransfer",
            address(registry),
            abi.encodeCall(IAccessControlDefaultAdminRules.acceptDefaultAdminTransfer, ()),
            abi.encodeWithSelector(IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, who)
        );
        cs[n++] = Case("upgradeToAndCall", address(registry), _upgradeCall(), adminErr);
        bytes memory notCreator = abi.encodeWithSelector(NotCreator.selector);
        cs[n++] = Case(
            "updateVersion",
            address(registry),
            abi.encodeCall(SolversRegistry.updateVersion, (AGENT, "9", bytes32(0))),
            notCreator
        );
        cs[n++] = Case(
            "updateMetadataUri",
            address(registry),
            abi.encodeCall(SolversRegistry.updateMetadataUri, (AGENT, "x")),
            notCreator
        );
        cs[n++] = Case(
            "updatePricing",
            address(registry),
            abi.encodeCall(SolversRegistry.updatePricing, (AGENT, PRICE, 0)),
            notCreator
        );
        cs[n++] = Case(
            "setRoyaltyBps", address(registry), abi.encodeCall(SolversRegistry.setRoyaltyBps, (AGENT2, 1)), notCreator
        );
        cs[n++] = Case(
            "setSupplyCap", address(registry), abi.encodeCall(SolversRegistry.setSupplyCap, (AGENT, 100)), notCreator
        );
        bytes memory notSat = abi.encodeWithSelector(NotSatellite.selector);
        cs[n++] = Case(
            "authorizeSale",
            address(registry),
            abi.encodeCall(
                SolversRegistry.authorizeSale, (AGENT, buyer2, buyer2, SaleKind.License, keccak256("p"), bytes32(0))
            ),
            notSat
        );
        cs[n++] = Case(
            "recordDisputeOpened",
            address(registry),
            abi.encodeCall(SolversRegistry.recordDisputeOpened, (buyer)),
            notSat
        );
        cs[n++] = Case(
            "recordDisputeOutcome",
            address(registry),
            abi.encodeCall(SolversRegistry.recordDisputeOutcome, (AGENT, buyer, false)),
            notSat
        );
        cs[n++] = Case("setStake", address(registry), abi.encodeCall(SolversRegistry.setStake, (AGENT, 0)), notSat);
        cs[n++] = Case(
            "setStatus",
            address(registry),
            abi.encodeCall(SolversRegistry.setStatus, (AGENT, AgentStatus.Active, who)),
            notSat
        );
        cs[n++] = Case(
            "grantRole(GUARDIAN)",
            address(registry),
            abi.encodeCall(IAccessControl.grantRole, (GUARDIAN_ROLE, who)),
            adminErr
        );
        assertEq(n, cs.length);
    }

    function _licenseCases(address who) internal view returns (Case[] memory cs) {
        bytes memory adminErr = _unauthorized(who, 0x00);
        cs = new Case[](8);
        uint256 n;
        cs[n++] = Case(
            "purchaseLicenseFor",
            address(license),
            abi.encodeCall(SolversLicense.purchaseLicenseFor, (buyer2, AGENT, PRICE, keccak256("p"))),
            _unauthorized(who, PLATFORM_ROLE)
        );
        cs[n++] = Case("setBaseURI", address(license), abi.encodeCall(SolversLicense.setBaseURI, ("x")), adminErr);
        cs[n++] = Case(
            "useForReview",
            address(license),
            abi.encodeCall(SolversLicense.useForReview, (tokenId, buyer, AGENT, 1)),
            abi.encodeWithSelector(SolversLicense.NotReviews.selector)
        );
        cs[n++] = Case("sweepStray", address(license), abi.encodeWithSignature("sweepStray(address)", who), adminErr);
        cs[n++] = Case("upgradeToAndCall", address(license), _upgradeCall(), adminErr);
        bytes memory notApproved =
            abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, who, tokenId);
        cs[n++] = Case("burn", address(license), abi.encodeCall(SolversLicense.burn, (tokenId)), notApproved);
        cs[n++] = Case(
            "transferFrom",
            address(license),
            abi.encodeCall(SolversLicense.transferFrom, (buyer, who, tokenId)),
            notApproved
        );
        cs[n++] = Case(
            "transferWithRoyalty",
            address(license),
            abi.encodeCall(SolversLicense.transferWithRoyalty, (who, tokenId, PRICE)),
            notApproved
        );
        assertEq(n, cs.length);
    }

    function _creditsCasesFor(address who) internal view returns (Case[] memory cs) {
        bytes memory adminErr = _unauthorized(who, 0x00);
        cs = new Case[](5);
        uint256 n;
        cs[n++] = Case(
            "buyCreditsFor",
            address(credits),
            abi.encodeCall(
                SolversCredits.buyCreditsFor, (buyer2, AGENT, 5, 5 * uint256(PRICE_PER_USE), keccak256("p"))
            ),
            _unauthorized(who, PLATFORM_ROLE)
        );
        cs[n++] = Case(
            "consumeCredits",
            address(credits),
            abi.encodeCall(SolversCredits.consumeCredits, (AGENT, buyer, 1)),
            _unauthorized(who, USAGE_ROLE)
        );
        cs[n++] = Case(
            "recordUsageBatch",
            address(credits),
            abi.encodeCall(SolversCredits.recordUsageBatch, (AGENT, 1, bytes32(0))),
            _unauthorized(who, USAGE_ROLE)
        );
        cs[n++] = Case("sweepStray", address(credits), abi.encodeWithSignature("sweepStray(address)", who), adminErr);
        cs[n++] = Case("upgradeToAndCall", address(credits), _upgradeCall(), adminErr);
        assertEq(n, cs.length);
    }

    function _reviewsCases(address who) internal view returns (Case[] memory cs) {
        cs = new Case[](1);
        cs[0] = Case("upgradeToAndCall", address(reviews), _upgradeCall(), _unauthorized(who, 0x00));
    }

    function _escrowCases(address who) internal view returns (Case[] memory cs) {
        bytes memory adminErr = _unauthorized(who, 0x00);
        cs = new Case[](7);
        uint256 n;
        cs[n++] = Case(
            "createEscrowFor",
            address(escrow),
            abi.encodeCall(
                SolversEscrow.createEscrowFor, (buyer2, AGENT, _ms(3, MS_AMOUNT), WINDOW, 0, keccak256("p"))
            ),
            _unauthorized(who, PLATFORM_ROLE)
        );
        cs[n++] = Case(
            "markPassed",
            address(escrow),
            abi.encodeCall(SolversEscrow.markPassed, (escrowId, 0, bytes32(0))),
            _unauthorized(who, VERIFIER_ROLE)
        );
        cs[n++] = Case(
            "resolveDispute",
            address(escrow),
            abi.encodeCall(SolversEscrow.resolveDispute, (escrowId, 0, true)),
            adminErr
        );
        bytes memory notBuyer = abi.encodeWithSelector(SolversEscrow.NotBuyer.selector);
        cs[n++] = Case(
            "openDispute",
            address(escrow),
            abi.encodeCall(SolversEscrow.openDispute, (escrowId, 0, bytes32(0))),
            notBuyer
        );
        cs[n++] = Case(
            "cancelUndelivered",
            address(escrow),
            abi.encodeCall(SolversEscrow.cancelUndelivered, (escrowId, 0)),
            notBuyer
        );
        cs[n++] = Case("sweepStray", address(escrow), abi.encodeWithSignature("sweepStray(address)", who), adminErr);
        cs[n++] = Case("upgradeToAndCall", address(escrow), _upgradeCall(), adminErr);
        assertEq(n, cs.length);
    }

    function _stakingCases(address who) internal view returns (Case[] memory cs) {
        bytes memory adminErr = _unauthorized(who, 0x00);
        bytes memory notCreator = abi.encodeWithSelector(NotCreator.selector);
        cs = new Case[](12);
        uint256 n;
        cs[n++] = Case(
            "pullStake",
            address(staking),
            abi.encodeCall(SolversStaking.pullStake, (AGENT, creator, 1)),
            abi.encodeWithSelector(NotSatellite.selector)
        );
        cs[n++] =
            Case("topUpStake", address(staking), abi.encodeCall(SolversStaking.topUpStake, (AGENT, 1)), notCreator);
        cs[n++] = Case(
            "requestStakeExit", address(staking), abi.encodeCall(SolversStaking.requestStakeExit, (AGENT)), notCreator
        );
        cs[n++] = Case(
            "cancelStakeExit", address(staking), abi.encodeCall(SolversStaking.cancelStakeExit, (AGENT)), notCreator
        );
        cs[n++] =
            Case("withdrawStake", address(staking), abi.encodeCall(SolversStaking.withdrawStake, (AGENT)), notCreator);
        cs[n++] = Case(
            "contestSlash",
            address(staking),
            abi.encodeCall(SolversStaking.contestSlash, (AGENT, bytes32(0))),
            notCreator
        );
        cs[n++] = Case(
            "extendStakeExit",
            address(staking),
            abi.encodeCall(SolversStaking.extendStakeExit, (AGENT, bytes32(0))),
            adminErr
        );
        cs[n++] = Case(
            "proposeSlash",
            address(staking),
            abi.encodeCall(SolversStaking.proposeSlash, (AGENT, 1, bytes32(0))),
            adminErr
        );
        cs[n++] =
            Case("executeSlash", address(staking), abi.encodeCall(SolversStaking.executeSlash, (AGENT2)), adminErr);
        cs[n++] = Case(
            "cancelSlash",
            address(staking),
            abi.encodeCall(SolversStaking.cancelSlash, (AGENT2)),
            abi.encodeWithSelector(SolversStaking.NotAdmin.selector)
        );
        cs[n++] = Case("sweepStray", address(staking), abi.encodeWithSignature("sweepStray(address)", who), adminErr);
        cs[n++] = Case("upgradeToAndCall", address(staking), _upgradeCall(), adminErr);
        assertEq(n, cs.length);
    }

    /// @dev A slash on AGENT2 so `cancelSlash` / `executeSlash` reach their caller check.
    function _proposeSlashOnAgent2() internal {
        vm.prank(admin);
        staking.proposeSlash(AGENT2, 1, keccak256("r"));
    }

    function test_stranger_registry() public {
        _run(stranger, _registryCases(stranger));
    }

    function test_stranger_license() public {
        _run(stranger, _licenseCases(stranger));
    }

    function test_stranger_credits() public {
        _run(stranger, _creditsCasesFor(stranger));
    }

    function test_stranger_reviews() public {
        _run(stranger, _reviewsCases(stranger));
    }

    function test_stranger_escrow() public {
        _run(stranger, _escrowCases(stranger));
    }

    function test_stranger_staking() public {
        _proposeSlashOnAgent2();
        _run(stranger, _stakingCases(stranger));
    }

    /// @dev Every role holder is a stranger to the other roles: the guardian (pause-only) fails every gated function
    /// except setPause, and the other creator fails every creator-only function.
    function test_guardianIsStrangerEverywhereElse() public {
        _proposeSlashOnAgent2();
        Case[] memory r = _registryCases(guardian);
        Case[] memory rest = new Case[](r.length - 1);
        uint256 n;
        for (uint256 i; i < r.length; ++i) {
            if (keccak256(bytes(r[i].name)) == keccak256("setPause")) continue;
            rest[n++] = r[i];
        }
        _run(guardian, rest);
        _run(guardian, _licenseCases(guardian));
        _run(guardian, _creditsCasesFor(guardian));
        _run(guardian, _escrowCases(guardian));
        _run(guardian, _stakingCases(guardian));
    }

    function test_otherCreatorIsNotCreator() public {
        vm.startPrank(creator2);
        vm.expectRevert(NotCreator.selector);
        registry.updateVersion(AGENT, "2", bytes32(0));
        vm.expectRevert(NotCreator.selector);
        registry.updateMetadataUri(AGENT, "x");
        vm.expectRevert(NotCreator.selector);
        registry.updatePricing(AGENT, PRICE, 0);
        vm.expectRevert(NotCreator.selector);
        registry.setRoyaltyBps(AGENT, 0);
        vm.expectRevert(NotCreator.selector);
        registry.setSupplyCap(AGENT, 5);
        vm.expectRevert(NotCreator.selector);
        staking.topUpStake(AGENT, 1);
        vm.expectRevert(NotCreator.selector);
        staking.requestStakeExit(AGENT);
        vm.expectRevert(NotCreator.selector);
        staking.withdrawStake(AGENT);
        vm.stopPrank();
    }

    // =====================================================================================================
    // wrong role (each role is scoped; DEFAULT_ADMIN does not imply the operational roles)
    // =====================================================================================================

    function test_wrongRoles() public {
        uint256 creditsTotal = 5 * uint256(PRICE_PER_USE);
        // admin holds none of PLATFORM / VERIFIER / USAGE
        vm.startPrank(admin);
        vm.expectRevert(_unauthorized(admin, PLATFORM_ROLE));
        license.purchaseLicenseFor(buyer2, AGENT, PRICE, _pid());
        vm.expectRevert(_unauthorized(admin, PLATFORM_ROLE));
        credits.buyCreditsFor(buyer2, AGENT, 5, creditsTotal, _pid());
        vm.expectRevert(_unauthorized(admin, PLATFORM_ROLE));
        escrow.createEscrowFor(buyer2, AGENT, _ms(3, MS_AMOUNT), WINDOW, 0, _pid());
        vm.expectRevert(_unauthorized(admin, VERIFIER_ROLE));
        registry.setEval(AGENT, VERSION_HASH, 1, bytes32(0));
        vm.expectRevert(_unauthorized(admin, VERIFIER_ROLE));
        escrow.markPassed(escrowId, 0, bytes32(0));
        vm.expectRevert(_unauthorized(admin, USAGE_ROLE));
        credits.consumeCredits(AGENT, buyer, 1);
        vm.expectRevert(_unauthorized(admin, USAGE_ROLE));
        credits.recordUsageBatch(AGENT, 1, bytes32(0));
        vm.stopPrank();

        // PLATFORM without USAGE cannot consume; USAGE without PLATFORM cannot buy for others
        vm.prank(platformOnly);
        vm.expectRevert(_unauthorized(platformOnly, USAGE_ROLE));
        credits.consumeCredits(AGENT, buyer, 1);
        vm.prank(platformOnly);
        vm.expectRevert(_unauthorized(platformOnly, USAGE_ROLE));
        credits.recordUsageBatch(AGENT, 1, bytes32(0));
        vm.prank(usageOnly);
        vm.expectRevert(_unauthorized(usageOnly, PLATFORM_ROLE));
        credits.buyCreditsFor(buyer2, AGENT, 5, creditsTotal, _pid());

        // verifier cannot buy for others, platform cannot verify or administer
        vm.prank(verifier);
        vm.expectRevert(_unauthorized(verifier, PLATFORM_ROLE));
        license.purchaseLicenseFor(buyer2, AGENT, PRICE, _pid());
        vm.prank(platform);
        vm.expectRevert(_unauthorized(platform, VERIFIER_ROLE));
        escrow.markPassed(escrowId, 0, bytes32(0));
        vm.prank(platform);
        vm.expectRevert(_unauthorized(platform, 0x00));
        escrow.resolveDispute(escrowId, 0, true);
        vm.prank(platform);
        vm.expectRevert(SolversRegistry.NotPauseAuthority.selector);
        registry.setPause(1);
        vm.prank(verifier);
        vm.expectRevert(_unauthorized(verifier, 0x00));
        staking.proposeSlash(AGENT, 1, bytes32(0));
        vm.prank(guardian);
        vm.expectRevert(_unauthorized(guardian, 0x00));
        registry.suspendAgent(AGENT);
    }

    function test_satellitesCannotImpersonateEachOther() public {
        bytes memory notSat = abi.encodeWithSelector(NotSatellite.selector);
        address[4] memory notStaking = [address(license), address(credits), address(reviews), address(escrow)];
        for (uint256 i; i < notStaking.length; ++i) {
            vm.prank(notStaking[i]);
            vm.expectRevert(notSat);
            registry.setStake(AGENT, 0);
            vm.prank(notStaking[i]);
            vm.expectRevert(notSat);
            registry.setStatus(AGENT, AgentStatus.Active, notStaking[i]);
        }
        address[4] memory notEscrow = [address(license), address(credits), address(reviews), address(staking)];
        for (uint256 i; i < notEscrow.length; ++i) {
            vm.prank(notEscrow[i]);
            vm.expectRevert(notSat);
            registry.recordDisputeOpened(buyer);
            vm.prank(notEscrow[i]);
            vm.expectRevert(notSat);
            registry.recordDisputeOutcome(AGENT, buyer, true);
        }
        // only the Registry may pull a stake
        address[5] memory sats = [address(license), address(credits), address(reviews), address(escrow), admin];
        for (uint256 i; i < sats.length; ++i) {
            vm.prank(sats[i]);
            vm.expectRevert(notSat);
            staking.pullStake(AGENT, creator, 1);
        }
        // only Reviews may bind a license
        address[4] memory notReviews = [address(registry), address(credits), address(escrow), buyer];
        for (uint256 i; i < notReviews.length; ++i) {
            vm.prank(notReviews[i]);
            vm.expectRevert(SolversLicense.NotReviews.selector);
            license.useForReview(tokenId, buyer, AGENT, 1);
        }
    }

    // =====================================================================================================
    // success paths: Registry
    // =====================================================================================================

    function test_ok_grantAndRevokeRoles() public {
        address x = makeAddr("x");
        vm.expectEmit(address(registry));
        emit IAccessControl.RoleGranted(VERIFIER_ROLE, x, admin);
        vm.prank(admin);
        registry.grantRole(VERIFIER_ROLE, x);
        assertTrue(registry.hasRole(VERIFIER_ROLE, x));
        vm.prank(x);
        registry.setEval(AGENT, VERSION_HASH, 1, bytes32(0));
        vm.expectEmit(address(registry));
        emit IAccessControl.RoleRevoked(VERIFIER_ROLE, x, admin);
        vm.prank(admin);
        registry.revokeRole(VERIFIER_ROLE, x);
        vm.prank(x);
        vm.expectRevert(_unauthorized(x, VERIFIER_ROLE));
        registry.setEval(AGENT, VERSION_HASH, 1, bytes32(0));
        // a holder may renounce its own role
        vm.prank(guardian);
        registry.renounceRole(GUARDIAN_ROLE, guardian);
        vm.prank(guardian);
        vm.expectRevert(SolversRegistry.NotPauseAuthority.selector);
        registry.setPause(1);
    }

    function test_ok_satelliteOnlyRegistryFunctions() public {
        // recordDisputeOpened / recordDisputeOutcome (escrow)
        vm.expectEmit(address(registry));
        emit SolversRegistry.ReputationChanged(buyer2, 0, 1, 0);
        vm.prank(address(escrow));
        registry.recordDisputeOpened(buyer2);
        vm.prank(address(escrow));
        registry.recordDisputeOutcome(AGENT, buyer2, false);
        Reputation memory rep = registry.reputationOf(buyer2);
        assertEq(rep.disputesOpened, 1);
        assertEq(rep.disputesLost, 1);
        vm.prank(address(escrow));
        registry.recordDisputeOutcome(AGENT, buyer2, true);
        assertEq(registry.getAgent(AGENT).disputesLost, 1);

        // setStake / setStatus (staking)
        vm.expectEmit(address(registry));
        emit SolversRegistry.StakeChanged(AGENT, 123);
        vm.prank(address(staking));
        registry.setStake(AGENT, 123);
        assertEq(registry.stakeOf(AGENT), 123);
        vm.expectEmit(address(registry));
        emit SolversRegistry.AgentStatusChanged(AGENT, AgentStatus.Suspended, creator);
        vm.prank(address(staking));
        registry.setStatus(AGENT, AgentStatus.Suspended, creator);
        assertEq(uint8(registry.statusOf(AGENT)), uint8(AgentStatus.Suspended));

        // unknown agents are rejected even for the right satellite
        bytes32 unknown = bytes32(uint256(42));
        vm.prank(address(staking));
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, unknown));
        registry.setStake(unknown, 1);
        vm.prank(address(staking));
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, unknown));
        registry.setStatus(unknown, AgentStatus.Active, admin);
        vm.prank(address(escrow));
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, unknown));
        registry.recordDisputeOutcome(unknown, buyer, true);
    }

    // =====================================================================================================
    // success paths: License
    // =====================================================================================================

    function test_ok_purchaseLicenseFor() public {
        uint256 platformBefore = _bal(platform);
        vm.startPrank(platform);
        usd.approve(address(license), PRICE);
        uint256 id = license.purchaseLicenseFor(buyer2, AGENT, PRICE, _pid());
        vm.stopPrank();
        assertEq(license.ownerOf(id), buyer2);
        assertEq(platformBefore - _bal(platform), PRICE);
        vm.startPrank(platformOnly);
        usd.approve(address(license), PRICE);
        license.purchaseLicenseFor(stranger, AGENT, PRICE, _pid());
        vm.stopPrank();
    }

    function test_ok_setBaseURI() public {
        vm.expectEmit(address(license));
        emit SolversLicense.BaseURISet("https://new/");
        vm.prank(admin);
        license.setBaseURI("https://new/");
        assertEq(license.tokenURI(tokenId), "https://new/1");
    }

    function test_ok_useForReviewByReviews() public {
        vm.prank(address(reviews));
        uint64 bound = license.useForReview(tokenId, buyer, AGENT, 77);
        assertEq(bound, 77);
        (,,, uint64 reviewId) = license.licenseOf(tokenId);
        assertEq(reviewId, 77);
    }

    function test_ok_burnAndTransferByOwnerOrOperator() public {
        // approved operator moves the token, owner pays the royalty
        vm.startPrank(buyer);
        license.approve(stranger, tokenId);
        usd.approve(address(license), PRICE);
        vm.stopPrank();
        vm.prank(stranger);
        license.transferFrom(buyer, buyer2, tokenId);
        assertEq(license.ownerOf(tokenId), buyer2);
        // operator for all burns
        vm.prank(buyer2);
        license.setApprovalForAll(stranger, true);
        vm.prank(stranger);
        license.burn(tokenId);
        assertEq(license.balanceOf(buyer2), 0);
        // owner burns its own
        uint256 t2 = _buy(buyer, AGENT);
        vm.prank(buyer);
        license.burn(t2);
    }

    // =====================================================================================================
    // success paths: sweepStray on every vault
    // =====================================================================================================

    function test_ok_sweepStray() public {
        address[4] memory vaults = [address(license), address(credits), address(escrow), address(staking)];
        for (uint256 i; i < vaults.length; ++i) {
            uint256 lockedBefore = _bal(vaults[i]);
            vm.prank(stranger);
            usd.transfer(vaults[i], 1234);
            uint256 before = _bal(treasury);
            vm.prank(admin);
            (bool ok,) = vaults[i].call(abi.encodeWithSignature("sweepStray(address)", treasury));
            assertTrue(ok);
            assertEq(_bal(treasury) - before, 1234);
            assertEq(_bal(vaults[i]), lockedBefore); // locked funds (escrow, stake) never swept
        }
    }

    // =====================================================================================================
    // success paths: Credits
    // =====================================================================================================

    function test_ok_creditsRoles() public {
        uint256 total = 5 * uint256(PRICE_PER_USE);
        vm.startPrank(platformOnly);
        usd.approve(address(credits), total);
        credits.buyCreditsFor(buyer2, AGENT, 5, total, _pid());
        vm.stopPrank();
        (uint32 remaining,) = credits.creditsOf(AGENT, buyer2);
        assertEq(remaining, 5);
        vm.prank(usageOnly);
        credits.consumeCredits(AGENT, buyer2, 2);
        (remaining,) = credits.creditsOf(AGENT, buyer2);
        assertEq(remaining, 3);
        vm.prank(usageOnly);
        credits.recordUsageBatch(AGENT, 10, keccak256("root"));
        assertEq(credits.verifiedUsesOf(AGENT), 12);
    }

    // =====================================================================================================
    // success paths: Escrow
    // =====================================================================================================

    function test_ok_escrowRoles() public {
        vm.startPrank(platformOnly);
        usd.approve(address(escrow), 3 * uint256(MS_AMOUNT));
        uint256 id2 = escrow.createEscrowFor(buyer2, AGENT, _ms(3, MS_AMOUNT), WINDOW, 0, _pid());
        vm.stopPrank();
        (address b,,,,,,,) = escrow.escrowOf(id2);
        assertEq(b, buyer2);

        vm.prank(verifier);
        escrow.markPassed(escrowId, 0, keccak256("d"));
        vm.prank(buyer);
        escrow.openDispute(escrowId, 1, keccak256("r"));
        vm.prank(admin);
        escrow.resolveDispute(escrowId, 1, false);
        vm.warp(block.timestamp + 15 days);
        vm.prank(buyer);
        escrow.cancelUndelivered(escrowId, 2);
        (,,,,,,, SolversEscrow.Milestone[] memory ms) = escrow.escrowOf(escrowId);
        assertEq(uint8(ms[0].status), uint8(MilestoneStatus.Passed));
        assertEq(uint8(ms[1].status), uint8(MilestoneStatus.Approved));
        assertEq(uint8(ms[2].status), uint8(MilestoneStatus.Refunded));
    }

    // =====================================================================================================
    // success paths: Staking
    // =====================================================================================================

    function test_ok_pullStakeByRegistryOnly() public {
        vm.prank(creator2);
        usd.approve(address(staking), 7);
        uint256 before = staking.totalStaked();
        vm.prank(address(registry));
        uint96 got = staking.pullStake(AGENT2, creator2, 7);
        assertEq(got, 7);
        assertEq(staking.totalStaked() - before, 7);
    }

    function test_ok_stakingCreatorAndAdminPaths() public {
        vm.startPrank(creator);
        usd.approve(address(staking), 5);
        staking.topUpStake(AGENT, 5);
        staking.requestStakeExit(AGENT);
        staking.cancelStakeExit(AGENT);
        vm.stopPrank();
        assertEq(uint8(registry.statusOf(AGENT)), uint8(AgentStatus.Suspended));

        vm.prank(admin);
        staking.proposeSlash(AGENT, 5, keccak256("r"));
        vm.prank(creator);
        staking.contestSlash(AGENT, keccak256("c"));
        vm.warp(block.timestamp + staking.SLASH_DELAY());
        vm.prank(admin);
        staking.executeSlash(AGENT);
        assertEq(registry.stakeOf(AGENT), MIN_STAKE);

        // creator cancels an expired slash; admin cancels any time
        vm.prank(admin);
        staking.proposeSlash(AGENT, 1, keccak256("r"));
        vm.warp(block.timestamp + staking.SLASH_DELAY() + staking.SLASH_EXPIRY_GRACE());
        vm.prank(creator);
        staking.cancelSlash(AGENT);
        vm.prank(admin);
        staking.proposeSlash(AGENT, 1, keccak256("r"));
        vm.prank(admin);
        staking.cancelSlash(AGENT);

        vm.prank(creator);
        staking.requestStakeExit(AGENT);
        vm.prank(admin);
        staking.extendStakeExit(AGENT, keccak256("open dispute"));
        vm.warp(block.timestamp + 2 * staking.STAKE_EXIT_DELAY());
        uint256 before = _bal(creator);
        vm.prank(creator);
        staking.withdrawStake(AGENT);
        assertEq(_bal(creator) - before, MIN_STAKE);
    }

    // =====================================================================================================
    // DEFAULT_ADMIN_ROLE is guarded by AccessControlDefaultAdminRules
    // =====================================================================================================

    function test_defaultAdminCannotBeGrantedOrRevokedDirectly() public {
        vm.startPrank(admin);
        vm.expectRevert(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminRules.selector);
        registry.grantRole(0x00, stranger);
        vm.expectRevert(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminRules.selector);
        registry.revokeRole(0x00, admin);
        vm.stopPrank();
        assertFalse(registry.hasRole(0x00, stranger));
        assertEq(registry.defaultAdmin(), admin);
    }
}
