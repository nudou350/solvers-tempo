// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ITIP20} from "tempo-std/interfaces/ITIP20.sol";
import {ITIP403Registry} from "tempo-std/interfaces/ITIP403Registry.sol";
import {StdPrecompiles} from "tempo-std/StdPrecompiles.sol";

import {SolversTestBase, IReceivePolicies} from "./utils/SolversTestBase.sol";
import {SolversEscrow} from "../src/SolversEscrow.sol";
import {SolversPayouts} from "../src/base/SolversPayouts.sol";
import {SolversRegistry} from "../src/SolversRegistry.sol";
import {Reputation, AgentView} from "../src/interfaces/ISolversRegistry.sol";
import {
    MilestoneStatus,
    EscrowStatus,
    SaleKind,
    PLATFORM_ROLE,
    VERIFIER_ROLE,
    PAUSE_ENTRIES,
    PAUSE_PAYMENTS,
    PAUSE_TRANSFERS,
    Paused,
    PriceTooLow,
    InvalidAmount,
    AgentNotFound,
    NothingToClaim,
    RecipientBlocked,
    ZeroAddress
} from "../src/SolversTypes.sol";

/// @notice Shared escrow fixture: an Active agent, helpers to create escrows, move milestones and read state.
abstract contract EscrowFixture is SolversTestBase {
    uint256 internal constant T0 = 1_000_000;
    uint32 internal constant WINDOW = 1 days;
    uint256 internal constant DEFAULT_DEADLINE = T0 + 14 days;
    uint96 internal constant M0 = 3_000_000;
    uint96 internal constant M1 = 4_000_000;

    function setUp() public virtual override {
        super.setUp();
        vm.warp(T0);
        _registerActive(creator, AGENT);
    }

    // ---- milestone inputs ----

    function _inputs(uint96[] memory amounts) internal pure returns (SolversEscrow.MilestoneInput[] memory ms) {
        ms = new SolversEscrow.MilestoneInput[](amounts.length);
        for (uint256 i; i < amounts.length; ++i) {
            ms[i] =
                SolversEscrow.MilestoneInput({amount: amounts[i], criteriaHash: keccak256(abi.encode("criteria", i))});
        }
    }

    function _amounts1(uint96 a) internal pure returns (uint96[] memory r) {
        r = new uint96[](1);
        r[0] = a;
    }

    function _amounts2(uint96 a, uint96 b) internal pure returns (uint96[] memory r) {
        r = new uint96[](2);
        r[0] = a;
        r[1] = b;
    }

    function _amountsN(uint256 n, uint96 each) internal pure returns (uint96[] memory r) {
        r = new uint96[](n);
        for (uint256 i; i < n; ++i) {
            r[i] = each;
        }
    }

    function _sum(SolversEscrow.MilestoneInput[] memory ms) internal pure returns (uint256 total) {
        for (uint256 i; i < ms.length; ++i) {
            total += ms[i].amount;
        }
    }

    // ---- create ----

    function _createWith(
        address who,
        bytes32 agentId,
        SolversEscrow.MilestoneInput[] memory ms,
        uint32 window,
        uint16 days_
    ) internal returns (uint256 id) {
        vm.startPrank(who);
        usd.approve(address(escrow), _sum(ms));
        id = escrow.createEscrow(agentId, ms, window, days_, _pid());
        vm.stopPrank();
    }

    function _create(uint96[] memory amounts) internal returns (uint256) {
        return _createWith(buyer, AGENT, _inputs(amounts), WINDOW, 0);
    }

    /// @dev Two milestones (3 + 4 USD), window 1 day, default 14-day delivery deadline.
    function _createDefault() internal returns (uint256) {
        return _create(_amounts2(M0, M1));
    }

    // ---- actions ----

    function _pass(uint256 id, uint8 i) internal {
        vm.prank(verifier);
        escrow.markPassed(id, i, keccak256(abi.encode("deliverable", id, i)));
    }

    function _dispute(uint256 id, uint8 i) internal {
        vm.prank(buyer);
        escrow.openDispute(id, i, keccak256(abi.encode("reason", id, i)));
    }

    function _resolve(uint256 id, uint8 i, bool refund) internal {
        vm.prank(admin);
        escrow.resolveDispute(id, i, refund);
    }

    function _releaseAs(address who, uint256 id, uint8 i) internal {
        vm.prank(who);
        escrow.releaseMilestone(id, i);
    }

    function _pause(uint8 flags) internal {
        vm.prank(admin);
        registry.setPause(flags);
    }

    // ---- reads ----

    function _ms(uint256 id) internal view returns (SolversEscrow.Milestone[] memory ms) {
        (,,,,,,, ms) = escrow.escrowOf(id);
    }

    function _m(uint256 id, uint256 i) internal view returns (SolversEscrow.Milestone memory) {
        return _ms(id)[i];
    }

    function _mstatus(uint256 id, uint256 i) internal view returns (MilestoneStatus) {
        return _m(id, i).status;
    }

    function _deadline(uint256 id) internal view returns (uint256 d) {
        (,,,,,, uint40 dl,) = escrow.escrowOf(id);
        d = dl;
    }

    function _rep(address who) internal view returns (Reputation memory) {
        return registry.reputationOf(who);
    }

    function _agentDisputesLost(bytes32 agentId) internal view returns (uint32) {
        return registry.getAgent(agentId).disputesLost;
    }

    /// @dev The vault invariant: the escrow holds exactly the locked milestones plus deferred credits.
    function _assertVault() internal view {
        assertEq(_bal(address(escrow)), escrow.lockedBalance() + escrow.totalDeferred(), "vault == locked + deferred");
    }

    function _invalid(MilestoneStatus s) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SolversEscrow.InvalidMilestoneStatus.selector, s);
    }

    // ---- TIP-403 receive policy helpers with an undo (the base helper does not return the policy id) ----

    function _blockReceivesUndoable(address account) internal returns (uint64 pid) {
        pid = StdPrecompiles.TIP403_REGISTRY.createPolicy(account, ITIP403Registry.PolicyType.WHITELIST);
        vm.prank(account);
        IReceivePolicies(address(StdPrecompiles.TIP403_REGISTRY)).setReceivePolicy(pid, 1, address(0));
    }

    /// @dev Lets `sender` deliver to `account` again (the account administers its own whitelist).
    function _allowSender(address account, uint64 pid, address sender) internal {
        vm.prank(account);
        StdPrecompiles.TIP403_REGISTRY.modifyPolicyWhitelist(pid, sender, true);
    }

    function _blacklistUndoable(address account) internal returns (uint64 pid) {
        pid = StdPrecompiles.TIP403_REGISTRY.createPolicy(address(this), ITIP403Registry.PolicyType.BLACKLIST);
        StdPrecompiles.TIP403_REGISTRY.modifyPolicyBlacklist(pid, account, true);
        token.changeTransferPolicyId(pid);
    }

    function _unblacklist(uint64 pid, address account) internal {
        StdPrecompiles.TIP403_REGISTRY.modifyPolicyBlacklist(pid, account, false);
    }

    // ---- EIP-2612 ----

    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(token.name())),
                keccak256("1"),
                block.chainid,
                address(token)
            )
        );
    }

    function _signPermit(uint256 pk, address owner, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, token.nonces(owner), deadline));
        (v, r, s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash)));
    }
}

