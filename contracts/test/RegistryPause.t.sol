// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {RegistryHelpers} from "./Registry.t.sol";
import {SolversLicense} from "../src/SolversLicense.sol";
import {SolversEscrow} from "../src/SolversEscrow.sol";
import {
    AgentStatus,
    MilestoneStatus,
    PAUSE_ENTRIES,
    PAUSE_PAYMENTS,
    PAUSE_TRANSFERS,
    PAUSE_MASK,
    Paused
} from "../src/SolversTypes.sol";

/// @notice Effect of each pause bit across the six contracts (plan §4.8 pause matrix).
/// ENTRIES → register / purchase / buyCredits / createEscrow; PAYMENTS → releaseMilestone / resolveDispute;
/// TRANSFERS → secondary license transfers. Never paused: markPassed, openDispute, cancelUndelivered,
/// resolveStaleDispute, staking, reviews, claim, admin ops.
contract RegistryPauseTest is RegistryHelpers {
    uint256 internal tokenId;
    uint256 internal escrowId;

    function setUp() public override {
        super.setUp();
        _registerActive(creator, AGENT);
        tokenId = _buy(buyer, AGENT);
        _buyCredits(buyer2, AGENT, 5);
        escrowId = _createEscrow(buyer, AGENT, 5);
    }

    function _paused(uint8 flag) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Paused.selector, flag);
    }

    // =====================================================================================================
    // ENTRIES
    // =====================================================================================================

    function test_entries_blocksEveryEntryPoint() public {
        _setPause(PAUSE_ENTRIES);
        bytes memory err = _paused(PAUSE_ENTRIES);
        uint256 creditsTotal = 5 * uint256(PRICE_PER_USE);
        uint256 escrowTotal = 3 * uint256(MS_AMOUNT);

        vm.startPrank(creator2);
        usd.approve(address(staking), MIN_STAKE);
        vm.expectRevert(err);
        registry.registerAgent(_registration(AGENT2, PRICE, PRICE_PER_USE, 0));
        vm.stopPrank();

        vm.startPrank(stranger);
        usd.approve(address(license), PRICE);
        usd.approve(address(credits), creditsTotal);
        usd.approve(address(escrow), escrowTotal);
        vm.expectRevert(err);
        license.purchaseLicense(AGENT, PRICE, _pid());
        vm.expectRevert(err);
        license.purchaseLicenseWithPermit(AGENT, PRICE, _pid(), block.timestamp, 27, bytes32(0), bytes32(0));
        vm.expectRevert(err);
        credits.buyCredits(AGENT, 5, creditsTotal, _pid());
        vm.expectRevert(err);
        credits.buyCreditsWithPermit(AGENT, 5, creditsTotal, _pid(), block.timestamp, 27, bytes32(0), bytes32(0));
        vm.expectRevert(err);
        escrow.createEscrow(AGENT, _ms(3, MS_AMOUNT), WINDOW, 0, _pid());
        vm.expectRevert(err);
        escrow.createEscrowWithPermit(
            AGENT, _ms(3, MS_AMOUNT), WINDOW, 0, _pid(), block.timestamp, 27, bytes32(0), bytes32(0)
        );
        vm.stopPrank();

        vm.startPrank(platform);
        usd.approve(address(license), PRICE);
        usd.approve(address(credits), creditsTotal);
        usd.approve(address(escrow), escrowTotal);
        vm.expectRevert(err);
        license.purchaseLicenseFor(stranger, AGENT, PRICE, _pid());
        vm.expectRevert(err);
        credits.buyCreditsFor(stranger, AGENT, 5, creditsTotal, _pid());
        vm.expectRevert(err);
        escrow.createEscrowFor(stranger, AGENT, _ms(3, MS_AMOUNT), WINDOW, 0, _pid());
        vm.stopPrank();

        assertEq(registry.agentCount(), 1);
        assertEq(license.totalMinted(), 1);
        assertEq(escrow.escrowCount(), 1);
    }

    function test_entries_doesNotBlockTheRest() public {
        _setPause(PAUSE_ENTRIES);
        // transfers, reviews, escrow lifecycle, staking, usage, admin ops
        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        license.transferWithRoyalty(stranger, tokenId, PRICE);
        vm.stopPrank();
        vm.prank(stranger);
        reviews.submitReview(AGENT, uint64(tokenId), 4, keccak256("ok"));
        vm.prank(buyer2);
        reviews.submitReviewWithCredits(AGENT, 5, keccak256("ok"));

        vm.prank(verifier);
        escrow.markPassed(escrowId, 0, keccak256("d"));
        vm.prank(buyer);
        escrow.releaseMilestone(escrowId, 0);
        vm.prank(buyer);
        escrow.openDispute(escrowId, 1, keccak256("r"));
        vm.prank(admin);
        escrow.resolveDispute(escrowId, 1, true);

        vm.prank(platform);
        credits.consumeCredits(AGENT, buyer2, 1);
        vm.startPrank(creator);
        usd.approve(address(staking), 1);
        staking.topUpStake(AGENT, 1);
        vm.stopPrank();
        vm.prank(admin);
        registry.suspendAgent(AGENT);
        vm.prank(admin);
        registry.approveAgent(AGENT);
        vm.prank(creator);
        registry.updatePricing(AGENT, PRICE, PRICE_PER_USE);
    }

    // =====================================================================================================
    // PAYMENTS
    // =====================================================================================================

    function test_payments_blocksReleaseAndResolve() public {
        vm.prank(verifier);
        escrow.markPassed(escrowId, 0, keccak256("d"));
        vm.prank(buyer);
        escrow.openDispute(escrowId, 1, keccak256("r"));

        _setPause(PAUSE_PAYMENTS);
        bytes memory err = _paused(PAUSE_PAYMENTS);
        // buyer release (Pending and Passed)
        vm.prank(buyer);
        vm.expectRevert(err);
        escrow.releaseMilestone(escrowId, 0);
        vm.prank(buyer);
        vm.expectRevert(err);
        escrow.releaseMilestone(escrowId, 2);
        // permissionless auto-release after the window
        vm.warp(block.timestamp + WINDOW);
        vm.prank(stranger);
        vm.expectRevert(err);
        escrow.releaseMilestone(escrowId, 0);
        // admin judgment, both ways
        vm.prank(admin);
        vm.expectRevert(err);
        escrow.resolveDispute(escrowId, 1, true);
        vm.prank(admin);
        vm.expectRevert(err);
        escrow.resolveDispute(escrowId, 1, false);

        // unpausing restores both
        _setPause(0);
        vm.prank(stranger);
        escrow.releaseMilestone(escrowId, 0);
        vm.prank(admin);
        escrow.resolveDispute(escrowId, 1, false);
    }

    function test_payments_doesNotBlockBuyerExitsVerifierReviewsStaking() public {
        _setPause(PAUSE_PAYMENTS);
        uint256 lockedBefore = escrow.lockedBalance();

        // markPassed (verifier) and openDispute (buyer, Pending and Passed-in-window)
        vm.prank(verifier);
        escrow.markPassed(escrowId, 0, keccak256("d"));
        vm.prank(buyer);
        escrow.openDispute(escrowId, 0, keccak256("r0"));
        vm.prank(buyer);
        escrow.openDispute(escrowId, 1, keccak256("r1"));

        // cancelUndelivered and resolveStaleDispute after the deadline / SLA
        vm.warp(block.timestamp + 15 days);
        uint256 buyerBefore = _bal(buyer);
        vm.prank(buyer);
        escrow.cancelUndelivered(escrowId, 2);
        vm.prank(stranger);
        escrow.resolveStaleDispute(escrowId, 1);
        assertEq(_bal(buyer) - buyerBefore, 2 * uint256(MS_AMOUNT));
        assertEq(lockedBefore - escrow.lockedBalance(), 2 * uint256(MS_AMOUNT));
        (,,,,,,, SolversEscrow.Milestone[] memory ms) = escrow.escrowOf(escrowId);
        assertEq(uint8(ms[1].status), uint8(MilestoneStatus.Refunded));
        assertEq(uint8(ms[2].status), uint8(MilestoneStatus.Refunded));

        // reviews
        vm.prank(buyer);
        reviews.submitReview(AGENT, uint64(tokenId), 5, keccak256("ok"));
        // staking
        vm.startPrank(creator);
        usd.approve(address(staking), 1);
        staking.topUpStake(AGENT, 1);
        staking.requestStakeExit(AGENT);
        vm.stopPrank();
        assertEq(uint8(registry.statusOf(AGENT)), uint8(AgentStatus.Retired));

        // PAYMENTS does not block entries or transfers either
        _registerActive(creator2, AGENT2);
        _buy(stranger, AGENT2);
    }

    // =====================================================================================================
    // TRANSFERS
    // =====================================================================================================

    function test_transfers_blocksSecondaryTransfersOnly() public {
        _setPause(PAUSE_TRANSFERS);
        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        vm.expectRevert(SolversLicense.TransfersPaused.selector);
        license.transferWithRoyalty(stranger, tokenId, PRICE);
        vm.expectRevert(SolversLicense.TransfersPaused.selector);
        license.transferFrom(buyer, stranger, tokenId);
        vm.expectRevert(SolversLicense.TransfersPaused.selector);
        license.safeTransferFrom(buyer, stranger, tokenId);
        vm.expectRevert(SolversLicense.TransfersPaused.selector);
        license.safeTransferFrom(buyer, stranger, tokenId, "");
        // an approved operator is blocked too
        license.approve(stranger, tokenId);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(SolversLicense.TransfersPaused.selector);
        license.transferFrom(buyer, stranger, tokenId);
        assertEq(license.ownerOf(tokenId), buyer);

        // mint (purchase) and burn still work
        uint256 t2 = _buy(buyer2, AGENT);
        assertEq(license.ownerOf(t2), buyer2);
        vm.prank(buyer2);
        license.burn(t2);
        assertEq(license.balanceOf(buyer2), 0);

        // self-transfer moves nothing and is not a secondary transfer
        vm.prank(buyer);
        license.transferFrom(buyer, buyer, tokenId);
        assertEq(license.ownerOf(tokenId), buyer);

        _setPause(0);
        vm.prank(buyer);
        license.transferWithRoyalty(stranger, tokenId, PRICE);
        assertEq(license.ownerOf(tokenId), stranger);
    }

    // =====================================================================================================
    // all bits: claim, reviews, staking, verifier and admin ops still work
    // =====================================================================================================

    function test_allBits_claimReviewsStakingStillWork() public {
        // create a deferred credit for the creator with a token-level blacklist, then lift it
        uint64 pid = _blacklistPid(creator);
        uint256 t2 = _buy(buyer2, AGENT);
        uint256 owed = license.deferredOf(creator);
        assertEq(owed, PRICE - uint256(PRICE) * FEE_BPS / 10_000);
        _unblacklist(pid, creator);

        _setPause(PAUSE_MASK);
        assertEq(registry.pauseFlags(), 7);

        uint256 before = _bal(creator);
        vm.prank(creator);
        license.claim();
        assertEq(_bal(creator) - before, owed);
        assertEq(license.totalDeferred(), 0);

        vm.prank(buyer2);
        reviews.submitReview(AGENT, uint64(t2), 3, keccak256("meh"));
        vm.prank(verifier);
        escrow.markPassed(escrowId, 0, keccak256("d"));
        vm.prank(buyer);
        escrow.openDispute(escrowId, 1, keccak256("r"));
        vm.prank(verifier);
        registry.setEval(AGENT, VERSION_HASH, 9000, bytes32(0));
        vm.prank(platform);
        credits.recordUsageBatch(AGENT, 3, keccak256("root"));

        vm.prank(admin);
        staking.proposeSlash(AGENT, 1, keccak256("x"));
        vm.prank(creator);
        staking.contestSlash(AGENT, keccak256("y"));
        vm.prank(admin);
        staking.cancelSlash(AGENT);
        vm.prank(creator);
        staking.requestStakeExit(AGENT);
        vm.warp(block.timestamp + staking.STAKE_EXIT_DELAY());
        uint256 cb = _bal(creator);
        vm.prank(creator);
        staking.withdrawStake(AGENT);
        assertEq(_bal(creator) - cb, MIN_STAKE);
    }

    function test_guardianPauseHasTheSameEffect() public {
        vm.prank(guardian);
        registry.setPause(PAUSE_ENTRIES);
        vm.startPrank(buyer2);
        usd.approve(address(license), PRICE);
        vm.expectRevert(_paused(PAUSE_ENTRIES));
        license.purchaseLicense(AGENT, PRICE, _pid());
        vm.stopPrank();
        vm.prank(guardian);
        registry.setPause(PAUSE_ENTRIES | PAUSE_PAYMENTS);
        vm.prank(buyer);
        vm.expectRevert(_paused(PAUSE_PAYMENTS));
        escrow.releaseMilestone(escrowId, 0);
    }
}