contract EscrowTest is EscrowFixture {
    // =====================================================================================================
    // create: validations
    // =====================================================================================================

    function test_create_rejectsZeroMilestones() public {
        SolversEscrow.MilestoneInput[] memory ms = new SolversEscrow.MilestoneInput[](0);
        vm.prank(buyer);
        vm.expectRevert(SolversEscrow.InvalidMilestones.selector);
        escrow.createEscrow(AGENT, ms, WINDOW, 0, _pid());
    }

    function test_create_rejectsSixMilestones() public {
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amountsN(6, 1_000_000));
        vm.startPrank(buyer);
        usd.approve(address(escrow), 6_000_000);
        vm.expectRevert(SolversEscrow.InvalidMilestones.selector);
        escrow.createEscrow(AGENT, ms, WINDOW, 0, _pid());
        vm.stopPrank();
    }

    function test_create_acceptsFiveMilestones() public {
        uint256 id = _create(_amountsN(5, 1_000_000));
        assertEq(_ms(id).length, 5);
        assertEq(escrow.lockedBalance(), 5_000_000);
    }

    function test_create_rejectsZeroAmountMilestone() public {
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts2(6_000_000, 0));
        vm.startPrank(buyer);
        usd.approve(address(escrow), 6_000_000);
        vm.expectRevert(InvalidAmount.selector);
        escrow.createEscrow(AGENT, ms, WINDOW, 0, _pid());
        vm.stopPrank();
    }

    function test_create_rejectsTotalAboveUint96() public {
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts2(type(uint96).max, 1));
        vm.prank(buyer);
        vm.expectRevert(InvalidAmount.selector);
        escrow.createEscrow(AGENT, ms, WINDOW, 0, _pid());
    }

    function test_create_reviewWindowBounds() public {
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts1(5_000_000));
        vm.startPrank(buyer);
        usd.approve(address(escrow), type(uint256).max);
        vm.expectRevert(SolversEscrow.InvalidReviewWindow.selector);
        escrow.createEscrow(AGENT, ms, 59, 0, _pid());
        vm.expectRevert(SolversEscrow.InvalidReviewWindow.selector);
        escrow.createEscrow(AGENT, ms, 30 days + 1, 0, _pid());
        vm.expectRevert(SolversEscrow.InvalidReviewWindow.selector);
        escrow.createEscrow(AGENT, ms, 0, 0, _pid());
        uint256 a = escrow.createEscrow(AGENT, ms, 60, 0, _pid());
        uint256 b = escrow.createEscrow(AGENT, ms, 30 days, 0, _pid());
        vm.stopPrank();
        (,,,,, uint32 wa,,) = escrow.escrowOf(a);
        (,,,,, uint32 wb,,) = escrow.escrowOf(b);
        assertEq(wa, 60);
        assertEq(wb, 30 days);
    }

    function test_create_deliveryDays() public {
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts1(5_000_000));
        vm.startPrank(buyer);
        usd.approve(address(escrow), type(uint256).max);
        vm.expectRevert(SolversEscrow.InvalidDeliveryDays.selector);
        escrow.createEscrow(AGENT, ms, WINDOW, 61, _pid());
        uint256 d0 = escrow.createEscrow(AGENT, ms, WINDOW, 0, _pid());
        uint256 d1 = escrow.createEscrow(AGENT, ms, WINDOW, 1, _pid());
        uint256 d60 = escrow.createEscrow(AGENT, ms, WINDOW, 60, _pid());
        vm.stopPrank();
        assertEq(_deadline(d0), T0 + 14 days, "0 days -> default 14");
        assertEq(_deadline(d1), T0 + 1 days);
        assertEq(_deadline(d60), T0 + 60 days);
    }

    function test_create_priceTooLow() public {
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts2(2_000_000, MIN_PRICE - 2_000_001));
        vm.startPrank(buyer);
        usd.approve(address(escrow), MIN_PRICE);
        vm.expectRevert(PriceTooLow.selector);
        escrow.createEscrow(AGENT, ms, WINDOW, 0, _pid());
        vm.stopPrank();
        // exactly minPrice is accepted
        uint256 id = _create(_amounts2(2_000_000, MIN_PRICE - 2_000_000));
        (,,, uint96 total,,,,) = escrow.escrowOf(id);
        assertEq(total, MIN_PRICE);
    }

    function test_create_buyerNotEligibleAfterThreeLostDisputes() public {
        uint256 id = _create(_amountsN(3, 2_000_000));
        for (uint8 i; i < 3; ++i) {
            _dispute(id, i);
            _resolve(id, i, false); // buyer loses
            if (i < 2) {
                // 1 and 2 lost disputes: still eligible
                _create(_amounts1(5_000_000));
            }
        }
        assertEq(_rep(buyer).disputesLost, 3);
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts1(5_000_000));
        vm.startPrank(buyer);
        usd.approve(address(escrow), 5_000_000);
        vm.expectRevert(SolversRegistry.BuyerNotEligible.selector);
        escrow.createEscrow(AGENT, ms, WINDOW, 0, _pid());
        vm.stopPrank();

        // the platform cannot route around it either: eligibility is the buyer's, not the payer's
        vm.startPrank(platform);
        usd.approve(address(escrow), 5_000_000);
        vm.expectRevert(SolversRegistry.BuyerNotEligible.selector);
        escrow.createEscrowFor(buyer, AGENT, ms, WINDOW, 0, _pid());
        // another buyer is unaffected
        escrow.createEscrowFor(buyer2, AGENT, ms, WINDOW, 0, _pid());
        vm.stopPrank();
    }

    function test_create_inactiveAgent() public {
        _register(creator2, AGENT2, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS); // Pending
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts1(5_000_000));
        vm.startPrank(buyer);
        usd.approve(address(escrow), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentNotActive.selector, AGENT2));
        escrow.createEscrow(AGENT2, ms, WINDOW, 0, _pid());
        vm.stopPrank();

        vm.prank(admin);
        registry.suspendAgent(AGENT);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentNotActive.selector, AGENT));
        escrow.createEscrow(AGENT, ms, WINDOW, 0, _pid());

        bytes32 unknown = bytes32(uint256(0xdead));
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, unknown));
        escrow.createEscrow(unknown, ms, WINDOW, 0, _pid());
    }

    function test_suspendedAgent_existingEscrowStillSettles() public {
        uint256 id = _createDefault();
        vm.prank(admin);
        registry.suspendAgent(AGENT);
        _pass(id, 0);
        _releaseAs(buyer, id, 0);
        _dispute(id, 1);
        _resolve(id, 1, true);
        assertEq(uint8(escrow.statusOf(id)), uint8(EscrowStatus.Completed));
        assertEq(escrow.lockedBalance(), 0);
    }

    function test_create_pausedEntries() public {
        _pause(PAUSE_ENTRIES);
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts1(5_000_000));
        vm.startPrank(buyer);
        usd.approve(address(escrow), 5_000_000);
        vm.expectRevert(abi.encodeWithSelector(Paused.selector, PAUSE_ENTRIES));
        escrow.createEscrow(AGENT, ms, WINDOW, 0, _pid());
        vm.stopPrank();

        vm.startPrank(platform);
        usd.approve(address(escrow), 5_000_000);
        vm.expectRevert(abi.encodeWithSelector(Paused.selector, PAUSE_ENTRIES));
        escrow.createEscrowFor(buyer, AGENT, ms, WINDOW, 0, _pid());
        vm.stopPrank();

        // PAYMENTS / TRANSFERS do not block creation
        _pause(PAUSE_PAYMENTS | PAUSE_TRANSFERS);
        _create(_amounts1(5_000_000));
    }

    function test_create_duplicatePurchaseId() public {
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts1(5_000_000));
        bytes32 pid = keccak256("same-purchase");
        vm.startPrank(buyer);
        usd.approve(address(escrow), 10_000_000);
        uint256 id = escrow.createEscrow(AGENT, ms, WINDOW, 0, pid);
        bytes32 ref = bytes32((uint256(uint8(SaleKind.Escrow)) << 248) | id);
        assertEq(registry.purchaseRef(buyer, pid), ref);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.DuplicatePurchase.selector, pid, ref));
        escrow.createEscrow(AGENT, ms, WINDOW, 0, pid);
        vm.stopPrank();

        // also across kinds: a license purchase id cannot fund an escrow
        bytes32 pid2 = keccak256("license-purchase");
        vm.startPrank(buyer2);
        usd.approve(address(license), PRICE);
        uint256 tokenId = license.purchaseLicense(AGENT, PRICE, pid2);
        usd.approve(address(escrow), 5_000_000);
        bytes32 lref = bytes32((uint256(uint8(SaleKind.License)) << 248) | tokenId);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.DuplicatePurchase.selector, pid2, lref));
        escrow.createEscrow(AGENT, ms, WINDOW, 0, pid2);
        vm.stopPrank();
    }

    function test_create_zeroPurchaseId() public {
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts1(5_000_000));
        vm.startPrank(buyer);
        usd.approve(address(escrow), 5_000_000);
        vm.expectRevert(SolversRegistry.InvalidPurchaseId.selector);
        escrow.createEscrow(AGENT, ms, WINDOW, 0, bytes32(0));
        vm.stopPrank();
    }

    function test_create_withoutAllowanceReverts() public {
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts1(5_000_000));
        vm.prank(buyer);
        vm.expectRevert(ITIP20.InsufficientAllowance.selector);
        escrow.createEscrow(AGENT, ms, WINDOW, 0, _pid());
        assertEq(escrow.escrowCount(), 0);
    }

    // =====================================================================================================
    // create: deposit, state, events
    // =====================================================================================================

    function test_create_depositIsBalanceDiffAndStateIsWritten() public {
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts2(M0, M1));
        bytes32 pid = keccak256("p1");
        uint256 buyerBefore = _bal(buyer);
        vm.startPrank(buyer);
        usd.approve(address(escrow), M0 + M1);
        vm.expectEmit(address(escrow));
        emit SolversEscrow.EscrowCreated(1, AGENT, buyer, buyer, M0 + M1, FEE_BPS, pid);
        uint256 id = escrow.createEscrow(AGENT, ms, WINDOW, 3, pid);
        vm.stopPrank();

        assertEq(id, 1);
        assertEq(escrow.escrowCount(), 1);
        assertEq(buyerBefore - _bal(buyer), M0 + M1);
        assertEq(_bal(address(escrow)), M0 + M1);
        assertEq(escrow.lockedBalance(), M0 + M1);
        _assertVault();

        (
            address b,
            bytes32 agentId,
            address c,
            uint96 total,
            uint16 feeBps,
            uint32 window,
            uint40 deadline,
            SolversEscrow.Milestone[] memory got
        ) = escrow.escrowOf(id);
        assertEq(b, buyer);
        assertEq(agentId, AGENT);
        assertEq(c, creator);
        assertEq(total, M0 + M1);
        assertEq(feeBps, FEE_BPS);
        assertEq(window, WINDOW);
        assertEq(deadline, T0 + 3 days);
        assertEq(got.length, 2);
        for (uint256 i; i < 2; ++i) {
            assertEq(got[i].amount, ms[i].amount);
            assertEq(uint8(got[i].status), uint8(MilestoneStatus.Pending));
            assertEq(got[i].passedAt, 0);
            assertEq(got[i].disputedAt, 0);
            assertEq(got[i].criteriaHash, ms[i].criteriaHash);
            assertEq(got[i].deliverableHash, bytes32(0));
            assertEq(got[i].disputeReasonHash, bytes32(0));
        }
        assertEq(uint8(escrow.statusOf(id)), uint8(EscrowStatus.Active));
        assertEq(escrow.autoReleaseAt(id), 0);
        // escrows do not count as purchases in the buyer reputation (as in the old program)
        assertEq(_rep(buyer).purchases, 0);
    }

    function test_create_doesNotEmitStatusChanged() public {
        vm.recordLogs();
        uint256 id = _createDefault();
        assertEq(_countStatusLogs(vm.getRecordedLogs(), id), 0);
    }

    function test_createFor_platformPaysBuyerOwns() public {
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts2(M0, M1));
        bytes32 pid = keccak256("pix-charge");
        uint256 platformBefore = _bal(platform);
        uint256 buyerBefore = _bal(buyer);
        vm.startPrank(platform);
        usd.approve(address(escrow), M0 + M1);
        vm.expectEmit(address(escrow));
        emit SolversEscrow.EscrowCreated(1, AGENT, buyer, platform, M0 + M1, FEE_BPS, pid);
        uint256 id = escrow.createEscrowFor(buyer, AGENT, ms, WINDOW, 0, pid);
        vm.stopPrank();

        (address b,,,,,,,) = escrow.escrowOf(id);
        assertEq(b, buyer);
        assertEq(platformBefore - _bal(platform), M0 + M1);
        assertEq(_bal(buyer), buyerBefore);
        assertEq(escrow.lockedBalance(), M0 + M1);

        // the buyer (not the platform) controls the escrow and receives refunds
        vm.prank(platform);
        vm.expectRevert(SolversEscrow.NotBuyer.selector);
        escrow.openDispute(id, 0, bytes32(0));
        _dispute(id, 0);
        _resolve(id, 0, true);
        assertEq(_bal(buyer) - buyerBefore, M0);
        assertEq(_rep(buyer).disputesOpened, 1);
        assertEq(_rep(platform).disputesOpened, 0);
    }

    function test_createFor_onlyPlatform() public {
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts1(5_000_000));
        address[3] memory others = [buyer, verifier, admin];
        for (uint256 i; i < others.length; ++i) {
            vm.startPrank(others[i]);
            usd.approve(address(escrow), 5_000_000);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector, others[i], PLATFORM_ROLE
                )
            );
            escrow.createEscrowFor(buyer, AGENT, ms, WINDOW, 0, _pid());
            vm.stopPrank();
        }
    }

    function test_createFor_zeroBuyer() public {
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts1(5_000_000));
        vm.startPrank(platform);
        usd.approve(address(escrow), 5_000_000);
        vm.expectRevert(ZeroAddress.selector);
        escrow.createEscrowFor(address(0), AGENT, ms, WINDOW, 0, _pid());
        vm.stopPrank();
    }

    function test_createWithPermit_realSignature() public {
        (address signer, uint256 pk) = makeAddrAndKey("permit-buyer");
        token.mint(signer, 100_000_000);
        assertEq(token.DOMAIN_SEPARATOR(), _domainSeparator(), "EIP712Domain(name,\"1\",chainId,token)");

        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts2(M0, M1));
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(pk, signer, address(escrow), M0 + M1, deadline);
        assertTrue(v == 27 || v == 28);
        assertEq(usd.allowance(signer, address(escrow)), 0);

        vm.prank(signer);
        uint256 id = escrow.createEscrowWithPermit(AGENT, ms, WINDOW, 0, _pid(), deadline, v, r, s);
        (address b,,, uint96 total,,,,) = escrow.escrowOf(id);
        assertEq(b, signer);
        assertEq(total, M0 + M1);
        assertEq(token.nonces(signer), 1);
        assertEq(usd.allowance(signer, address(escrow)), 0, "permit allowance fully consumed");
        assertEq(_bal(signer), 100_000_000 - (M0 + M1));
        assertEq(escrow.lockedBalance(), M0 + M1);
    }

    function test_createWithPermit_badSignatureFallsBackToAllowance() public {
        (address signer, uint256 pk) = makeAddrAndKey("permit-buyer");
        token.mint(signer, 100_000_000);
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts2(M0, M1));
        uint256 deadline = block.timestamp + 1 hours;
        // signed for the wrong value: the permit fails and is ignored
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(pk, signer, address(escrow), 1, deadline);

        vm.prank(signer);
        vm.expectRevert(ITIP20.InsufficientAllowance.selector);
        escrow.createEscrowWithPermit(AGENT, ms, WINDOW, 0, _pid(), deadline, v, r, s);

        vm.startPrank(signer);
        usd.approve(address(escrow), M0 + M1);
        escrow.createEscrowWithPermit(AGENT, ms, WINDOW, 0, _pid(), deadline, v, r, s);
        vm.stopPrank();
        assertEq(token.nonces(signer), 0);
        assertEq(escrow.lockedBalance(), M0 + M1);
    }

    function test_createWithPermit_expiredPermitIgnored() public {
        (address signer, uint256 pk) = makeAddrAndKey("permit-buyer");
        token.mint(signer, 100_000_000);
        SolversEscrow.MilestoneInput[] memory ms = _inputs(_amounts1(5_000_000));
        uint256 deadline = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(pk, signer, address(escrow), 5_000_000, deadline);
        vm.prank(signer);
        vm.expectRevert(ITIP20.InsufficientAllowance.selector);
        escrow.createEscrowWithPermit(AGENT, ms, WINDOW, 0, _pid(), deadline, v, r, s);
    }

    // =====================================================================================================
    // money
    // =====================================================================================================

    function test_release_paysCreatorMinusFloorFee() public {
        // 5_000_009 @ 1000 bps -> fee 500_000 (floor of 500_000.9), creator 4_500_009
        uint256 id = _create(_amounts2(5_000_009, 1_234_567));
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);
        uint256 locked0 = escrow.lockedBalance();

        vm.expectEmit(address(escrow));
        emit SolversEscrow.MilestoneUpdated(id, 0, MilestoneStatus.Approved, buyer, bytes32(0));
        vm.expectEmit(address(escrow));
        emit SolversEscrow.MilestonePaid(id, 0, creator, 5_000_009, 500_000, false);
        _releaseAs(buyer, id, 0);

        assertEq(_bal(creator) - c0, 4_500_009);
        assertEq(_bal(treasury) - t0, 500_000);
        assertEq(locked0 - escrow.lockedBalance(), 5_000_009);
        assertEq(_bal(address(escrow)), 1_234_567);
        _assertVault();

        // 1_234_567 @ 1000 -> 123_456 / 1_111_111
        _pass(id, 1);
        vm.warp(block.timestamp + WINDOW);
        _releaseAs(stranger, id, 1);
        assertEq(_bal(creator) - c0, 4_500_009 + 1_111_111);
        assertEq(_bal(treasury) - t0, 500_000 + 123_456);
        assertEq(escrow.lockedBalance(), 0);
        assertEq(_bal(address(escrow)), 0);
    }

    function test_resolvePay_paysCreatorWithFee() public {
        uint256 id = _create(_amounts2(5_000_009, 1_000_000));
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);
        uint256 b0 = _bal(buyer);
        _dispute(id, 0);
        vm.expectEmit(address(escrow));
        emit SolversEscrow.DisputeResolved(id, 0, false, admin);
        vm.expectEmit(address(escrow));
        emit SolversEscrow.MilestonePaid(id, 0, creator, 5_000_009, 500_000, false);
        _resolve(id, 0, false);
        assertEq(_bal(creator) - c0, 4_500_009);
        assertEq(_bal(treasury) - t0, 500_000);
        assertEq(_bal(buyer), b0);
        assertEq(escrow.lockedBalance(), 1_000_000);
        _assertVault();
    }

    function test_refunds_payFullAmountWithoutFee() public {
        uint256 id = _create(_amountsN(3, 2_000_003));
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);
        uint256 b0 = _bal(buyer);

        // 1) admin refund
        _dispute(id, 0);
        vm.expectEmit(address(escrow));
        emit SolversEscrow.MilestoneRefunded(id, 0, buyer, 2_000_003, false);
        _resolve(id, 0, true);
        assertEq(_bal(buyer) - b0, 2_000_003);
        assertEq(escrow.lockedBalance(), 2 * 2_000_003);

        // 2) stale dispute refund
        _dispute(id, 1);
        vm.warp(DEFAULT_DEADLINE + 1);
        vm.expectEmit(address(escrow));
        emit SolversEscrow.MilestoneRefunded(id, 1, buyer, 2_000_003, false);
        vm.prank(stranger);
        escrow.resolveStaleDispute(id, 1);
        assertEq(_bal(buyer) - b0, 2 * 2_000_003);

        // 3) cancel undelivered
        vm.expectEmit(address(escrow));
        emit SolversEscrow.MilestoneRefunded(id, 2, buyer, 2_000_003, false);
        vm.prank(buyer);
        escrow.cancelUndelivered(id, 2);
        assertEq(_bal(buyer) - b0, 3 * 2_000_003);

        assertEq(_bal(creator), c0);
        assertEq(_bal(treasury), t0);
        assertEq(escrow.lockedBalance(), 0);
        assertEq(_bal(address(escrow)), 0);
        assertEq(uint8(escrow.statusOf(id)), uint8(EscrowStatus.Refunded));
    }

    function test_feeFrozenAtCreation() public {
        uint256 oldId = _create(_amounts2(5_000_000, 5_000_000));
        address newTreasury = makeAddr("newTreasury");
        vm.prank(admin);
        registry.setConfig(newTreasury, 2000, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE);

        (,,,, uint16 frozen,,,) = escrow.escrowOf(oldId);
        assertEq(frozen, FEE_BPS);

        uint256 c0 = _bal(creator);
        _releaseAs(buyer, oldId, 0);
        // old fee (10%), paid to the CURRENT treasury (read at payout time, as in the old program)
        assertEq(_bal(creator) - c0, 4_500_000);
        assertEq(_bal(newTreasury), 500_000);

        _dispute(oldId, 1);
        _resolve(oldId, 1, false);
        assertEq(_bal(creator) - c0, 9_000_000);
        assertEq(_bal(newTreasury), 1_000_000);

        uint256 newId = _create(_amounts1(5_000_000));
        (,,,, uint16 fresh,,,) = escrow.escrowOf(newId);
        assertEq(fresh, 2000);
        _releaseAs(buyer, newId, 0);
        assertEq(_bal(creator) - c0, 13_000_000);
        assertEq(_bal(newTreasury), 2_000_000);
    }

    function test_zeroFee_paysEverythingToCreator() public {
        vm.prank(admin);
        registry.setConfig(treasury, 0, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE);
        uint256 id = _create(_amounts1(5_000_001));
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);
        vm.expectEmit(address(escrow));
        emit SolversEscrow.MilestonePaid(id, 0, creator, 5_000_001, 0, false);
        _releaseAs(buyer, id, 0);
        assertEq(_bal(creator) - c0, 5_000_001);
        assertEq(_bal(treasury), t0);
    }

    // =====================================================================================================
    // reputation
    // =====================================================================================================

    function test_reputation_openDisputeCountsForBuyer() public {
        uint256 id = _createDefault();
        _dispute(id, 0);
        assertEq(_rep(buyer).disputesOpened, 1);
        _pass(id, 1);
        _dispute(id, 1);
        assertEq(_rep(buyer).disputesOpened, 2);
        assertEq(_rep(buyer).disputesLost, 0);
        assertEq(_agentDisputesLost(AGENT), 0);
    }

    function test_reputation_refundAgentLoses() public {
        uint256 id = _createDefault();
        _dispute(id, 0);
        vm.expectEmit(address(registry));
        emit SolversRegistry.AgentDisputeLost(AGENT, 1);
        _resolve(id, 0, true);
        assertEq(_agentDisputesLost(AGENT), 1);
        assertEq(_rep(buyer).disputesLost, 0);
        assertEq(_rep(buyer).disputesOpened, 1);
    }

    function test_reputation_payBuyerLoses() public {
        uint256 id = _createDefault();
        _dispute(id, 0);
        vm.expectEmit(address(registry));
        emit SolversRegistry.ReputationChanged(buyer, 0, 1, 1);
        _resolve(id, 0, false);
        assertEq(_rep(buyer).disputesLost, 1);
        assertEq(_agentDisputesLost(AGENT), 0);
    }

    function test_reputation_staleDisputeChangesNothing() public {
        uint256 id = _createDefault();
        _dispute(id, 0);
        Reputation memory before = _rep(buyer);
        vm.warp(DEFAULT_DEADLINE + 1);
        vm.recordLogs();
        vm.prank(stranger);
        escrow.resolveStaleDispute(id, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != address(registry), "no registry event on a stale refund");
        }
        Reputation memory afterRep = _rep(buyer);
        assertEq(afterRep.disputesOpened, before.disputesOpened);
        assertEq(afterRep.disputesLost, before.disputesLost);
        assertEq(afterRep.purchases, before.purchases);
        assertEq(_agentDisputesLost(AGENT), 0);
    }

    function test_reputation_cancelUndeliveredChangesNothing() public {
        uint256 id = _createDefault();
        vm.warp(DEFAULT_DEADLINE + 1);
        vm.prank(buyer);
        escrow.cancelUndelivered(id, 0);
        assertEq(_rep(buyer).disputesOpened, 0);
        assertEq(_rep(buyer).disputesLost, 0);
        assertEq(_agentDisputesLost(AGENT), 0);
    }

    // =====================================================================================================
    // access and lookups
    // =====================================================================================================

    function test_markPassed_onlyVerifier() public {
        uint256 id = _createDefault();
        address[4] memory others = [buyer, admin, platform, creator];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector, others[i], VERIFIER_ROLE
                )
            );
            escrow.markPassed(id, 0, bytes32(0));
        }
    }

    function test_resolveDispute_onlyAdmin() public {
        uint256 id = _createDefault();
        _dispute(id, 0);
        address[4] memory others = [buyer, verifier, platform, guardian];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(
                abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, others[i], bytes32(0))
            );
            escrow.resolveDispute(id, 0, true);
        }
    }

    function test_buyerOnlyActions() public {
        uint256 id = _createDefault();
        vm.warp(DEFAULT_DEADLINE + 1);
        address[3] memory others = [creator, stranger, admin];
        for (uint256 i; i < others.length; ++i) {
            vm.startPrank(others[i]);
            vm.expectRevert(SolversEscrow.NotBuyer.selector);
            escrow.openDispute(id, 0, bytes32(0));
            vm.expectRevert(SolversEscrow.NotBuyer.selector);
            escrow.cancelUndelivered(id, 0);
            vm.stopPrank();
        }
    }

    function test_escrowNotFound() public {
        _createDefault();
        uint256 missing = 2;
        bytes memory err = abi.encodeWithSelector(SolversEscrow.EscrowNotFound.selector, missing);
        vm.prank(verifier);
        vm.expectRevert(err);
        escrow.markPassed(missing, 0, bytes32(0));
        vm.prank(buyer);
        vm.expectRevert(err);
        escrow.releaseMilestone(missing, 0);
        vm.prank(buyer);
        vm.expectRevert(err);
        escrow.openDispute(missing, 0, bytes32(0));
        vm.prank(admin);
        vm.expectRevert(err);
        escrow.resolveDispute(missing, 0, true);
        vm.prank(buyer);
        vm.expectRevert(err);
        escrow.cancelUndelivered(missing, 0);
        vm.expectRevert(err);
        escrow.resolveStaleDispute(missing, 0);
        vm.expectRevert(err);
        escrow.statusOf(missing);
        vm.expectRevert(err);
        escrow.escrowOf(missing);
        vm.expectRevert(err);
        escrow.autoReleaseAt(missing);
        vm.expectRevert(abi.encodeWithSelector(SolversEscrow.EscrowNotFound.selector, 0));
        escrow.statusOf(0);
    }

    function test_invalidMilestoneIndex() public {
        uint256 id = _createDefault(); // 2 milestones
        uint8[3] memory bad = [2, 4, 255];
        for (uint256 k; k < bad.length; ++k) {
            uint8 i = bad[k];
            vm.prank(verifier);
            vm.expectRevert(SolversEscrow.InvalidMilestoneIndex.selector);
            escrow.markPassed(id, i, bytes32(0));
            vm.prank(buyer);
            vm.expectRevert(SolversEscrow.InvalidMilestoneIndex.selector);
            escrow.releaseMilestone(id, i);
            vm.prank(buyer);
            vm.expectRevert(SolversEscrow.InvalidMilestoneIndex.selector);
            escrow.openDispute(id, i, bytes32(0));
            vm.prank(admin);
            vm.expectRevert(SolversEscrow.InvalidMilestoneIndex.selector);
            escrow.resolveDispute(id, i, false);
            vm.prank(buyer);
            vm.expectRevert(SolversEscrow.InvalidMilestoneIndex.selector);
            escrow.cancelUndelivered(id, i);
            vm.expectRevert(SolversEscrow.InvalidMilestoneIndex.selector);
            escrow.resolveStaleDispute(id, i);
        }
    }

    // =====================================================================================================
    // pause matrix
    // =====================================================================================================

    function test_pausePayments_blocksReleaseAndResolve() public {
        uint256 id = _create(_amountsN(3, 2_000_000));
        _pass(id, 0);
        _dispute(id, 1);
        _pause(PAUSE_PAYMENTS);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Paused.selector, PAUSE_PAYMENTS));
        escrow.releaseMilestone(id, 0);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Paused.selector, PAUSE_PAYMENTS));
        escrow.releaseMilestone(id, 0);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Paused.selector, PAUSE_PAYMENTS));
        escrow.resolveDispute(id, 1, true);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Paused.selector, PAUSE_PAYMENTS));
        escrow.resolveDispute(id, 1, false);

        // unpause: both work again
        _pause(0);
        _releaseAs(stranger, id, 0);
        _resolve(id, 1, false);
        assertEq(uint8(_mstatus(id, 0)), uint8(MilestoneStatus.Approved));
        assertEq(uint8(_mstatus(id, 1)), uint8(MilestoneStatus.Approved));
    }

    function test_pauseEntriesAndTransfers_doNotBlockPayouts() public {
        uint256 id = _create(_amountsN(3, 2_000_000));
        _pass(id, 0);
        _dispute(id, 1);
        _dispute(id, 2);
        _pause(PAUSE_ENTRIES | PAUSE_TRANSFERS);
        vm.warp(block.timestamp + WINDOW);
        _releaseAs(stranger, id, 0);
        _resolve(id, 1, true);
        _resolve(id, 2, false);
        assertEq(uint8(escrow.statusOf(id)), uint8(EscrowStatus.Completed));
        assertEq(escrow.lockedBalance(), 0);
    }

    function test_pausePayments_doesNotBlockNonPayoutActionsOrBuyerExits() public {
        uint256 id = _create(_amountsN(4, 2_000_000));
        _pause(PAUSE_ENTRIES | PAUSE_PAYMENTS | PAUSE_TRANSFERS);
        uint256 b0 = _bal(buyer);

        _pass(id, 0); // markPassed
        _dispute(id, 0); // openDispute (passed, within the window)
        _dispute(id, 1); // openDispute (pending)
        vm.warp(DEFAULT_DEADLINE + 1);
        vm.prank(buyer);
        escrow.cancelUndelivered(id, 2); // buyer exit
        vm.prank(stranger);
        escrow.resolveStaleDispute(id, 1); // stale refund

        assertEq(uint8(_mstatus(id, 0)), uint8(MilestoneStatus.Disputed));
        assertEq(uint8(_mstatus(id, 1)), uint8(MilestoneStatus.Refunded));
        assertEq(uint8(_mstatus(id, 2)), uint8(MilestoneStatus.Refunded));
        assertEq(_bal(buyer) - b0, 4_000_000);
        _assertVault();
    }

    // =====================================================================================================
    // blocked recipients: deferred payouts
    // =====================================================================================================

    function test_blockedCreator_releaseDefersAndClaimPays() public {
        uint256 id = _create(_amounts1(5_000_000));
        uint64 pid = _blockReceivesUndoable(creator);
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);

        vm.expectEmit(address(escrow));
        emit SolversPayouts.PayoutDeferred(creator, 4_500_000, 4_500_000);
        vm.expectEmit(address(escrow));
        emit SolversEscrow.MilestonePaid(id, 0, creator, 5_000_000, 500_000, true);
        _releaseAs(buyer, id, 0);

        assertEq(_bal(creator), c0, "creator received nothing yet");
        assertEq(_bal(treasury) - t0, 500_000, "treasury still paid");
        assertEq(escrow.deferredOf(creator), 4_500_000);
        assertEq(escrow.totalDeferred(), 4_500_000);
        assertEq(escrow.lockedBalance(), 0);
        assertEq(_bal(address(escrow)), 4_500_000);
        _assertVault();
        assertEq(_bal(RECEIVE_POLICY_GUARD), 0, "never parked in the guard");

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(RecipientBlocked.selector, creator));
        escrow.claim();

        _allowSender(creator, pid, address(escrow));
        vm.expectEmit(address(escrow));
        emit SolversPayouts.PayoutClaimed(creator, 4_500_000);
        vm.prank(creator);
        escrow.claim();
        assertEq(_bal(creator) - c0, 4_500_000);
        assertEq(escrow.deferredOf(creator), 0);
        assertEq(escrow.totalDeferred(), 0);
        assertEq(_bal(address(escrow)), 0);

        vm.prank(creator);
        vm.expectRevert(NothingToClaim.selector);
        escrow.claim();
    }

    function test_blockedTreasury_feeDeferred() public {
        uint256 id = _create(_amounts1(5_000_000));
        _blockReceives(treasury);
        uint256 c0 = _bal(creator);
        _releaseAs(buyer, id, 0);
        assertEq(_bal(creator) - c0, 4_500_000);
        assertEq(escrow.deferredOf(treasury), 500_000);
        assertEq(escrow.totalDeferred(), 500_000);
        _assertVault();
    }

    function test_blockedBuyer_refundsDeferred() public {
        uint256 id = _create(_amountsN(3, 2_000_000));
        uint64 pid = _blockReceivesUndoable(buyer);
        uint256 b0 = _bal(buyer);

        _dispute(id, 0);
        vm.expectEmit(address(escrow));
        emit SolversEscrow.MilestoneRefunded(id, 0, buyer, 2_000_000, true);
        _resolve(id, 0, true);

        _dispute(id, 1);
        vm.warp(DEFAULT_DEADLINE + 1);
        vm.prank(stranger);
        escrow.resolveStaleDispute(id, 1);
        vm.prank(buyer);
        escrow.cancelUndelivered(id, 2);

        assertEq(_bal(buyer), b0);
        assertEq(escrow.deferredOf(buyer), 6_000_000);
        assertEq(escrow.totalDeferred(), 6_000_000);
        assertEq(escrow.lockedBalance(), 0);
        _assertVault();
        assertEq(uint8(escrow.statusOf(id)), uint8(EscrowStatus.Refunded));

        _allowSender(buyer, pid, address(escrow));
        vm.prank(buyer);
        escrow.claim();
        assertEq(_bal(buyer) - b0, 6_000_000);
        assertEq(_bal(address(escrow)), 0);
    }

    function test_blacklistedCreator_payoutDeferredUntilUnblacklisted() public {
        uint256 id = _create(_amounts1(5_000_000));
        uint64 pid = _blacklistUndoable(creator);
        uint256 c0 = _bal(creator);
        vm.expectEmit(address(escrow));
        emit SolversEscrow.MilestonePaid(id, 0, creator, 5_000_000, 500_000, true);
        _releaseAs(buyer, id, 0);
        assertEq(escrow.deferredOf(creator), 4_500_000);
        _assertVault();

        vm.prank(creator);
        vm.expectRevert(ITIP20.PolicyForbids.selector);
        escrow.claim();

        _unblacklist(pid, creator);
        vm.prank(creator);
        escrow.claim();
        assertEq(_bal(creator) - c0, 4_500_000);
        assertEq(escrow.totalDeferred(), 0);
    }

    function test_sweepStray_onlyExcess() public {
        uint256 id = _create(_amounts1(5_000_000));
        _blockReceives(creator);
        _releaseAs(buyer, id, 0); // 4.5 deferred
        _createDefault(); // 7 locked
        token.mint(address(escrow), 123); // stray
        address sink = makeAddr("sink");
        vm.prank(admin);
        escrow.sweepStray(sink);
        assertEq(_bal(sink), 123);
        _assertVault();
        vm.prank(admin);
        vm.expectRevert(NothingToClaim.selector);
        escrow.sweepStray(sink);
    }

    // =====================================================================================================
    // views
    // =====================================================================================================

    function test_autoReleaseAt_isMaxOverPassedMilestones() public {
        uint256 id = _create(_amountsN(3, 2_000_000));
        assertEq(escrow.autoReleaseAt(id), 0);
        _pass(id, 1);
        uint256 a1 = block.timestamp + WINDOW;
        assertEq(escrow.autoReleaseAt(id), a1);
        vm.warp(block.timestamp + 100);
        _pass(id, 0);
        uint256 a0 = block.timestamp + WINDOW;
        assertEq(escrow.autoReleaseAt(id), a0, "latest passed wins");
        // disputing the latest passed milestone removes it from the max
        _dispute(id, 0);
        assertEq(escrow.autoReleaseAt(id), a1);
        // releasing the remaining passed milestone leaves none
        _releaseAs(buyer, id, 1);
        assertEq(escrow.autoReleaseAt(id), 0);
    }

    function test_autoReleaseAt_matchesStrangerReleaseBoundary() public {
        uint256 id = _createDefault();
        _pass(id, 0);
        uint256 at = escrow.autoReleaseAt(id);
        vm.warp(at - 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SolversEscrow.AutoReleaseNotReached.selector, at));
        escrow.releaseMilestone(id, 0);
        vm.warp(at);
        _releaseAs(stranger, id, 0);
    }

    function test_escrowOf_tracksMilestoneFields() public {
        uint256 id = _create(_amountsN(3, 2_000_000));
        uint256 tPass = block.timestamp + 10;
        vm.warp(tPass);
        _pass(id, 0);
        uint256 tDispute = block.timestamp + 20;
        vm.warp(tDispute);
        _dispute(id, 0);
        _dispute(id, 1);

        SolversEscrow.Milestone[] memory ms = _ms(id);
        assertEq(uint8(ms[0].status), uint8(MilestoneStatus.Disputed));
        assertEq(ms[0].passedAt, tPass, "passedAt kept by openDispute");
        assertEq(ms[0].disputedAt, tDispute);
        assertEq(ms[0].deliverableHash, keccak256(abi.encode("deliverable", id, uint8(0))));
        assertEq(ms[0].disputeReasonHash, keccak256(abi.encode("reason", id, uint8(0))));
        assertEq(uint8(ms[1].status), uint8(MilestoneStatus.Disputed));
        assertEq(ms[1].passedAt, 0);
        assertEq(ms[1].disputedAt, tDispute);
        assertEq(ms[1].deliverableHash, bytes32(0));
        assertEq(uint8(ms[2].status), uint8(MilestoneStatus.Pending));
        assertEq(ms[2].criteriaHash, keccak256(abi.encode("criteria", uint256(2))));
    }

    function test_events_milestoneUpdatedCarriesActorAndHash() public {
        uint256 id = _createDefault();
        bytes32 h = keccak256("deliv");
        vm.expectEmit(address(escrow));
        emit SolversEscrow.MilestoneUpdated(id, 0, MilestoneStatus.Passed, verifier, h);
        vm.prank(verifier);
        escrow.markPassed(id, 0, h);

        bytes32 reason = keccak256("why");
        vm.expectEmit(address(escrow));
        emit SolversEscrow.MilestoneUpdated(id, 1, MilestoneStatus.Disputed, buyer, reason);
        vm.prank(buyer);
        escrow.openDispute(id, 1, reason);

        vm.expectEmit(address(escrow));
        emit SolversEscrow.MilestoneUpdated(id, 1, MilestoneStatus.Refunded, admin, bytes32(0));
        vm.expectEmit(address(escrow));
        emit SolversEscrow.DisputeResolved(id, 1, true, admin);
        _resolve(id, 1, true);
    }

    function test_staleDispute_emitsDisputeResolvedByCaller() public {
        uint256 id = _createDefault();
        _dispute(id, 0);
        vm.warp(DEFAULT_DEADLINE + 1);
        vm.expectEmit(address(escrow));
        emit SolversEscrow.MilestoneUpdated(id, 0, MilestoneStatus.Refunded, stranger, bytes32(0));
        vm.expectEmit(address(escrow));
        emit SolversEscrow.DisputeResolved(id, 0, true, stranger);
        vm.prank(stranger);
        escrow.resolveStaleDispute(id, 0);
    }

    // =====================================================================================================
    // derived status (refresh_status) + EscrowStatusChanged emitted once per change
    // =====================================================================================================

    function _countStatusLogs(Vm.Log[] memory logs, uint256 id) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(escrow) && logs[i].topics[0] == SolversEscrow.EscrowStatusChanged.selector
                    && logs[i].topics[1] == bytes32(id)
            ) ++n;
        }
    }

    function _lastStatusLog(Vm.Log[] memory logs, uint256 id) internal view returns (EscrowStatus s) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(escrow) && logs[i].topics[0] == SolversEscrow.EscrowStatusChanged.selector
                    && logs[i].topics[1] == bytes32(id)
            ) s = abi.decode(logs[i].data, (EscrowStatus));
        }
    }

    /// @dev Runs the pending recorded logs through the counter and checks the derived status.
    function _expectStatus(uint256 id, EscrowStatus expected, bool changed) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(uint8(escrow.statusOf(id)), uint8(expected), "statusOf");
        assertEq(_countStatusLogs(logs, id), changed ? 1 : 0, "EscrowStatusChanged count");
        if (changed) assertEq(uint8(_lastStatusLog(logs, id)), uint8(expected), "EscrowStatusChanged value");
        vm.recordLogs();
    }

    function test_status_activeDisputedActiveCompleted() public {
        uint256 id = _create(_amountsN(3, 2_000_000));
        vm.recordLogs();
        _pass(id, 0);
        _expectStatus(id, EscrowStatus.Active, false);
        _dispute(id, 1);
        _expectStatus(id, EscrowStatus.Disputed, true);
        _dispute(id, 2);
        _expectStatus(id, EscrowStatus.Disputed, false);
        _resolve(id, 1, false);
        _expectStatus(id, EscrowStatus.Disputed, false); // m2 still disputed
        _resolve(id, 2, true);
        _expectStatus(id, EscrowStatus.Active, true); // m0 Passed
        _releaseAs(buyer, id, 0);
        _expectStatus(id, EscrowStatus.Completed, true);
    }

    function test_status_disputedToCompletedDirectly() public {
        uint256 id = _createDefault();
        vm.recordLogs();
        _releaseAs(buyer, id, 0);
        _expectStatus(id, EscrowStatus.Active, false);
        _dispute(id, 1);
        _expectStatus(id, EscrowStatus.Disputed, true);
        _resolve(id, 1, true); // Approved + Refunded -> Completed
        _expectStatus(id, EscrowStatus.Completed, true);
    }

    function test_status_disputedToRefunded() public {
        uint256 id = _create(_amounts1(5_000_000));
        vm.recordLogs();
        _dispute(id, 0);
        _expectStatus(id, EscrowStatus.Disputed, true);
        _resolve(id, 0, true);
        _expectStatus(id, EscrowStatus.Refunded, true);
    }

    function test_status_activeToRefundedViaCancel() public {
        uint256 id = _createDefault();
        vm.warp(DEFAULT_DEADLINE + 1);
        vm.recordLogs();
        vm.prank(buyer);
        escrow.cancelUndelivered(id, 0);
        _expectStatus(id, EscrowStatus.Active, false);
        vm.prank(buyer);
        escrow.cancelUndelivered(id, 1);
        _expectStatus(id, EscrowStatus.Refunded, true);
    }

    function test_status_staleRefundToRefunded() public {
        uint256 id = _create(_amounts1(5_000_000));
        _dispute(id, 0);
        vm.warp(DEFAULT_DEADLINE + 1);
        vm.recordLogs();
        escrow.resolveStaleDispute(id, 0);
        _expectStatus(id, EscrowStatus.Refunded, true);
    }

    function test_status_disputeAfterPassStillCounts() public {
        uint256 id = _create(_amounts1(5_000_000));
        _pass(id, 0);
        vm.recordLogs();
        _dispute(id, 0);
        _expectStatus(id, EscrowStatus.Disputed, true);
        _resolve(id, 0, false);
        _expectStatus(id, EscrowStatus.Completed, true);
    }

    function test_status_allRefundedOverridesCompleted() public {
        // every milestone Refunded -> Refunded (not Completed), even though "all done" also holds
        uint256 id = _createDefault();
        _dispute(id, 0);
        _dispute(id, 1);
        vm.recordLogs();
        _resolve(id, 0, true);
        _expectStatus(id, EscrowStatus.Disputed, false);
        _resolve(id, 1, true);
        _expectStatus(id, EscrowStatus.Refunded, true);
    }
}
